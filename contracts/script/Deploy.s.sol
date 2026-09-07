// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RemessoExecutor} from "../src/RemessoExecutor.sol";

/**
 * Celo mainnet:
 *   forge script script/Deploy.s.sol:Deploy --rpc-url celo --broadcast --verify
 *
 * Ship this to Celo Sepolia and run a full schedule against testnet cNGN
 * before it ever sees mainnet money.
 */
contract Deploy is Script {
    // Verified on Celo mainnet 2026-09-07.
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant CNGN = 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f;
    address constant SWAP_ROUTER_02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    uint24 constant POOL_FEE = 100; // the only cNGN/USDT pool: 0.01%

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address executor = vm.envAddress("EXECUTOR_ADDRESS");

        vm.startBroadcast(pk);
        RemessoExecutor exec = new RemessoExecutor(USDT, CNGN, SWAP_ROUTER_02, executor, POOL_FEE);
        vm.stopBroadcast();

        console2.log("RemessoExecutor:", address(exec));
        console2.log("executor:       ", executor);
        console2.log("owner:          ", vm.addr(pk));
    }
}
