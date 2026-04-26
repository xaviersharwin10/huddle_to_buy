// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BuyerProfile
 * @dev Pre-standard ERC-7857 implementation for Agentic Buyer Profiles (iNFTs).
 * Holds a pointer to 0G Storage for preferences and sealed inference metadata.
 */
contract BuyerProfile is ERC721, Ownable {
    uint256 private _nextTokenId;

    // 0G Storage content hashes holding agent's preference metadata
    mapping(uint256 => string) public profileStorageURIs;

    // Optional integration for 0G Compute inference verifications
    mapping(uint256 => bytes32) public latestInferenceHash;

    event ProfileStored(uint256 indexed tokenId, string storageUri);
    event InferenceSealed(uint256 indexed tokenId, bytes32 inferenceHash);

    constructor() ERC721("Huddle Buyer Profile", "HBP") Ownable(msg.sender) {}

    function mintProfile(string memory storageUri) external returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _mint(msg.sender, tokenId);
        profileStorageURIs[tokenId] = storageUri;
        emit ProfileStored(tokenId, storageUri);
        return tokenId;
    }

    function updateStorageURI(uint256 tokenId, string memory newUri) external {
        require(ownerOf(tokenId) == msg.sender, "Not the owner");
        profileStorageURIs[tokenId] = newUri;
        emit ProfileStored(tokenId, newUri);
    }

    function sealInference(uint256 tokenId, bytes32 inferenceHash) external {
        require(ownerOf(tokenId) == msg.sender, "Not the owner");
        latestInferenceHash[tokenId] = inferenceHash;
        emit InferenceSealed(tokenId, inferenceHash);
    }
}
