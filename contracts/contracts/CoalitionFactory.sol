// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Coalition } from "./Coalition.sol";

/// @notice Factory the elected coordinator calls to spawn a Coalition instance for a cluster.
contract CoalitionFactory {
    event CoalitionCreated(
        address indexed coalition,
        bytes32 indexed skuHash,
        address indexed seller,
        uint256 tierUnitPrice,
        uint256 unitQty,
        uint256 requiredBuyers,
        uint256 validUntil
    );

    function createCoalition(
        bytes32 skuHash,
        uint256 tierUnitPrice,
        uint256 unitQty,
        uint256 requiredBuyers,
        uint256 validUntil,
        address seller,
        address keeper,
        address payToken
    ) external returns (address) {
        Coalition c = new Coalition(
            skuHash,
            tierUnitPrice,
            unitQty,
            requiredBuyers,
            validUntil,
            seller,
            keeper,
            payToken
        );
        emit CoalitionCreated(
            address(c),
            skuHash,
            seller,
            tierUnitPrice,
            unitQty,
            requiredBuyers,
            validUntil
        );
        return address(c);
    }
}
