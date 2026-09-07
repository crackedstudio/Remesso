// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal surface of Uniswap's SwapRouter02, declared locally so the
/// project does not depend on the whole v3-periphery package.
/// Celo mainnet: 0x5615CDAb10dc425a742d643d949a7F474C01abc4
/// Note SwapRouter02 has no `deadline` field, unlike the original SwapRouter.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
