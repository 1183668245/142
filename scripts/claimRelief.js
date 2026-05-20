import hre from "hardhat";
import dotenv from "dotenv";
import { ethers } from "ethers";
import axios from "axios";

dotenv.config();

async function main() {
  const userAddress = "0xc590360D6bc748bf023df0eC84c1D1C0AA159EdE";
  const epochId = 1; // 您要领取的轮次
  const apiBase = "https://api.0x888.dev/api"; // 您的后端 API

  console.log(`开始为地址 ${userAddress} 领取 Epoch ${epochId} 的保底奖励...`);

  // 1. 从后端获取证明
  console.log(`正在从后端获取证明: ${apiBase}/relief/claim/${userAddress}`);
  const response = await axios.get(`${apiBase}/relief/claim/${userAddress}`);
  const claims = response.data;

  const myClaim = claims.find(c => Number(c.epochId) === epochId);

  if (!myClaim) {
    console.error("❌ 错误：后端返回的名单中没有您的地址，请确认快照时您的持仓是否超过 1000 万。");
    console.log("后端返回数据:", JSON.stringify(claims, null, 2));
    return;
  }

  console.log(`✅ 找到保底奖励！可领金额: ${ethers.formatEther(myClaim.amountWei)} BNB`);

  // 2. 连接合约准备领取
  const rpcUrl = process.env.BSC_RPC_URL;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const privateKey = process.env.PRIVATE_KEY;
  const signer = new ethers.Wallet(privateKey, provider);
  
  const vaultAddress = process.env.VAULT_ADDRESS;
  const artifact = await hre.artifacts.readArtifact("JackpotVault");
  const vault = new ethers.Contract(vaultAddress, artifact.abi, signer);

  // 3. 发起交易
  console.log("正在发起领取交易...");
  try {
    const tx = await vault.claimHolderRelief(
      myClaim.epochId,
      myClaim.amountWei,
      myClaim.proof
    );
    console.log(`🚀 交易已发出: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`🎉 领取成功！区块高度: ${receipt.blockNumber}`);
  } catch (error) {
    if (error.message.includes("Already claimed")) {
      console.log("ℹ️ 该奖励您已经领取过了。");
    } else if (error.message.includes("Deadline passed")) {
      console.log("❌ 领取失败：已超过 3 小时时限，资金可能已被回收。");
    } else {
      console.error("❌ 领取失败:", error.reason || error.message);
    }
  }
}

main().catch(console.error);