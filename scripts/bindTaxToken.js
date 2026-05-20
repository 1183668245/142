import hre from "hardhat";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

function getPrivateKey() {
  const raw = (process.env.PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("Missing PRIVATE_KEY in .env");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

async function main() {
  console.log("Starting bindTaxToken...");

  const rpcUrl = process.env.BSC_RPC_URL;
  if (!rpcUrl) throw new Error("Missing BSC_RPC_URL in .env");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(getPrivateKey(), provider);
  const { chainId, name } = await provider.getNetwork();
  if (chainId !== 56n) {
    throw new Error(`Wrong network: ${name} (${chainId}). Please use BSC mainnet RPC`);
  }

  const vaultAddress = process.env.VAULT_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;

  if (!vaultAddress || !ethers.isAddress(vaultAddress)) {
    throw new Error(`Invalid VAULT_ADDRESS: ${vaultAddress}`);
  }

  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error(`Invalid TOKEN_ADDRESS: ${tokenAddress}`);
  }

  const signerAddress = await signer.getAddress();
  const artifact = await hre.artifacts.readArtifact("JackpotVault");
  const vault = new ethers.Contract(vaultAddress, artifact.abi, signer);
  const owner = await vault.owner();
  const currentTaxToken = await vault.taxToken();

  console.log(`Network:        ${name} (${chainId})`);
  console.log(`Signer:         ${signerAddress}`);
  console.log(`Vault:          ${vaultAddress}`);
  console.log(`Owner:          ${owner}`);
  console.log(`Current token:  ${currentTaxToken}`);
  console.log(`Target token:   ${tokenAddress}`);

  if (signerAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Current signer is not the contract owner");
  }

  if (currentTaxToken !== ethers.ZeroAddress) {
    throw new Error(`Tax token already bound: ${currentTaxToken}`);
  }

  const tx = await vault.bindTaxToken(tokenAddress);
  console.log(`bindTaxToken tx sent: ${tx.hash}`);

  const rc = await tx.wait();
  console.log(`bindTaxToken confirmed in block: ${rc.blockNumber}`);

  const updatedTaxToken = await vault.taxToken();
  console.log(`Updated taxToken: ${updatedTaxToken}`);
  console.log("bindTaxToken completed successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});