// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RemessoExecutorV4} from "../src/RemessoExecutorV4.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// What V4 adds, and — more importantly — what it must not have changed.
///
/// The three new powers (a payout asset per schedule, an early send, a
/// commission) are all owner-configurable, and every one of them is pinned at
/// consent. So most of this file is the same shape of test twice: the owner
/// changes a setting, and the schedule somebody already authorised does not
/// move.
contract RemessoExecutorV4Test is Test {
    RemessoExecutorV4 exec;
    MockERC20 usdt;
    MockERC20 usdc;
    MockERC20 cngn;
    MockERC20 ckes;
    MockRouter router;

    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");
    address executor = makeAddr("executor");
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    uint96 constant FLOOR = 1_340_000_000;
    uint16 constant FEE_BPS = 25; // 0.25%
    uint64 EXP;

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cngn = new MockERC20("cNGN", "cNGN", 6);
        ckes = new MockERC20("Celo Kenyan Shilling", "cKES", 18);
        router = new MockRouter(1_368_000_000);
        exec = new RemessoExecutorV4(
            address(usdt), address(cngn), address(router), executor, 100, treasury, FEE_BPS
        );
        EXP = uint64(block.timestamp) + 30 days;

        exec.setDirectToken(address(usdt), true);
        exec.setDirectToken(address(usdc), true);

        usdt.mint(sender, 10_000e6);
        usdc.mint(sender, 10_000e6);
        vm.startPrank(sender);
        usdt.approve(address(exec), type(uint256).max);
        usdc.approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    function _direct(uint128 amount, uint16 triggers, address trigger) internal returns (uint256 id) {
        vm.prank(sender);
        id = exec.createSchedule(
            recipient,
            amount,
            7 days,
            0,
            0,
            EXP,
            0,
            RemessoExecutorV4.PayoutType.Direct,
            address(usdt),
            address(0),
            trigger,
            triggers
        );
    }

    function _swap(address payoutToken, uint128 amount) internal returns (uint256 id) {
        vm.prank(sender);
        id = exec.createSchedule(
            recipient,
            amount,
            7 days,
            FLOOR,
            0,
            EXP,
            0,
            RemessoExecutorV4.PayoutType.Wallet,
            address(usdt),
            payoutToken,
            address(0),
            0
        );
    }

    // ---------------------------------------------------------------- fee

    function test_CommissionGoesToTreasuryAndTheRestToTheRecipient() public {
        uint256 id = _direct(200e6, 0, address(0));
        vm.prank(executor);
        exec.executeRun(id, 0);

        // 0.25% of 200 USDT.
        assertEq(usdt.balanceOf(treasury), 0.5e6, "treasury takes the commission");
        assertEq(usdt.balanceOf(recipient), 199.5e6, "recipient receives the rest");
        assertEq(usdt.balanceOf(sender), 10_000e6 - 200e6, "sender pays exactly what they signed");
    }

    /// The reason the rate lives in the struct.
    function test_RaisingTheFeeCannotTouchALiveSchedule() public {
        uint256 id = _direct(200e6, 0, address(0));
        exec.setFeeBps(exec.MAX_FEE_BPS());

        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdt.balanceOf(treasury), 0.5e6, "still the rate consented to");
        assertEq(exec.getSchedule(id).feeBps, FEE_BPS);
    }

    function test_FeeCannotExceedTheCapAnywhere() public {
        uint16 max = exec.MAX_FEE_BPS();
        vm.expectRevert(abi.encodeWithSelector(RemessoExecutorV4.FeeTooHigh.selector, max + 1, max));
        exec.setFeeBps(max + 1);

        vm.expectRevert(abi.encodeWithSelector(RemessoExecutorV4.FeeTooHigh.selector, 10_000, max));
        new RemessoExecutorV4(address(usdt), address(cngn), address(router), executor, 100, treasury, 10_000);
    }

    function test_ZeroFeeMovesTheWholeAmount() public {
        exec.setFeeBps(0);
        uint256 id = _direct(200e6, 0, address(0));
        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdt.balanceOf(treasury), 0);
        assertEq(usdt.balanceOf(recipient), 200e6);
    }

    /// The floor is a rate on what is actually converted. Applied to the gross
    /// amount it would silently demand more output than the trade can produce
    /// and fail runs that met the sender's rate exactly.
    function test_FloorIsMeasuredAgainstTheConvertedAmount() public {
        uint256 id = _swap(address(cngn), 100e6);
        (,,, uint256 floor,) = exec.runnability(id);

        uint256 net = 100e6 - (100e6 * FEE_BPS) / 10_000;
        assertEq(floor, (net * FLOOR) / 1e6, "floor follows the net amount");

        // A quote at exactly the floor must go through.
        vm.prank(executor);
        exec.executeRun(id, floor);
        assertGe(cngn.balanceOf(recipient), floor);
        assertEq(usdt.balanceOf(treasury), 0.25e6);
    }

    // ------------------------------------------------------- payout token

    function test_ASchedulePaysOutInTheAssetItNamed() public {
        exec.setSwapToken(address(ckes), true);
        uint256 id = _swap(address(ckes), 100e6);
        (,,, uint256 floor,) = exec.runnability(id);

        vm.prank(executor);
        exec.executeRun(id, floor);

        assertGt(ckes.balanceOf(recipient), 0, "paid in the corridor's asset");
        assertEq(cngn.balanceOf(recipient), 0, "not in the default one");
    }

    function test_PayoutAssetMustBeAllowedAndDifferent() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV4.TokenNotAllowed.selector);
        exec.createSchedule(
            recipient, 100e6, 7 days, FLOOR, 0, EXP, 0,
            RemessoExecutorV4.PayoutType.Wallet, address(usdt), address(ckes), address(0), 0
        );

        // Allowed or not, converting an asset into itself is not a payout.
        exec.setSwapToken(address(usdt), true);
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV4.SameToken.selector);
        exec.createSchedule(
            recipient, 100e6, 7 days, FLOOR, 0, EXP, 0,
            RemessoExecutorV4.PayoutType.Wallet, address(usdt), address(usdt), address(0), 0
        );
    }

    function test_RemovingAPayoutAssetLeavesLiveSchedulesAlone() public {
        exec.setSwapToken(address(ckes), true);
        uint256 id = _swap(address(ckes), 100e6);
        (,,, uint256 floor,) = exec.runnability(id);
        exec.setSwapToken(address(ckes), false);

        vm.prank(executor);
        exec.executeRun(id, floor);
        assertGt(ckes.balanceOf(recipient), 0, "authorised before the change, honoured after it");
    }

    // ------------------------------------------------------------ runNow

    function test_SenderCanSendEarlyAndTheCadenceRestarts() public {
        uint256 id = _direct(50e6, 3, address(0));

        vm.prank(executor);
        exec.executeRun(id, 0); // run 1, on cadence
        vm.warp(block.timestamp + MIN_GAP());

        vm.prank(sender);
        exec.runNow(id, 0); // run 2, days early

        RemessoExecutorV4.Schedule memory s = exec.getSchedule(id);
        assertEq(s.runsExecuted, 2, "an early send is a run, not an extra");
        assertEq(s.triggersLeft, 2, "one early send spent");
        assertEq(s.nextRunAt, uint64(block.timestamp) + 7 days, "next one is a full interval away");
        assertEq(usdt.balanceOf(recipient), 2 * 49.875e6, "same amount, same destination");
    }

    function test_ANominatedAgentCanTriggerAndAStrangerCannot() public {
        uint256 id = _direct(50e6, 2, agent);

        vm.prank(stranger);
        vm.expectRevert(RemessoExecutorV4.NotTrigger.selector);
        exec.runNow(id, 0);

        vm.prank(agent);
        exec.runNow(id, 0);
        assertEq(usdt.balanceOf(recipient), 49.875e6, "the agent can only pay the recipient");
    }

    function test_TriggeringIsBoundedByWhatTheSenderAuthorised() public {
        uint256 id = _direct(10e6, 1, agent);

        vm.prank(agent);
        exec.runNow(id, 0);

        vm.warp(block.timestamp + MIN_GAP());
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV4.NoTriggersLeft.selector);
        exec.runNow(id, 0);
    }

    function test_TriggersCannotBeLoopedInsideAMinute() public {
        uint256 id = _direct(10e6, 5, agent);

        vm.prank(agent);
        exec.runNow(id, 0);

        // Computed before the prank: a call to read MIN_TRIGGER_GAP would
        // itself consume it, and the second runNow would arrive from the test
        // contract rather than the agent.
        uint64 earliest = uint64(block.timestamp) + MIN_GAP();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RemessoExecutorV4.TriggeredTooSoon.selector, earliest));
        exec.runNow(id, 0);
    }

    function test_SenderCanWithdrawAnAgentsPermission() public {
        uint256 id = _direct(10e6, 5, agent);

        vm.prank(sender);
        exec.setTrigger(id, address(0), 0);

        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV4.NotTrigger.selector);
        exec.runNow(id, 0);
    }

    /// An early send is still bound by every limit the sender signed.
    function test_TriggerObeysTheEnvelope() public {
        // Run cap
        vm.prank(sender);
        uint256 capped = exec.createSchedule(
            recipient, 10e6, 7 days, 0, 1, EXP, 0,
            RemessoExecutorV4.PayoutType.Direct, address(usdt), address(0), agent, 5
        );
        vm.prank(agent);
        exec.runNow(capped, 0);
        vm.warp(block.timestamp + MIN_GAP());
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV4.ScheduleInactive.selector);
        exec.runNow(capped, 0);

        // Expiry
        uint256 id = _direct(10e6, 5, agent);
        vm.warp(EXP + 1);
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV4.ScheduleExpired.selector);
        exec.runNow(id, 0);

        // The sender's own pause
        vm.warp(EXP - 1 days);
        uint256 paused = _direct(10e6, 5, agent);
        vm.prank(sender);
        exec.setScheduleActive(paused, false);
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV4.ScheduleInactive.selector);
        exec.runNow(paused, 0);
    }

    function test_GlobalPauseStopsTriggersToo() public {
        uint256 id = _direct(10e6, 5, agent);
        exec.pause();
        vm.prank(agent);
        vm.expectRevert();
        exec.runNow(id, 0);
    }

    function test_TriggerabilityMatchesWhatRunNowDoes() public {
        uint256 id = _direct(10e6, 1, agent);

        (bool can, uint16 left,) = exec.triggerability(id, agent);
        assertTrue(can, "agent may trigger");
        assertEq(left, 1);

        (can,,) = exec.triggerability(id, stranger);
        assertFalse(can, "a stranger may not");

        vm.prank(agent);
        exec.runNow(id, 0);

        (can, left,) = exec.triggerability(id, agent);
        assertFalse(can, "nothing left to spend");
        assertEq(left, 0);
    }

    function test_WithoutTriggersASchedulesBehavesExactlyAsV3() public {
        uint256 id = _direct(10e6, 0, address(0));

        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV4.NoTriggersLeft.selector);
        exec.runNow(id, 0);

        // And the executor still cannot run it before it is due.
        vm.prank(executor);
        exec.executeRun(id, 0);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                RemessoExecutorV4.NotDue.selector, uint64(block.timestamp) + 7 days
            )
        );
        exec.executeRun(id, 0);
    }

    function MIN_GAP() internal view returns (uint64) {
        return exec.MIN_TRIGGER_GAP();
    }
}
