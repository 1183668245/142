import hre from "hardhat";
import { ethers } from "ethers";

function getPrivateKey() {
  const raw = (process.env.PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("Missing PRIVATE_KEY in .env");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function getTreasuryWallet() {
  const treasury = (process.env.TREASURY_WALLET || "").trim();
  if (!treasury) throw new Error("Missing TREASURY_WALLET in .env");
  if (!ethers.isAddress(treasury)) throw new Error("Invalid TREASURY_WALLET in .env");
  return treasury;
}

async function main() {
  console.log("Starting deployment of FlapCupidVaultFactory...");

  const rpcUrl = hre.network?.config?.url || (process.env.BSC_RPC_URL || "").trim();
  if (!rpcUrl) throw new Error("Missing BSC mainnet RPC URL");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(getPrivateKey(), provider);
  const { chainId, name } = await provider.getNetwork();

  if (chainId !== 56n) {
    throw new Error(`Unsupported network: ${name} (${chainId}). Please use BNB Smart Chain mainnet`);
  }

  const treasuryWallet = getTreasuryWallet();
  const artifact = await hre.artifacts.readArtifact("FlapCupidVaultFactory");
  const Factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const encodedVaultData = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [treasuryWallet]);

  console.log(`Deployer: ${wallet.address}`);
  console.log(`FlapCupidVaultFactory deployed to: ${await factory.getAddress()}`);
  console.log(`Treasury wallet: ${treasuryWallet}`);
  console.log(`Encoded vaultData: ${encodedVaultData}`);
  console.log("Use this factory address in Flap.sh -> Launch Token -> Custom Vault (BNB Smart Chain mainnet)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});