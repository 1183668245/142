import hre from "hardhat";
import { ethers } from "ethers";

function getPrivateKey() {
  const raw = (process.env.PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("Missing PRIVATE_KEY in .env");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

async function main() {
  console.log("Starting deployment of JackpotVault...");

  const rpcUrl = process.env.BSC_RPC_URL;
  if (!rpcUrl) throw new Error("Missing BSC_RPC_URL in .env");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(getPrivateKey(), provider);
  const { chainId, name } = await provider.getNetwork();
  if (chainId !== 56n) {
    throw new Error(`Wrong network: ${name} (${chainId}). Please use BNB Smart Chain mainnet RPC`);
  }

  const treasuryWallet = process.env.TREASURY_WALLET;
  if (!treasuryWallet) {
    throw new Error("Missing TREASURY_WALLET in .env");
  }

  const artifact = await hre.artifacts.readArtifact("JackpotVault");
  const Vault = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const vault = await Vault.deploy(treasuryWallet);
  await vault.waitForDeployment();

  const vaultAddress = await vault.getAddress();
  console.log(`Deployer: ${wallet.address}`);
  console.log(`JackpotVault deployed to: ${vaultAddress}`);
  console.log("Use this vault address for mainnet front-end and backend configuration.");
  console.log("After test token deployment, call bindTaxToken(tokenAddress) once.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});