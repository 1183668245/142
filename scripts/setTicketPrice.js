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
  console.log("Starting to update ticket price...");

  const rpcUrl = process.env.BSC_RPC_URL;
  if (!rpcUrl) throw new Error("Missing BSC_RPC_URL in .env");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(getPrivateKey(), provider);
  
  const vaultAddress = process.env.VAULT_ADDRESS;
  if (!vaultAddress || !ethers.isAddress(vaultAddress)) {
    throw new Error(`Invalid VAULT_ADDRESS in .env: ${vaultAddress}`);
  }

  const artifact = await hre.artifacts.readArtifact("JackpotVault");
  const vault = new ethers.Contract(vaultAddress, artifact.abi, signer);

  const owner = await vault.owner();
  console.log(`Vault Address:  ${vaultAddress}`);
  console.log(`Contract Owner: ${owner}`);
  console.log(`Current Signer: ${signer.address}`);

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Error: Current signer is not the contract owner!");
  }

  const oldPrice = await vault.TICKET_PRICE();
  console.log(`Current Price:  ${ethers.formatEther(oldPrice)} Tokens`);

  // 设置新的价格为 3000 万
  const newPriceStr = "30000000";
  const newPriceWei = ethers.parseEther(newPriceStr);

  if (oldPrice === newPriceWei) {
    console.log("Price is already 30,000,000. No need to update.");
    return;
  }

  console.log(`\nUpdating price to ${newPriceStr} Tokens...`);
  const tx = await vault.setTicketPrice(newPriceWei);
  console.log(`Tx sent: ${tx.hash}`);

  const rc = await tx.wait();
  console.log(`Tx confirmed in block: ${rc.blockNumber}`);

  const updatedPrice = await vault.TICKET_PRICE();
  console.log(`\nUpdated Price: ${ethers.formatEther(updatedPrice)} Tokens`);
  console.log("Ticket price updated successfully!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});