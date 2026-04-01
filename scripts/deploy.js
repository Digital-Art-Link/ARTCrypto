const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const initialSupply = ethers.parseUnits("1000000", 18);
  const ArtCoin = await ethers.getContractFactory("ArtCoin");
  const token = await ArtCoin.deploy(initialSupply);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("✅ ArtCoin deployed to:", address);

  const deployment = {
    contractAddress: address,
    deployerAddress: deployer.address,
    tokenName: "ArtCoin",
    symbol: "ART",
    network: "localhost",
    deployedAt: new Date().toISOString()
  };

  fs.writeFileSync("deployment.json", JSON.stringify(deployment, null, 2));
  console.log("📄 Saved to deployment.json");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});