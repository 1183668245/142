import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.resolve(projectRoot, ".env") });

const DEFAULT_RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dEaD";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)"
];

const PAIR_ABI = [
  ...ERC20_ABI,
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

const TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

function usage() {
  console.log(`
用法:
  node .\\scripts\\inspect-lp.mjs <PAIR地址> [--from 0] [--chunk 5000] [--top 20]

示例:
  node .\\scripts\\inspect-lp.mjs 0xYourPairAddress
  node .\\scripts\\inspect-lp.mjs 0xYourPairAddress --from 0 --top 30

说明:
  - 这是只读分析脚本，不会发交易，不会转账
  - 用来查看 LP 当前主要持有人、烧毁比例、Pair 基本信息
`);
}

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function safeFormat(value, decimals = 18, precision = 6) {
  const num = Number(ethers.formatUnits(value, decimals));
  if (!Number.isFinite(num)) return ethers.formatUnits(value, decimals);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision
  });
}

function percentOf(part, total) {
  if (!total || total === 0n) return "0.0000%";
  const scaled = (part * 1000000n) / total;
  const whole = scaled / 10000n;
  const frac = String(scaled % 10000n).padStart(4, "0");
  return `${whole}.${frac}%`;
}

function short(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function tagAddress(addr) {
  const lower = addr.toLowerCase();
  if (lower === ZERO.toLowerCase()) return "ZERO";
  if (lower === DEAD.toLowerCase()) return "BURN";
  return "";
}

async function readTokenMeta(provider, address) {
  const c = new ethers.Contract(address, ERC20_ABI, provider);
  const [name, symbol, decimals] = await Promise.all([
    c.name().catch(() => "Unknown"),
    c.symbol().catch(() => "UNK"),
    c.decimals().catch(() => 18)
  ]);
  return { address, name, symbol, decimals: Number(decimals) };
}

async function main() {
  const pairArg = process.argv[2];
  if (!pairArg || pairArg.startsWith("--")) {
    usage();
    process.exit(1);
  }

  const pairAddress = ethers.getAddress(pairArg);
  const fromBlock = Number(getArg("--from", "0"));
  const chunkSize = Number(getArg("--chunk", "5000"));
  const topN = Number(getArg("--top", "20"));

  const provider = new ethers.JsonRpcProvider(DEFAULT_RPC);
  const latestBlock = await provider.getBlockNumber();

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const transferInterface = new ethers.Interface(TRANSFER_ABI);

  const [
    pairName,
    pairSymbol,
    pairDecimals,
    totalSupply,
    factory,
    token0Addr,
    token1Addr,
    reserves
  ] = await Promise.all([
    pair.name().catch(() => "Unknown LP"),
    pair.symbol().catch(() => "UNK-LP"),
    pair.decimals().catch(() => 18),
    pair.totalSupply(),
    pair.factory().catch(() => ZERO),
    pair.token0(),
    pair.token1(),
    pair.getReserves().catch(() => ({ reserve0: 0n, reserve1: 0n }))
  ]);

  const [token0, token1] = await Promise.all([
    readTokenMeta(provider, token0Addr),
    readTokenMeta(provider, token1Addr)
  ]);

  console.log("\n=== Pair 基本信息 ===");
  console.log(`RPC:        ${DEFAULT_RPC}`);
  console.log(`Pair:       ${pairAddress}`);
  console.log(`LP Name:    ${pairName}`);
  console.log(`LP Symbol:  ${pairSymbol}`);
  console.log(`Factory:    ${factory}`);
  console.log(`Token0:     ${token0.symbol}  ${token0.address}`);
  console.log(`Token1:     ${token1.symbol}  ${token1.address}`);
  console.log(`Reserve0:   ${safeFormat(reserves.reserve0 ?? 0n, token0.decimals)} ${token0.symbol}`);
  console.log(`Reserve1:   ${safeFormat(reserves.reserve1 ?? 0n, token1.decimals)} ${token1.symbol}`);
  console.log(`LP Supply:  ${safeFormat(totalSupply, Number(pairDecimals))} ${pairSymbol}`);

  const balances = new Map();
  let scannedLogs = 0;

  console.log("\n=== 开始扫描 LP Transfer 日志 ===");
  for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, latestBlock);
    process.stdout.write(`\r扫描区块 ${start} -> ${end} / ${latestBlock}`);

    const logs = await provider.getLogs({
      address: pairAddress,
      topics: [ethers.id("Transfer(address,address,uint256)")],
      fromBlock: start,
      toBlock: end
    });

    scannedLogs += logs.length;

    for (const log of logs) {
      const parsed = transferInterface.parseLog(log);
      const from = ethers.getAddress(parsed.args.from);
      const to = ethers.getAddress(parsed.args.to);
      const value = BigInt(parsed.args.value.toString());

      if (from !== ZERO) {
        balances.set(from, (balances.get(from) || 0n) - value);
      }
      if (to !== ZERO) {
        balances.set(to, (balances.get(to) || 0n) + value);
      }
    }
  }
  process.stdout.write("\n");

  const holders = [...balances.entries()]
    .map(([address, balance]) => ({ address, balance }))
    .filter((x) => x.balance > 0n)
    .sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));

  const burned = (balances.get(DEAD) || 0n) + (balances.get(ZERO) || 0n);

  console.log("\n=== 扫描结果 ===");
  console.log(`Transfer 日志数: ${scannedLogs}`);
  console.log(`持有人数量:     ${holders.length}`);
  console.log(`已烧毁 LP:      ${safeFormat(burned, Number(pairDecimals))} ${pairSymbol} (${percentOf(burned, totalSupply)})`);

  console.log(`\n=== Top ${Math.min(topN, holders.length)} LP 持有人 ===`);
  const rows = [];
  for (const [idx, h] of holders.slice(0, topN).entries()) {
    const code = await provider.getCode(h.address);
    rows.push({
      rank: idx + 1,
      address: h.address,
      short: short(h.address),
      lp: safeFormat(h.balance, Number(pairDecimals)),
      share: percentOf(h.balance, totalSupply),
      type: code !== "0x" ? "Contract" : "EOA",
      tag: tagAddress(h.address)
    });
  }
  console.table(rows);

  console.log("\n=== 判断参考 ===");
  console.log("- 如果大部分 LP 在你的钱包: 你通常可以移除流动性");
  console.log("- 如果大部分 LP 在黑洞地址: 基本等于永久锁死");
  console.log("- 如果大部分 LP 在某个合约地址: 继续去查该地址是否是锁仓/质押/路由合约");
  console.log("- 这个脚本不会告诉你“谁有权限提奖池”，它只看 LP 归属");
}

main().catch((err) => {
  console.error(`\n[inspect-lp] ${err.message}`);
  process.exit(1);
});