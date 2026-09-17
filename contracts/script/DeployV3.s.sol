// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RemessoExecutorV3} from "../src/RemessoExecutorV3.sol";

/**
 * Celo mainnet:
 *   forge script script/DeployV3.s.sol:DeployV3 --rpc-url celo --broadcast --verify
 *
 * This REPLACES RemessoExecutor V1 at 0xC7eF75fC6283aB3b810fa4dE270F074C47761189.
 * It is a migration, not an upgrade: schedules live in the contract's own
 * storage, so nothing carries over. Every sender must approve the new address
 * and re-create their schedules.
 *
 * Bank payouts remain disabled after this deploy. V2 makes THIS CONTRACT the
 * cNGN sender-of-record, which is what makes a redemption possible at all — but
 * cNGN must still add this address to its external-sender whitelist before a
 * transfer from it will burn. Confirm that with cNGN before enabling ngn_bank.
 */
contract DeployV3 is Script {
    // Verified on Celo mainnet 2026-09-07, re-verified 2026-09-14.
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant CNGN = 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f;
    address constant SWAP_ROUTER_02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;

    // The ONLY USDT/cNGN pool on Celo. The factory returns address(0) for the
    // 500, 3000 and 10000 tiers — verified 2026-09-14 — which is why V2 pins
    // the tier per schedule rather than reading it live.
    uint24 constant POOL_FEE = 100;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address executor = vm.envAddress("EXECUTOR_ADDRESS");

        vm.startBroadcast(pk);
        RemessoExecutorV3 exec =
            new RemessoExecutorV3(USDT, CNGN, SWAP_ROUTER_02, executor, POOL_FEE);
        vm.stopBroadcast();

        // Seed the Direct rail. These are the three assets MiniPay displays;
        // anything else would be invisible to the recipient.
        vm.startBroadcast(pk);
        exec.setDirectToken(0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e, true); // USDT  6dp
        exec.setDirectToken(0xcebA9300f2b948710d2653dD7B07f33A8B32118C, true); // USDC  6dp
        exec.setDirectToken(0x765DE816845861e75A25fCA122bb6898B8B1282a, true); // cUSD 18dp
        vm.stopBroadcast();

        console2.log("RemessoExecutorV3:", address(exec));
        console2.log("executor:         ", executor);
        console2.log("owner:            ", vm.addr(pk));
        console2.log("");
        console2.log("Next: set REMESSO_EXECUTOR_ADDRESS, push secrets, redeploy functions.");
        console2.log("Bank payouts stay off until cNGN whitelists this address as an");
        console2.log("external sender -- otherwise transfers from it will not burn.");
    }
}
