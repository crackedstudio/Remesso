// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RemessoExecutorV3} from "../src/RemessoExecutorV3.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// The Direct rail: no swap, no floor, no pool. Covers the decimal spread
/// between the three MiniPay-visible assets (USDT/USDC 6dp, cUSD 18dp).
contract RemessoExecutorV3Test is Test {
    RemessoExecutorV3 exec;
    MockERC20 usdt;
    MockERC20 usdc;
    MockERC20 cusd;
    MockERC20 cngn;
    MockRouter router;

    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");
    address executor = makeAddr("executor");

    uint96 constant FLOOR = 1_340_000_000;
    uint64 EXP;

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cusd = new MockERC20("Celo Dollar", "cUSD", 18);
        cngn = new MockERC20("cNGN", "cNGN", 6);
        router = new MockRouter(1_368_000_000);
        exec = new RemessoExecutorV3(address(usdt), address(cngn), address(router), executor, 100);
        EXP = uint64(block.timestamp) + 30 days;

        exec.setDirectToken(address(usdt), true);
        exec.setDirectToken(address(usdc), true);
        exec.setDirectToken(address(cusd), true);

        usdt.mint(sender, 10_000e6);
        usdc.mint(sender, 10_000e6);
        cusd.mint(sender, 10_000e18);
        vm.startPrank(sender);
        usdt.approve(address(exec), type(uint256).max);
        usdc.approve(address(exec), type(uint256).max);
        cusd.approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    function _direct(address token, uint128 amount) internal returns (uint256 id) {
        vm.prank(sender);
        id = exec.createSchedule(
            recipient, amount, 7 days, 0, 1, EXP, 0, RemessoExecutorV3.PayoutType.Direct, token
        );
    }

    /// The whole point: the recipient receives the asset the sender funded.
    function test_DirectRailForwardsUsdtWithNoSwap() public {
        uint256 id = _direct(address(usdt), 200e6);
        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdt.balanceOf(recipient), 200e6, "recipient gets USDT, not cNGN");
        assertEq(cngn.balanceOf(recipient), 0, "no swap occurred");
        assertEq(usdt.balanceOf(address(exec)), 0, "nothing rests in the contract");
    }

    /// cUSD is 18dp while USDT/USDC are 6dp. The contract moves base units and
    /// must not care; this is the 10^12 trap that decimals cause elsewhere.
    function test_DirectRailHandlesEighteenDecimals() public {
        uint256 id = _direct(address(cusd), 200e18);
        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(cusd.balanceOf(recipient), 200e18);
    }

    function test_DirectRailHandlesUsdc() public {
        uint256 id = _direct(address(usdc), 50e6);
        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdc.balanceOf(recipient), 50e6);
    }

    /// A Direct schedule needs no floor, so amountOutMinimum is irrelevant —
    /// it must not be usable to extract anything.
    function test_DirectRailIgnoresSlippageArgument() public {
        uint256 id = _direct(address(usdt), 100e6);
        vm.prank(executor);
        exec.executeRun(id, type(uint256).max); // absurd bound, no effect
        assertEq(usdt.balanceOf(recipient), 100e6);
    }

    function test_RevertWhen_DirectTokenNotAllowed() public {
        MockERC20 rogue = new MockERC20("Rogue", "RGE", 18);
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV3.TokenNotAllowed.selector);
        exec.createSchedule(
            recipient, 1e18, 7 days, 0, 1, EXP, 0, RemessoExecutorV3.PayoutType.Direct, address(rogue)
        );
    }

    /// The swap rails only ever move the configured funding asset.
    function test_RevertWhen_SwapRailGivenWrongToken() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV3.WrongTokenForPayoutType.selector);
        exec.createSchedule(
            recipient, 200e6, 7 days, FLOOR, 1, EXP, 0, RemessoExecutorV3.PayoutType.Wallet, address(usdc)
        );
    }

    /// Removing an asset from the allowlist must not retarget a live schedule —
    /// the lesson from V1's mutable poolFee.
    function test_TokenPinnedAtConsent() public {
        uint256 id = _direct(address(usdc), 25e6);
        exec.setDirectToken(address(usdc), false);
        assertEq(exec.getSchedule(id).token, address(usdc), "live schedule keeps its asset");
        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdc.balanceOf(recipient), 25e6, "still executes with the pinned asset");
    }

    /// runnability must read the schedule's own asset, not tokenIn.
    function test_RunnabilityChecksTheScheduleAsset() public {
        uint256 id = _direct(address(cusd), 9_000e18);
        (, bool funded, bool approved,,) = exec.runnability(id);
        assertTrue(funded && approved, "cUSD balance/allowance should satisfy it");

        uint256 tooBig = _direct(address(cusd), 50_000e18);
        (, funded,,,) = exec.runnability(tooBig);
        assertFalse(funded, "beyond the cUSD balance");
    }

    /// The swap rail must still work exactly as V2.
    function test_SwapRailUnchanged() public {
        vm.prank(sender);
        uint256 id = exec.createSchedule(
            recipient, 200e6, 7 days, FLOOR, 1, EXP, 0, RemessoExecutorV3.PayoutType.Wallet, address(usdt)
        );
        vm.prank(executor);
        exec.executeRun(id, (200e6 * uint256(FLOOR)) / 1e6);
        assertEq(cngn.balanceOf(recipient), 273_600e6);
    }

    /// Packing check: `token` shares slot 3 with expiresAt/payoutType/flags.
    function test_StructFieldsSurviveDirectSchedule() public {
        uint256 id = _direct(address(cusd), 7e18);
        RemessoExecutorV3.Schedule memory s = exec.getSchedule(id);
        assertEq(s.token, address(cusd));
        assertEq(s.expiresAt, EXP);
        assertEq(uint8(s.payoutType), uint8(RemessoExecutorV3.PayoutType.Direct));
        assertTrue(s.active);
        assertFalse(s.cancelled);
        assertEq(s.amountIn, 7e18);
        assertEq(s.minRateE6, 0, "Direct carries no floor");
        assertEq(s.poolFee, 0, "Direct carries no fee tier");
    }
}
