// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RemessoExecutor} from "../src/RemessoExecutor.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract RemessoExecutorTest is Test {
    RemessoExecutor internal exec;
    MockERC20 internal usdt;
    MockERC20 internal cngn;
    MockRouter internal router;

    address internal owner = address(this);
    address internal executor = makeAddr("executor");
    address internal sender = makeAddr("sender");
    address internal recipient = makeAddr("recipient");
    address internal attacker = makeAddr("attacker");

    // Market on Celo at time of writing: ~1368 cNGN per USDT (both 6dp).
    uint256 internal constant MARKET_RATE_E6 = 1368 * 1e6;
    uint96 internal constant FLOOR_RATE_E6 = 1340 * 1e6; // ~2% below market
    uint128 internal constant AMOUNT = 200 * 1e6; // $200 per run
    uint64 internal constant INTERVAL = 30 days;

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 6);
        cngn = new MockERC20("cNGN", "cNGN", 6);
        router = new MockRouter(MARKET_RATE_E6);
        exec = new RemessoExecutor(address(usdt), address(cngn), address(router), executor, 100);

        usdt.mint(sender, 10_000 * 1e6);
        vm.prank(sender);
        usdt.approve(address(exec), type(uint256).max);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(sender);
        id = exec.createSchedule(recipient, AMOUNT, INTERVAL, FLOOR_RATE_E6, 0, 0, 0, RemessoExecutor.PayoutType.Wallet);
    }

    function _floor() internal pure returns (uint256) {
        return (uint256(AMOUNT) * uint256(FLOOR_RATE_E6)) / 1e6;
    }

    // --- happy path -------------------------------------------------------

    function test_ExecuteRun_DeliversToRecipient() public {
        uint256 id = _create();
        uint256 expected = (uint256(AMOUNT) * MARKET_RATE_E6) / 1e6;

        vm.prank(executor);
        uint256 out = exec.executeRun(id, _floor());

        assertEq(out, expected, "amountOut");
        assertEq(cngn.balanceOf(recipient), expected, "recipient credited");
        assertEq(usdt.balanceOf(sender), 10_000 * 1e6 - AMOUNT, "sender debited exactly once");
        assertEq(usdt.balanceOf(address(exec)), 0, "contract custodies nothing");
        assertEq(cngn.balanceOf(address(exec)), 0, "contract custodies nothing");
    }

    function test_ExecuteRun_AdvancesCadence() public {
        uint256 id = _create();
        vm.prank(executor);
        exec.executeRun(id, _floor());

        RemessoExecutor.Schedule memory s = exec.getSchedule(id);
        assertEq(s.runsExecuted, 1);
        assertEq(s.nextRunAt, uint64(block.timestamp) + INTERVAL);
    }

    // --- the envelope -----------------------------------------------------

    function test_RevertWhen_NotDue() public {
        uint256 id = _create();
        vm.prank(executor);
        exec.executeRun(id, _floor());

        vm.prank(executor);
        vm.expectRevert();
        exec.executeRun(id, _floor());
    }

    function test_NoCatchUpBurstAfterDowntime() public {
        uint256 id = _create();
        vm.prank(executor);
        exec.executeRun(id, _floor());

        // Backend was down for a year. It must not fire twelve runs at once.
        skip(365 days);
        vm.prank(executor);
        exec.executeRun(id, _floor());

        vm.prank(executor);
        vm.expectRevert();
        exec.executeRun(id, _floor());

        assertEq(exec.getSchedule(id).runsExecuted, 2);
    }

    function test_RevertWhen_CallerIsNotExecutor() public {
        uint256 id = _create();
        vm.prank(attacker);
        vm.expectRevert(RemessoExecutor.NotExecutor.selector);
        exec.executeRun(id, _floor());
    }

    function test_RevertWhen_SlippageBoundBelowSendersFloor() public {
        uint256 id = _create();
        // A compromised executor tries to hand the trade to a sandwich bot.
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(RemessoExecutor.SlippageBoundBelowFloor.selector, 0, _floor()));
        exec.executeRun(id, 0);
    }

    function test_RevertWhen_RouterDeliversBelowFloor() public {
        uint256 id = _create();
        router.setShortChange(true);
        vm.prank(executor);
        vm.expectRevert();
        exec.executeRun(id, _floor());
    }

    function test_RevertWhen_MarketFallsThroughFloor() public {
        uint256 id = _create();
        router.setRate(1200 * 1e6); // naira weakens past the sender's floor
        vm.prank(executor);
        vm.expectRevert(bytes("Too little received"));
        exec.executeRun(id, _floor());
    }

    function test_RunCapIsHonoured() public {
        vm.prank(sender);
        uint256 id =
            exec.createSchedule(recipient, AMOUNT, INTERVAL, FLOOR_RATE_E6, 2, 0, 0, RemessoExecutor.PayoutType.Wallet);

        vm.prank(executor);
        exec.executeRun(id, _floor());
        skip(INTERVAL);
        vm.prank(executor);
        exec.executeRun(id, _floor());

        assertFalse(exec.getSchedule(id).active, "auto-deactivates at cap");
        skip(INTERVAL);
        vm.prank(executor);
        vm.expectRevert(RemessoExecutor.ScheduleInactive.selector);
        exec.executeRun(id, _floor());
    }

    function test_ExpiryIsHonoured() public {
        uint64 expiry = uint64(block.timestamp + 60 days);
        vm.prank(sender);
        uint256 id = exec.createSchedule(
            recipient, AMOUNT, INTERVAL, FLOOR_RATE_E6, 0, expiry, 0, RemessoExecutor.PayoutType.Wallet
        );
        skip(61 days);
        vm.prank(executor);
        vm.expectRevert(RemessoExecutor.ScheduleExpired.selector);
        exec.executeRun(id, _floor());
    }

    // --- sender control ---------------------------------------------------

    function test_SenderCanPauseAndResume() public {
        uint256 id = _create();
        vm.prank(sender);
        exec.setScheduleActive(id, false);

        vm.prank(executor);
        vm.expectRevert(RemessoExecutor.ScheduleInactive.selector);
        exec.executeRun(id, _floor());

        vm.prank(sender);
        exec.setScheduleActive(id, true);
        vm.prank(executor);
        exec.executeRun(id, _floor());
        assertEq(exec.getSchedule(id).runsExecuted, 1);
    }

    function test_CancelledScheduleCannotBeRestarted() public {
        uint256 id = _create();
        vm.prank(sender);
        exec.cancelSchedule(id);

        // Cancellation is terminal: not even the sender can undo it.
        vm.prank(sender);
        vm.expectRevert(RemessoExecutor.ScheduleIsCancelled.selector);
        exec.setScheduleActive(id, true);

        vm.prank(executor);
        vm.expectRevert(RemessoExecutor.ScheduleIsCancelled.selector);
        exec.executeRun(id, _floor());
    }

    function test_RevertWhen_NonOwnerTouchesSchedule() public {
        uint256 id = _create();
        vm.prank(attacker);
        vm.expectRevert(RemessoExecutor.NotScheduleOwner.selector);
        exec.setScheduleActive(id, false);
    }

    function test_RevokingAllowanceStopsEverything() public {
        uint256 id = _create();
        vm.prank(sender);
        usdt.approve(address(exec), 0);

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(exec), 0, AMOUNT)
        );
        exec.executeRun(id, _floor());
    }

    /// @dev The property that matters most: the executor cannot redirect funds.
    function testFuzz_ExecutorCannotRedirectFunds(address rogue) public {
        vm.assume(rogue != recipient && rogue != address(0) && rogue != address(exec));
        uint256 id = _create();

        vm.prank(executor);
        exec.executeRun(id, _floor());

        assertEq(cngn.balanceOf(rogue), 0, "only the sender's destination is ever paid");
        assertGt(cngn.balanceOf(recipient), 0);
    }

    // --- admin ------------------------------------------------------------

    function test_GlobalPauseBlocksRuns() public {
        uint256 id = _create();
        exec.pause();
        vm.prank(executor);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        exec.executeRun(id, _floor());
    }

    function test_RunnabilityReportsFundingGap() public {
        uint256 id = _create();
        uint256 bal = usdt.balanceOf(sender);
        vm.prank(sender);
        usdt.transfer(attacker, bal); // drain funding wallet

        (bool due, bool funded, bool approved,,) = exec.runnability(id);
        assertTrue(due);
        assertFalse(funded, "backend can skip the run without burning gas");
        assertTrue(approved);
    }
}
