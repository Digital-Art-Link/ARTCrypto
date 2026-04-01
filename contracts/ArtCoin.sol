// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract ArtCoin is ERC20, ERC20Burnable, Ownable, Pausable {

    uint256 public constant MAX_SUPPLY = 10_000_000 * 10**18;

    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);

    constructor(uint256 initialSupply)
        ERC20("ArtCoin", "ART")
        Ownable(msg.sender)
    {
        require(initialSupply <= MAX_SUPPLY, "Exceeds max supply");
        _mint(msg.sender, initialSupply);
    }

    function mint(address to, uint256 amount) public onlyOwner {
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds max supply");
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }

    function burnTokens(uint256 amount) public {
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }

    function pause() public onlyOwner { _pause(); }
    function unpause() public onlyOwner { _unpause(); }

    function _update(address from, address to, uint256 value)
        internal override
    {
        require(!paused(), "Transfers paused");
        super._update(from, to, value);
    }
}