// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RemessoExecutorV4} from "../src/RemessoExecutorV4.sol";

/**
 * Celo mainnet:
 *   forge script script/DeployV4.s.sol:DeployV4 --rpc-url celo --broadcast --verify
 *
 * This deploys ALONGSIDE V3 (0xd2e68acd…e08f). It is a migration, not an
 * upgrade: schedules live in the contract's own storage, so nothing carries
 * over. Until the backend and frontend are pointed here, V3 keeps running
 * every live schedule and this contract holds nothing.
 *
 * Migrating a sender means: approve this address, re-create the schedule,
 * cancel the old one, and revoke the old allowance. In that order — the old
 * schedule keeps paying until it is cancelled, which is the safe direction.
 *
 * What V4 adds: a payout asset per schedule (from an allowlist), `runNow` for
 * a sender-authorised early send, and a commission capped at 0.5% in code.
 * Every one of those is pinned into a schedule at consent, so nothing the
 * owner does afterwards can alter a remittance already authorised.
 *
 * Bank payouts remain disabled. cNGN must whitelist THIS address as an
 * external sender before a transfer from it will burn — a new deployment is a
 * new sender-of-record, and the V3 whitelisting does not carry over.
 */
contract DeployV4 is Script {
    // Verified on Celo mainnet 2026-09-07, re-verified 2026-09-14.
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant CNGN = 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant CUSD = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant SWAP_ROUTER_02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;

    // The ONLY USDT/cNGN pool on Celo. The factory returns address(0) for the
    // 500, 3000 and 10000 tiers — verified 2026-09-14 — which is why the tier
    // is pinned per schedule rather than read live.
    uint24 constant POOL_FEE = 100;

    /// Commission on NEW schedules, in basis points. 25 = 0.25%, against a
    /// MAX_FEE_BPS of 50 that no owner action can exceed. Changing this later
    /// affects schedules created after the change and nothing else.
    uint16 constant FEE_BPS = 25;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address executor = vm.envAddress("EXECUTOR_ADDRESS");
        // Where commission lands. Defaults to the deployer — the cold owner
        // key — because revenue should not accumulate on the hot key that
        // signs runs.
        address treasury = vm.envOr("TREASURY_ADDRESS", vm.addr(pk));

        vm.startBroadcast(pk);
        RemessoExecutorV4 exec =
            new RemessoExecutorV4(USDT, CNGN, SWAP_ROUTER_02, executor, POOL_FEE, treasury, FEE_BPS);

        // The Direct rail: the three assets MiniPay displays. Anything else
        // would be invisible to the recipient.
        exec.setDirectToken(USDT, true); //  6dp
        exec.setDirectToken(USDC, true); //  6dp
        exec.setDirectToken(CUSD, true); // 18dp

        // Swap-rail payout assets. cNGN is allowed by the constructor; USDC and
        // cUSD make dollar-to-dollar conversion possible, which is the corridor
        // that needs no payout partner and no licence question.
        exec.setSwapToken(USDC, true);
        exec.setSwapToken(CUSD, true);
        vm.stopBroadcast();

        console2.log("RemessoExecutorV4:", address(exec));
        console2.log("owner / deployer: ", vm.addr(pk));
        console2.log("executor:         ", executor);
        console2.log("treasury:         ", treasury);
        console2.log("feeBps:           ", FEE_BPS);
        console2.log("");
        console2.log("Nothing points here yet. V3 keeps running every live schedule");
        console2.log("until REMESSO_EXECUTOR_ADDRESS is changed and the functions are");
        console2.log("redeployed -- and every sender must then re-approve and re-create.");
    }
}
