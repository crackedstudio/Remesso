// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RemessoExecutorV2} from "../src/RemessoExecutorV2.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// Regression tests for the 2026-09-14 security review. Every test here fails
/// against V1 — that is the point of each one existing.
contract RemessoExecutorV2Test is Test {
    RemessoExecutorV2 exec;
    MockERC20 usdt;
    MockERC20 cngn;
    MockRouter router;

    // Full-width addresses: V2 rejects any destination below 0x10000, which is
    // where the router's MSG_SENDER/ADDRESS_THIS sentinels and the precompiles
    // live. Short test addresses would trip that guard.
    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");
    address executor = makeAddr("executor");
    address owner = address(this);

    uint128 constant AMOUNT = 200e6;
    uint96 constant FLOOR_RATE_E6 = 1_340_000_000;
    uint64 constant EXPIRY = 30 days;

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 6);
        cngn = new MockERC20("cNGN", "cNGN", 6);
        router = new MockRouter(1_368_000_000);
        exec = new RemessoExecutorV2(address(usdt), address(cngn), address(router), executor, 100);
        usdt.mint(sender, 10_000e6);
        vm.prank(sender);
        usdt.approve(address(exec), type(uint256).max);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(sender);
        id = exec.createSchedule(
            recipient, AMOUNT, 7 days, FLOOR_RATE_E6, 0,
            uint64(block.timestamp) + EXPIRY, 0, RemessoExecutorV2.PayoutType.Wallet
        );
    }

    // --- the headline: cNGN sender-of-record -----------------------------
    /// V1 asked the router to pay the recipient directly, making the POOL the
    /// cNGN transferor. cNGN only burns when the transferor is whitelisted, so
    /// the naira leg could never fire. V2 must be the sender-of-record.
    function test_ContractIsTheTokenOutSender() public {
        uint256 id = _create();
        vm.recordLogs();
        vm.prank(executor);
        exec.executeRun(id, _floor());

        // The final cNGN Transfer must originate FROM the executor contract.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(cngn)
                    && logs[i].topics[0] == keccak256("Transfer(address,address,uint256)")
                    && address(uint160(uint256(logs[i].topics[1]))) == address(exec)
                    && address(uint160(uint256(logs[i].topics[2]))) == recipient
            ) found = true;
        }
        assertTrue(found, "recipient must be paid BY the executor contract, not by the pool");
        assertEq(cngn.balanceOf(recipient), 273_600e6);
        assertEq(cngn.balanceOf(address(exec)), 0, "nothing rests in the contract");
    }

    // --- destination sentinels -------------------------------------------
    function test_RevertWhen_DestinationIsRouterSentinel() public {
        uint64 exp = uint64(block.timestamp) + EXPIRY;
        vm.startPrank(sender);
        vm.expectRevert(RemessoExecutorV2.InvalidDestination.selector);
        exec.createSchedule(address(1), AMOUNT, 7 days, FLOOR_RATE_E6, 0, exp, 0, RemessoExecutorV2.PayoutType.Wallet);
        vm.expectRevert(RemessoExecutorV2.InvalidDestination.selector);
        exec.createSchedule(address(2), AMOUNT, 7 days, FLOOR_RATE_E6, 0, exp, 0, RemessoExecutorV2.PayoutType.Wallet);
        vm.expectRevert(RemessoExecutorV2.InvalidDestination.selector);
        exec.createSchedule(address(router), AMOUNT, 7 days, FLOOR_RATE_E6, 0, exp, 0, RemessoExecutorV2.PayoutType.Wallet);
        vm.stopPrank();
    }

    // --- degenerate floor -------------------------------------------------
    /// amountIn * minRateE6 < 1e6 truncates the floor to zero, so BOTH guards
    /// become `x < 0` and can never fire.
    function test_RevertWhen_FloorTruncatesToZero() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV2.DegenerateFloor.selector);
        exec.createSchedule(
            recipient, 999_999, 7 days, 1, 0,
            uint64(block.timestamp) + EXPIRY, 0, RemessoExecutorV2.PayoutType.Wallet
        );
    }

    // --- unbounded interval ----------------------------------------------
    function test_RevertWhen_IntervalUnbounded() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV2.InvalidInterval.selector);
        exec.createSchedule(
            recipient, AMOUNT, type(uint64).max, FLOOR_RATE_E6, 0,
            uint64(block.timestamp) + EXPIRY, 0, RemessoExecutorV2.PayoutType.Wallet
        );
    }

    // --- mandatory expiry -------------------------------------------------
    function test_RevertWhen_ScheduleNeverExpires() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV2.ScheduleExpired.selector);
        exec.createSchedule(recipient, AMOUNT, 7 days, FLOOR_RATE_E6, 0, 0, 0, RemessoExecutorV2.PayoutType.Wallet);
    }

    function test_RevertWhen_LifetimeTooLong() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV2.ScheduleLifetimeTooLong.selector);
        exec.createSchedule(
            recipient, AMOUNT, 7 days, FLOOR_RATE_E6, 0,
            uint64(block.timestamp) + 400 days, 0, RemessoExecutorV2.PayoutType.Wallet
        );
    }

    // --- sender can refresh the floor -------------------------------------
    function test_SenderCanRefreshFloor() public {
        uint256 id = _create();
        vm.prank(sender);
        exec.setMinRate(id, 1_500_000_000);
        assertEq(exec.getSchedule(id).minRateE6, 1_500_000_000);
        vm.prank(address(0xBAD));
        vm.expectRevert(RemessoExecutorV2.NotScheduleOwner.selector);
        exec.setMinRate(id, 1);
    }

    // --- poolFee pinned at consent ----------------------------------------
    function test_PoolFeePinnedAtConsent() public {
        uint256 id = _create();
        assertEq(exec.getSchedule(id).poolFee, 100);
        exec.setPoolFee(3000);
        assertEq(exec.getSchedule(id).poolFee, 100, "live schedule must keep its tier");
        vm.prank(sender);
        uint256 id2 = exec.createSchedule(
            recipient, AMOUNT, 7 days, FLOOR_RATE_E6, 0,
            uint64(block.timestamp) + EXPIRY, 0, RemessoExecutorV2.PayoutType.Wallet
        );
        assertEq(exec.getSchedule(id2).poolFee, 3000, "new schedules take the new default");
    }

    // --- runnability tells the truth while paused -------------------------
    function test_RunnabilityIsFalseWhilePaused() public {
        uint256 id = _create();
        (bool due,,,,) = exec.runnability(id);
        assertTrue(due);
        exec.pause();
        (due,,,,) = exec.runnability(id);
        assertFalse(due, "paused must not report due -- the backend commits a real payout on this");
    }

    // --- renounce disabled -------------------------------------------------
    function test_RevertWhen_RenounceOwnership() public {
        vm.expectRevert(RemessoExecutorV2.RenounceDisabled.selector);
        exec.renounceOwnership();
    }

    function _floor() internal pure returns (uint256) {
        return (uint256(AMOUNT) * uint256(FLOOR_RATE_E6)) / 1e6;
    }
}
