// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter02} from "../../src/ISwapRouter02.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @notice Stands in for Uniswap's SwapRouter02. `rateE6` is tokenOut per 1e6
/// tokenIn, so it can be moved to simulate the pool drifting or a sandwich.
contract MockRouter is ISwapRouter02 {
    uint256 public rateE6;
    bool public shortChange;

    constructor(uint256 _rateE6) {
        rateE6 = _rateE6;
    }

    function setRate(uint256 r) external {
        rateE6 = r;
    }

    function setShortChange(bool v) external {
        shortChange = v;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = (p.amountIn * rateE6) / 1e6;
        if (shortChange) {
            amountOut = p.amountOutMinimum == 0 ? 0 : p.amountOutMinimum - 1;
        } else {
            require(amountOut >= p.amountOutMinimum, "Too little received");
        }
        MockERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}
