const { ethers } = window;


const CONFIG = {
  chainIdHex: "0x38", // BNB Smart Chain Mainnet = 56
  chainName: "BNB Smart Chain",
  rpcUrls: [
    "https://rpc.ankr.com/bsc/7c004b989d92cf193ccd6641b47ad170357aa0debe7b42a6a23148d8d219200e"
  ],
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  blockExplorerUrls: ["https://bscscan.com"],

  vaultAddress: "" // 正式网金库地址待填写
};

const VAULT_ABI = [
  "function taxToken() view returns (address)",
  "function jackpotPool() view returns (uint256)",
  "function fortunePool() view returns (uint256)",
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 startTime, uint256 endTime, uint16 winningTicketId, bool resolved)",
  "function decodeTicket(uint16 ticketId) view returns (uint8 firstAvatar, uint8 secondAvatar)",
  "function TICKET_PRICE() view returns (uint256)",
  "function MIN_HOLDING() view returns (uint256)",
  "function claimableBNB(address) view returns (uint256)",
  "function noWinnerStreak() view returns (uint256)",
  "function holderReliefEpochId() view returns (uint256)",
  "function holderReliefClaimed(uint256, address) view returns (bool)",
  "function claimHolderRelief(uint256, uint256, bytes32[])",
  "function stats(address) view returns (uint256 totalWonBNB, uint256 totalBurnedToken, uint256 fortunePoints)",
  "function userTickets(uint256, address, uint256) view returns (uint16)",
  "function bindTaxToken(address _taxToken)",
  "function buyTicket(uint8 firstAvatar, uint8 secondAvatar)",
  "function draw()",
  "function claim()",
  "function description() view returns (string)"
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

let provider, signer, account, vault;
let readProvider, readVault;
let roundMeta = null;
let minHolding = null;
let isEligible = false;
let currentClaimable = 0n;
let chainTimeOffsetSec = 0;
let lastChainSyncMs = 0;
let drawHistory = [];
let historyExpanded = false;
let participationExpanded = false;
let currentRoundTickets = [];
let observedRoundId = null;
let drawRefreshBusy = false;
let lastRankLoadAt = 0;
let rankLoadBusy = false;
let reliefPending = null;
const busyButtons = new Set();
let globalLoadingTimer = null;
let successToastTimer = null;
let liveFeedBusy = false;
const ENABLE_BACKEND_API = false;
let injectedProvider = null;
let injectedWalletName = "";

const $ = (id) => document.getElementById(id);
function getWalletCandidates() {
  const root = window.ethereum;
  const list = Array.isArray(root?.providers) ? [root, ...root.providers] : [root];
  return [...new Set(list.filter(Boolean))];
}
function detectWalletName(p) {
  if (p?.isBinance || p?.isBnbChainWallet || p?.isBinanceWallet) return "Binance Web3 Wallet";
  if (p?.isOkxWallet || p?.okxwallet) return "OKX Wallet";
  if (p?.isTrust || p?.isTrustWallet) return "Trust Wallet";
  if (p?.isTokenPocket) return "TokenPocket";
  if (p?.isSafePal) return "SafePal";
  if (p?.isMetaMask) return "MetaMask";
  return "钱包";
}
function getInjectedProvider() {
  if (injectedProvider) return injectedProvider;
  const picked = getWalletCandidates().sort((a, b) => {
    const score = (p) => Number(Boolean(p?.isBinance || p?.isBnbChainWallet || p?.isBinanceWallet || p?.isOkxWallet || p?.okxwallet || p?.isTrust || p?.isTrustWallet || p?.isTokenPocket || p?.isSafePal)) * 10 + Number(Boolean(p?.isMetaMask));
    return score(b) - score(a);
  })[0] || null;
  injectedProvider = picked;
  injectedWalletName = detectWalletName(picked);
  return picked;
}

function setPageView(view = "home") {
  const isPlay = view === "play";
  if ($("homeView")) $("homeView").hidden = isPlay;
  if ($("playView")) $("playView").hidden = !isPlay;
  document.body.dataset.view = isPlay ? "play" : "home";
  ["navHome", "navStory", "navMechanics", "navPlay"].forEach((id) => $(id)?.classList.remove("active"));
  $(isPlay ? "navPlay" : "navHome")?.classList.add("active");
}

function scrollToBlock(id) {
  const el = $(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

const log = (msg) => {
  const now = new Date().toLocaleTimeString();
  $("log").textContent = `[${now}] ${msg}\n` + $("log").textContent;
};
const setReliefStatus = (text, tone = "muted") => {
  const el = $("reliefStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "#ff6b6b" : "var(--muted)";
};
const fmtFeedTime = (ms) => {
  const diff = Math.max(0, Date.now() - Number(ms || Date.now()));
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
};
function renderLiveFeed(items = []) {
  const el = $("liveActivityList");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="activity-item"><div class="activity-icon"><i class="fa-solid fa-signal"></i></div><div class="activity-content"><b>实时动态更新中</b><div class="activity-time">暂未同步到最新动态</div></div></div>';
    return;
  }
  el.innerHTML = items.map((item) => {
    const icon = item.type === "draw" ? "fa-trophy" : "fa-futbol";
    return `<div class="activity-item"><div class="activity-icon"><i class="fa-solid ${icon}"></i></div><div class="activity-content"><b>${item.title}</b><div>${item.content}</div><div class="activity-time">${fmtFeedTime(item.created_at_ms)}</div></div></div>`;
  }).join("");
}
async function loadLiveFeed(force = false) {
  if (liveFeedBusy && !force) return;
  liveFeedBusy = true;
  try {
    renderLiveFeed([]);
  } finally {
    liveFeedBusy = false;
  }
}

function fmtBNB(v) {
  return `${Number(ethers.formatEther(v)).toFixed(4)} BNB`;
}
function shortAddr(a) {
  if (!a || a === ethers.ZeroAddress) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function fmtToken(v) {
  return Number(ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtCountdown(seconds) {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
const AVATARS = [
  { name: "特朗普", en: "Donald Trump", file: "0-trump.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/13/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29_%28cropped%29%282%29.jpg/330px-Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29_%28cropped%29%282%29.jpg" },
  { name: "马斯克", en: "Elon Musk", file: "1-musk.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Elon_Musk_-_54820081119_%28cropped%29.jpg/330px-Elon_Musk_-_54820081119_%28cropped%29.jpg" },
  { name: "库克", en: "Tim Cook", file: "2-cook.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/Tim_Cook_March_2026_%28cropped_2%29.jpg/330px-Tim_Cook_March_2026_%28cropped_2%29.jpg" },
  { name: "拉里·芬克", en: "Larry Fink", file: "3-fink.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/20/Larry_Fink_with_Valdis_Dombrovskis_%28cropped%29.jpg/330px-Larry_Fink_with_Valdis_Dombrovskis_%28cropped%29.jpg" },
  { name: "史蒂芬·施瓦茨曼", en: "Stephen Schwarzman", file: "4-schwarzman.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/DBT_Magdalen_College%2C_Oxford_%26_Stephen_Schwarzman_19_March_2024-5_-_53600715712_%28cropped%29.jpg/330px-DBT_Magdalen_College%2C_Oxford_%26_Stephen_Schwarzman_19_March_2024-5_-_53600715712_%28cropped%29.jpg" },
  { name: "凯利·奥特伯格", en: "Kelly Ortberg", file: "5-ortberg.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Ortberg-Senate_%28cropped%29.png/330px-Ortberg-Senate_%28cropped%29.png" },
  { name: "布赖恩·赛克斯", en: "Brian Sikes", file: "6-sikes.webp", url: "./6.webp" },
  { name: "简·弗雷泽", en: "Jane Fraser", file: "7-fraser.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/Jane_Fraser_%28cropped%29.jpg/330px-Jane_Fraser_%28cropped%29.jpg" },
  { name: "吉姆·安德森", en: "Jim Anderson", file: "8-anderson.webp", url: "./8.webp" },
  { name: "H·劳伦斯·卡尔普", en: "H. Lawrence Culp", file: "9-culp.webp", url: "./9.webp" },
  { name: "大卫·所罗门", en: "David Solomon", file: "10-solomon.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/David_Solomon.jpg/330px-David_Solomon.jpg" },
  { name: "雅各布·泰森", en: "Jacob Thaysen", file: "11-thaysen.webp", url: "./神秘人.jpg" },
  { name: "迈克尔·米巴赫", en: "Michael Miebach", file: "12-miebach.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/52/Michael_Miebach.jpg/330px-Michael_Miebach.jpg" },
  { name: "迪娜·鲍威尔", en: "Dina Powell McCormick", file: "13-dina-powell.webp", url: "https://upload.wikimedia.org/wikipedia/commons/2/26/Dina_Habib_Powell_at_FT_Spring_Party.jpg" },
  { name: "桑杰·梅赫罗特拉", en: "Sanjay Mehrotra", file: "14-mehrotra.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Sanjay_Mehrotra_2025_%28cropped%29.jpg/330px-Sanjay_Mehrotra_2025_%28cropped%29.jpg" },
  { name: "克里斯蒂亚诺·阿蒙", en: "Cristiano Amon", file: "15-amon.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/Cristiano_Amon_%28President_%26_CEOQualcomm%29_%2854916855494%29_%28cropped%29.jpg/330px-Cristiano_Amon_%28President_%26_CEOQualcomm%29_%2854916855494%29_%28cropped%29.jpg" },
  { name: "瑞安·麦金纳尼", en: "Ryan McInerney", file: "16-mcinerney.webp", url: "./16.webp" },
  { name: "黄仁勋", en: "Jensen Huang", file: "17-huang.webp", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/Jensen_Huang_%28cropped%29.jpg/250px-Jensen_Huang_%28cropped%29.jpg" },
  { name: "图案18", en: "Pattern 18", file: "18-pattern.webp", url: "./神秘人.jpg" },
  { name: "图案19", en: "Pattern 19", file: "19-pattern.webp", url: "./神秘人.jpg" },
  { name: "图案20", en: "Pattern 20", file: "20-pattern.webp", url: "./神秘人.jpg" }
];
AVATARS.splice(0, AVATARS.length,
  { name: "何一", url: "./神秘人.jpg" },
  { name: "BNB", url: "./神秘人.jpg" },
  { name: "BSC", url: "./神秘人.jpg" },
  { name: "CZ", url: "./神秘人.jpg" },
  { name: "币安Web3钱包", url: "./神秘人.jpg" },
  { name: "币安交易所", url: "./神秘人.jpg" },
  { name: "币安快捷买币", url: "./神秘人.jpg" },
  { name: "币安P2P", url: "./神秘人.jpg" },
  { name: "币安理财值", url: "./神秘人.jpg" },
  { name: "币安定投", url: "./神秘人.jpg" },
  { name: "币安质押", url: "./神秘人.jpg" },
  { name: "币安借贷", url: "./神秘人.jpg" },
  { name: "币安MegaDrop", url: "./神秘人.jpg" },
  { name: "币安Launchpad", url: "./神秘人.jpg" },
  { name: "币安Alpha", url: "./神秘人.jpg" },
  { name: "币安AI智能助手", url: "./神秘人.jpg" },
  { name: "币安学院", url: "./神秘人.jpg" },
  { name: "币安研究院", url: "./神秘人.jpg" },
  { name: "币安广场", url: "./神秘人.jpg" },
  { name: "币安慈善", url: "./神秘人.jpg" },
  { name: "币安人生", url: "./神秘人.jpg" }
);
function displayAvatarNo(id) {
  return Number(id) + 1;
}
function avatarLabel(id) {
  return AVATARS[Number(id)]?.name || `嘉宾${displayAvatarNo(id)}`;
}
function avatarPatternImage(id) {
  const no = String(displayAvatarNo(id)).padStart(2, "0");
  return `./图案/${no}.webp`;
}
function avatarFallbackImage(id) {
  const item = AVATARS[Number(id)];
  if (!item) return "./神秘人.jpg";
  return item.url || "./神秘人.jpg";
}
function avatarImage(id) {
  const item = AVATARS[Number(id)];
  if (!item) return "";
  return avatarPatternImage(id);
}
function avatarOptionMarkup(placeholder) {
  return [`<option value="">${placeholder}</option>`, ...AVATARS.map((item, idx) => `<option value="${idx}">${displayAvatarNo(idx)} · ${item.name}</option>`)].join("");
}
function formatAvatarPair(firstAvatar, secondAvatar) {
  if (firstAvatar == null || secondAvatar == null || firstAvatar === "" || secondAvatar === "") return "待选择";
  return `${avatarLabel(firstAvatar)} · ${avatarLabel(secondAvatar)}`;
}
function renderAvatarPicker() {
  const grid = $("avatarGrid");
  const first = $("firstAvatar")?.value ?? "";
  const second = $("secondAvatar")?.value ?? "";
  if (!grid) return;
  grid.innerHTML = AVATARS.map((item, idx) => {
    const role = String(idx) === first ? "first" : String(idx) === second ? "second" : "";
    const active = role !== "";
    const disabled = first !== "" && second === "" && String(idx) === first;
    return `<button type="button" class="avatar-tile${active ? " is-active" : ""}${disabled ? " is-disabled" : ""}" data-avatar-id="${idx}"${role ? ` data-picked-role="${role}"` : ""} title="${item.name}"><span class="avatar-no">${displayAvatarNo(idx)}</span><span class="avatar-portrait"><img src="${avatarImage(idx)}" alt="${item.name}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.dataset.fallback='1';this.src='${avatarFallbackImage(idx)}'"></span><span class="avatar-name">${item.name}</span></button>`;
  }).join("");
}
function syncSummaryPanel() {
  const first = $("firstAvatar")?.value ?? "";
  const second = $("secondAvatar")?.value ?? "";
  if ($("firstSlotLabel")) $("firstSlotLabel").textContent = first === "" ? "待选" : `${displayAvatarNo(first)} · ${avatarLabel(first)}`;
  if ($("secondSlotLabel")) $("secondSlotLabel").textContent = second === "" ? "待选" : `${displayAvatarNo(second)} · ${avatarLabel(second)}`;
  if ($("currentPairDisplay")) {
    $("currentPairDisplay").textContent = formatAvatarPair(Number(first), Number(second));
    $("currentPairDisplay").classList.toggle("current-pair-empty", first === "" || second === "");
  }
}
function updateAvatarPreview() {
  const firstAvatar = $("firstAvatar")?.value ?? "";
  const secondAvatar = $("secondAvatar")?.value ?? "";
  $("inputPreview").textContent = firstAvatar === "" || secondAvatar === ""
    ? "当前CP组合：待选择"
    : `当前CP组合：${formatAvatarPair(Number(firstAvatar), Number(secondAvatar))}`;
  syncSummaryPanel();
  renderAvatarPicker();
}
function handleAvatarPick(avatarId) {
  const firstEl = $("firstAvatar");
  const secondEl = $("secondAvatar");
  if (!firstEl || !secondEl) return;
  const id = String(avatarId);
  if (firstEl.value === id) {
    firstEl.value = "";
  } else if (secondEl.value === id) {
    secondEl.value = "";
  } else if (firstEl.value === "") {
    firstEl.value = id;
  } else if (secondEl.value === "") {
    secondEl.value = id;
  } else {
    secondEl.value = id;
  }
  if (firstEl.value !== "" && firstEl.value === secondEl.value) secondEl.value = "";
  updateAvatarPreview();
}
async function decodeTicketDisplay(ticketId, activeVault = null) {
  if (ticketId == null || ticketId === "") return "待揭晓";
  const targetVault = activeVault || vault || readVault;
  if (!targetVault) return String(ticketId);
  try {
    const [firstAvatar, secondAvatar] = await targetVault.decodeTicket(ticketId);
    return formatAvatarPair(Number(firstAvatar), Number(secondAvatar));
  } catch {
    return String(ticketId);
  }
}
function fmtDateTime(ts) {
  return new Date(Number(ts) * 1000).toLocaleString("zh-CN", { hour12: false });
}
function getLocalNowSec() {
  return Math.floor(Date.now() / 1000);
}
function getChainNowSec() {
  return getLocalNowSec() + chainTimeOffsetSec;
}
async function syncChainTime(force = false) {
  const activeProvider = provider || readProvider;
  if (!activeProvider) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastChainSyncMs < 15000) return;
  const block = await activeProvider.getBlock("latest");
  if (!block?.timestamp) return;
  chainTimeOffsetSec = Number(block.timestamp) - getLocalNowSec();
  lastChainSyncMs = nowMs;
}
function isAmbiguousTxError(message = "") {
  return /could not coalesce error|unknown error|internal json-rpc error/i.test(message || "");
}
function humanizeError(message = "") {
  if (/user rejected|denied/i.test(message)) return "你已取消本次钱包签名";
  if (isAmbiguousTxError(message)) return "钱包返回了不稳定响应，系统将立即刷新链上状态确认本次操作是否已生效";
  if (/insufficient allowance/i.test(message)) return "参赛代币授权额度不足，请先完成授权";
  if (/Hold 500k\+/i.test(message)) return "持仓未达到 50 万，暂不具备参与资格";
  if (/Hold 10m\+/i.test(message)) return "当前实时持仓未达到 1000 万，无法领取持币保底";
  if (/Invalid proof/i.test(message)) return "保底证明校验失败，请稍后刷新页面重试";
  if (/Claim ended/i.test(message)) return "本轮持币保底领取已过期";
  if (/Already claimed/i.test(message)) return "本轮持币保底已领取，无需重复操作";
  if (/Root not set/i.test(message)) return "本轮持币保底证明尚未完成同步，请稍后重试";
  if (/Locked/i.test(message)) return "当前已进入封盘阶段，暂不可提交誓约";
  if (/Max 5/i.test(message)) return "本轮最多只能提交 5 组誓约";
  if (/Duplicate ticket/i.test(message)) return "本轮该组合已使用，请更换组合";
  if (/Different avatars only/i.test(message)) return "必须选择两个不同头像";
  if (/Invalid avatar/i.test(message)) return "头像编号无效，请重新选择";
  if (/No prize/i.test(message)) return "当前没有可领取的奖励";
  if (/Not ended/i.test(message)) return "当前轮次尚未结束，请等待倒计时归零后再开奖";
  if (/Resolved/i.test(message)) return "本轮已经开奖，请刷新页面查看下一轮";
  return message || "操作失败，请稍后重试";
}
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}
async function showWalletEntryGuide() {
  const msg = isMobileDevice()
    ? "未检测到可用钱包环境。\n\n请使用 Binance Web3 Wallet / OKX / MetaMask / Trust Wallet / TokenPocket / SafePal 的内置浏览器打开当前页面，再点击连接钱包。"
    : "未检测到可用钱包环境。\n\n请安装支持 EVM 的浏览器钱包，或改用钱包内置浏览器打开页面。";
  await showAlert(msg, "未检测到钱包");
}
function setTone(id, tone) {
  const el = $(id);
  if (el) el.dataset.tone = tone;
}
function setButtonState(id, disabled, hint, tone = "muted") {
  const btn = $(id);
  if (btn) btn.disabled = disabled || busyButtons.has(id);
  const tip = $(`${id.replace("btn", "").toLowerCase()}Hint`);
  if (tip && hint) {
    tip.textContent = hint;
    tip.dataset.tone = tone;
  }
}
function setEligibilityStatus(text, tone = "muted") {
  const el = $("eligibilityStatus");
  if (!el) return;
  el.textContent = text;
  setTone("eligibilityStatus", tone);
}
function syncRewardClaimable(text = "0.0000 BNB") {
  if ($("myClaimable")) $("myClaimable").textContent = text;
  if ($("rewardClaimable")) $("rewardClaimable").textContent = text;
  const canClaim = account && currentClaimable > 0n;
  if ($("btnClaimRewardModal")) $("btnClaimRewardModal").disabled = !canClaim;
}
function syncHeroMirrors() {
  const state = $("roundState")?.textContent || "-";
  const label = $("countdownLabel")?.textContent || "距离封盘";
  const countdown = $("lockCountdown")?.textContent || "-";
  const round = $("roundId")?.textContent || "-";
  if ($("heroFloatState")) $("heroFloatState").textContent = state;
  if ($("heroFloatCountdown")) $("heroFloatCountdown").textContent = `${label} ${countdown}`;
  if ($("heroFloatRound")) $("heroFloatRound").textContent = `当前轮次：第 ${round} 期`;
}
function setGlobalLoading(visible, title = "处理中", text = "请稍候，系统正在同步链上状态...") {
  const mask = $("globalLoading");
  if (!mask) return;
  if (globalLoadingTimer) {
    clearTimeout(globalLoadingTimer);
    globalLoadingTimer = null;
  }
  mask.hidden = !visible;
  if (visible) {
    $("globalLoadingTitle").textContent = title;
    $("globalLoadingText").textContent = text;
    globalLoadingTimer = setTimeout(() => {
      mask.hidden = true;
      globalLoadingTimer = null;
      if (title === "领取持币保底奖励") {
        log(`${title} 等待超时：钱包可能未弹出、当前持仓不足 1000 万，或保底证明模拟校验未通过，请检查钱包扩展窗口后重试。`);
      } else {
        log(`${title} 等待超时，请检查钱包确认窗口或稍后重试。`);
      }
    }, 25000);
  }
}
function setButtonLoading(id, loading, loadingText = "处理中...") {
  const btn = $(id);
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
    busyButtons.add(id);
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.textContent = loadingText;
  } else {
    busyButtons.delete(id);
    btn.disabled = false;
    btn.classList.remove("is-loading");
    btn.textContent = id === "btnConnect" && account
      ? shortAddr(account)
      : (btn.dataset.originalText || btn.textContent);
    delete btn.dataset.originalText;
  }
}
function showSuccessToast(title, text) {
  const toast = $("successToast");
  if (!toast) return;
  $("successToastTitle").textContent = title;
  $("successToastText").textContent = text;
  toast.hidden = false;
  if (successToastTimer) clearTimeout(successToastTimer);
  successToastTimer = setTimeout(() => {
    toast.hidden = true;
    successToastTimer = null;
  }, 3200);
}
async function runButtonAction(id, loadingText, action) {
  if (busyButtons.has(id)) return;
  setButtonLoading(id, true, loadingText);
  try {
    await action();
  } finally {
    setButtonLoading(id, false);
    setGlobalLoading(false);
    updateActionHints();
  }
}

/**
 * 自定义确认弹窗 (替换 window.confirm)
 */
function showConfirm(message, title = "确认操作") {
  return new Promise((resolve) => {
    const modal = $("customConfirm");
    const titleEl = $("confirmTitle");
    const msgEl = $("confirmMessage");
    const btnOk = $("btnConfirmOk");
    const btnCancel = $("btnConfirmCancel");

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.add("open");

    const cleanup = (result) => {
      modal.classList.remove("open");
      btnOk.onclick = null;
      btnCancel.onclick = null;
      resolve(result);
    };

    btnOk.onclick = () => cleanup(true);
    btnCancel.onclick = () => cleanup(false);
  });
}

/**
 * 自定义警示弹窗 (单按钮)
 */
function showAlert(message, title = "提示") {
  return new Promise((resolve) => {
    const modal = $("customConfirm");
    const titleEl = $("confirmTitle");
    const msgEl = $("confirmMessage");
    const btnOk = $("btnConfirmOk");
    const btnCancel = $("btnConfirmCancel");

    titleEl.textContent = title;
    msgEl.textContent = message;
    btnCancel.style.display = "none"; // 隐藏取消按钮
    modal.classList.add("open");

    const cleanup = () => {
      modal.classList.remove("open");
      btnCancel.style.display = ""; // 恢复显示
      btnOk.onclick = null;
      resolve();
    };

    btnOk.onclick = cleanup;
  });
}

function rememberObservedRound(roundId) {
  observedRoundId = Number(roundId);
}
async function checkRoundTransitionAutoReload() {
  if (drawRefreshBusy || !readVault) return;
  drawRefreshBusy = true;
  try {
    const latestRoundId = Number(await readVault.currentRoundId());
    if (observedRoundId == null) {
      observedRoundId = latestRoundId;
      return;
    }
    if (latestRoundId <= observedRoundId) return;

    const reloadKey = `golden-boot-reloaded-round-${latestRoundId}`;
    if (sessionStorage.getItem(reloadKey)) {
      observedRoundId = latestRoundId;
      return;
    }

    sessionStorage.setItem(reloadKey, "1");
    log(`检测到第 ${latestRoundId} 期已开启，页面将自动刷新同步最新开奖结果...`);
    window.location.reload();
  } catch {}
  finally {
    drawRefreshBusy = false;
  }
}
async function renderParticipationInfo() {
  const roundText = $("roundId")?.textContent || "-";
  const picked = currentRoundTickets.length
    ? (await Promise.all(currentRoundTickets.map((ticketId) => decodeTicketDisplay(ticketId)))).join(" / ")
    : "暂未提交誓约";
  $("myRoundInfo").textContent = !account
    ? "我的本轮CP：未连接钱包"
    : !roundMeta?.endTime
      ? "我的本轮CP：本轮尚未开始"
      : `我的本轮CP：第 ${roundText} 期 · 已选CP组合：${picked}`;

  const refs = drawHistory.slice(0, 5);
  $("historyRefInfo").textContent = refs.length
    ? `近 5 期CP参考：最近 ${refs.length} 期CP结果`
    : "近 5 期CP参考：等待首期开奖完成";

  const board = $("historyTrendBoard");
  if (board) {
    if (!refs.length) {
      board.innerHTML = '<div class="trend-empty">暂无CP历史数据</div>';
    } else {
      const cards = await Promise.all(refs.map(async (item, idx) => `
        <div class="trend-cell ${idx === 0 ? "is-latest" : ""}">
          <span class="trend-label">第 ${item.roundId} 期</span>
          <strong class="trend-number">${await decodeTicketDisplay(item.winningTicketId)}</strong>
        </div>
      `));
      board.innerHTML = cards.join("");
    }
  }

  const btn = $("btnToggleParticipation");
  if (btn) btn.textContent = "查看本轮组合";
}
async function updateRoundStatus() {
  if (!roundMeta?.endTime) {
    $("countdownLabel").textContent = "当前状态";
    $("roundState").textContent = "待开启";
    $("lockCountdown").textContent = "等待绑定参赛代币";
    $("roundEndTime").textContent = "-";
    setTone("roundState", "muted");
    setTone("lockCountdown", "muted");
    syncHeroMirrors();
    return;
  }
  const now = getChainNowSec();
  const endTime = Number(roundMeta.endTime);
  const lockTime = Math.max(endTime - 30, 0);
  $("roundEndTime").textContent = fmtDateTime(endTime);

  if (now >= endTime) {
    $("countdownLabel").textContent = "距离开奖";
    $("roundState").textContent = "等待CP组合";
    $("lockCountdown").textContent = "已结束";
    setTone("roundState", "warn");
    setTone("lockCountdown", "warn");
    syncHeroMirrors();
    return;
  }
  if (now >= lockTime) {
    $("countdownLabel").textContent = "距离开奖";
    $("roundState").textContent = "封盘中";
    $("lockCountdown").textContent = fmtCountdown(endTime - now);
    setTone("roundState", "warn");
    setTone("lockCountdown", "warn");
    syncHeroMirrors();
    return;
  }
  $("countdownLabel").textContent = "距离封盘";
  $("roundState").textContent = "可誓约";
  $("lockCountdown").textContent = fmtCountdown(lockTime - now);
  setTone("roundState", "ok");
  setTone("lockCountdown", "ok");
  syncHeroMirrors();
}
async function checkReliefClaim(epochId) {
  reliefPending = null;
  $("btnClaimRelief").style.display = "none";
  setReliefStatus(`持币保底状态：纯前端模式，Epoch ${epochId} 不检查后端奖励`, "muted");
}

async function updateEligibility(taxToken) {
  if (!account) {
    setEligibilityStatus("资格检测：未连接钱包", "muted");
    return;
  }
  if (!taxToken || taxToken === ethers.ZeroAddress) {
    setEligibilityStatus("资格检测：待绑定参赛代币", "muted");
    return;
  }
  const token = new ethers.Contract(taxToken, ERC20_ABI, provider);
  const balance = await token.balanceOf(account);
  isEligible = balance >= minHolding;
  if (isEligible) {
    setEligibilityStatus(`资格检测：已达标 · 当前代币数量 ${fmtToken(balance)} / 门槛 ${fmtToken(minHolding)}`, "ok");
  } else {
    setEligibilityStatus(`资格检测：未达标 · 当前代币数量 ${fmtToken(balance)} / 门槛 ${fmtToken(minHolding)}`, "warn");
  }
}
async function updateLastWinning(roundId) {
  const activeVault = vault || readVault;
  if (!activeVault) return;
  if (roundId <= 1n) {
    $("lastWinningNumber").textContent = "暂无";
    return;
  }
  const prev = await activeVault.rounds(roundId - 1n);
  $("lastWinningNumber").textContent = prev.resolved ? await decodeTicketDisplay(prev.winningTicketId, activeVault) : "待揭晓";
}
function updateActionHints() {
  const now = getChainNowSec();
  const endTime = Number(roundMeta?.endTime || 0);
  const started = endTime > 0;
  const locked = started && now >= Math.max(endTime - 30, 0) && now < endTime;
  const ended = started && now >= endTime;
  setButtonState("btnBind", !account, !account ? "请先连接管理钱包后再执行绑定。" : "已连接钱包，可执行参赛代币绑定。", !account ? "muted" : "ok");
  setButtonState("btnBuy", !account || !started || !isEligible || locked || ended, !account ? "请先连接钱包后参与。" : !started ? "本轮尚未开启，请先完成参赛代币绑定。" : !isEligible ? "尚未达到 50 万持仓门槛，暂不可参与。" : locked ? "当前处于封盘阶段，无法继续提交CP组合。" : ended ? "本轮已结束，请等待开奖。" : "状态正常，可立即确认誓约。", !account || !started || !isEligible || locked || ended ? "warn" : "ok");
  setButtonState("btnDraw", !account || !started || !ended, !account ? "请先连接钱包后再操作。" : !started ? "本轮尚未开启，暂不可开奖。" : ended ? "本轮已结束，可立即触发开奖。" : "仅在本轮结束后开放。", !account ? "muted" : ended ? "ok" : "muted");
  setButtonState("btnClaim", !account || currentClaimable <= 0n, !account ? "请先连接钱包后查看奖励。" : currentClaimable > 0n ? "检测到可领取奖励，可直接提取。" : "当前没有可领取的奖励。", !account ? "muted" : currentClaimable > 0n ? "ok" : "muted");
}

async function registerPlayerToBackend(address) {
  if (!address || !ethers.isAddress(address)) return;
  if (!ENABLE_BACKEND_API) return;
}
function renderRankList(elId, rows, valueKey, valueFormatter) {
  const el = $(elId);
  el.innerHTML = "";
  if (!rows.length) {
    el.innerHTML = '<li class="empty-state">排行榜将随链上数据实时更新</li>';
    return;
  }
  rows.forEach((r, idx) => {
    const li = document.createElement("li");
    li.className = "rank-item-ucl";
    li.innerHTML = `
      <div class="rank-num">${idx + 1}</div>
      <div class="rank-info">
        <span class="addr">${shortAddr(r.address)}</span>
        <span class="val">${valueFormatter(r[valueKey], r)}</span>
      </div>
    `;
    el.appendChild(li);
  });
}
let drawerZIndexSeed = 220;
function setDrawerOpen(drawerId, open, defaultTab = null) {
  const drawer = $(drawerId);
  if (!drawer) return;

  if (open) {
    drawerZIndexSeed += 1;
    drawer.style.zIndex = String(drawerZIndexSeed);
  }

  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("drawer-open", Boolean(document.querySelector(".drawer.open")));

  // 如果是排行榜弹窗且指定了默认选项卡
  if (drawerId === "rankDrawer" && open && defaultTab) {
    switchRankTab(defaultTab);
  }
}

// 切换排行榜选项卡逻辑
function switchRankTab(tabId) {
  // 更新按钮状态
  document.querySelectorAll('.rank-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  // 更新面板显隐
  document.querySelectorAll('.rank-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `pane-${tabId}`);
  });
  
  // 切换时自动触发一次刷新（带频率限制的刷新）
  loadRanks();
}
async function renderHistory() {
  const el = $("historyList");
  const elDrawer = $("historyList_drawer");

  const renderItems = (target, visibleData) => {
    if (!target) return;
    target.innerHTML = "";
    if (!visibleData.length) {
      const currentRoundText = $("roundId")?.textContent || "-";
      target.innerHTML = `<div class="history-empty">暂无CP历史 (当前: 第 ${currentRoundText} 期)</div>`;
      return;
    }

    visibleData.forEach((item) => {
      const row = document.createElement("div");
      row.className = "history-row history-item-ucl";
      row.innerHTML = `
        <div class="history-round">#${item.roundId}</div>
        <div class="history-pair"><strong>加载中...</strong></div>
        <div class="history-time">${new Date(item.endTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      `;
      decodeTicketDisplay(item.winningTicketId).then((text) => {
        const strong = row.querySelector("strong");
        if (strong) strong.textContent = text;
      });
      target.appendChild(row);
    });
  };

  const visibleHistory = historyExpanded ? drawHistory : drawHistory.slice(0, 20);
  if (el) renderItems(el, drawHistory.slice(0, 5));
  if (elDrawer) renderItems(elDrawer, visibleHistory);

  const btn = $("btnToggleHistory");
  if (btn) btn.textContent = historyExpanded ? "收起到 20 期" : "展开到 100 期";
  renderParticipationInfo();
}
async function loadCurrentRoundTickets(roundId) {
  if (!vault || !account) {
    currentRoundTickets = [];
    renderParticipationInfo();
    return;
  }

  const values = [];
  for (let i = 0; i < 5; i++) {
    try {
      const ticket = await vault.userTickets(roundId, account, i);
      values.push(Number(ticket));
    } catch {
      break;
    }
  }
  currentRoundTickets = values;
  renderParticipationInfo();
}
async function loadDrawHistory(currentRoundId) {
  const activeVault = vault || readVault;
  if (!activeVault) return;
  const latestResolvedRound = Number(currentRoundId) - 1;
  if (latestResolvedRound <= 0) {
    drawHistory = [];
    renderHistory();
    return;
  }
  const startRound = Math.max(1, latestResolvedRound - 99);
  const roundIds = [];
  for (let id = latestResolvedRound; id >= startRound; id--) {
    roundIds.push(id);
  }
  const rounds = await Promise.all(roundIds.map((id) => activeVault.rounds(id)));
  drawHistory = roundIds
    .map((id, idx) => {
      const round = rounds[idx];
      return {
        roundId: id,
        resolved: Boolean(round.resolved),
        winningTicketId: Number(round.winningTicketId),
        endTime: Number(round.endTime)
      };
    })
    .filter((item) => item.resolved);
  renderHistory();
}

function initReadOnlyContext() {
  if (!CONFIG.vaultAddress) return;
  if (readProvider && readVault) return;
  readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrls[0]);
  readVault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, readProvider);
}

async function loadPublicData() {
  initReadOnlyContext();
  if (!CONFIG.vaultAddress || !readVault) {
    $("vaultAddr").textContent = "测试网合约地址待填写";
    return;
  }
  try {
    await syncChainTime(true);
    const [pool, fortune, roundId, taxToken, round] = await Promise.all([
      readVault.jackpotPool(),
      readVault.fortunePool(),
      readVault.currentRoundId(),
      readVault.taxToken(),
      readVault.currentRoundId().then((id) => readVault.rounds(id))
    ]);
    roundMeta = round;
    $("vaultAddr").textContent = CONFIG.vaultAddress;
    $("jackpotPool").textContent = fmtBNB(pool);
    $("fortunePool").textContent = fmtBNB(fortune);
    $("roundId").textContent = roundId.toString();
    $("taxToken").textContent = taxToken;
    rememberObservedRound(roundId);
    updateRoundStatus();
    await updateLastWinning(roundId);
    await loadDrawHistory(roundId);
    updateActionHints();
  } catch (e) {
    log(`公开数据读取失败: ${humanizeError(e.shortMessage || e.message)}`);
  }
}

async function refreshHomeOverview() {
  log("正在刷新首页轮次与CP数据...");
  await loadPublicData();
  await loadRanks(true);
  loadLiveFeed(true);
  if (account && vault) {
    refresh().catch((e) => {
      log(`首页附加刷新失败: ${humanizeError(e?.shortMessage || e?.message || String(e))}`);
    });
  }
}

window.refreshHomeOverview = refreshHomeOverview;

async function ensureBscMainnet() {
  const eth = getInjectedProvider();
  if (!eth) throw new Error("未检测到钱包");
  const chainId = await eth.request({ method: "eth_chainId" });
  if (chainId === CONFIG.chainIdHex) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CONFIG.chainIdHex }] });
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: CONFIG.chainIdHex, chainName: CONFIG.chainName, rpcUrls: CONFIG.rpcUrls, nativeCurrency: CONFIG.nativeCurrency, blockExplorerUrls: CONFIG.blockExplorerUrls }]
    });
  }
}

function resetDashboard() {
  roundMeta = null;
  minHolding = null;
  isEligible = false;
  currentClaimable = 0n;
  reliefPending = null;
  $("vaultAddr").textContent = CONFIG.vaultAddress;
  $("jackpotPool").textContent = "-";
  $("fortunePool").textContent = "-";
  $("roundId").textContent = "-";
  syncRewardClaimable("0.0000 BNB");
  $("taxToken").textContent = "-";
  $("myTotalWon").textContent = "-";
  $("myTotalBurned").textContent = "-";
  $("myFortunePoints").textContent = "-";
  setEligibilityStatus("未连接钱包", "muted");
  $("lastWinningNumber").textContent = "-";
  $("inputPreview").textContent = "当前CP组合：待选择";
  $("myRoundInfo").textContent = "我的本轮CP：未连接钱包";
  $("historyRefInfo").textContent = "近 5 期CP参考：等待历史记录加载";
  if ($("btnClaimRelief")) $("btnClaimRelief").style.display = "none";
  setReliefStatus("持币保底状态：未连接钱包", "muted");
  drawHistory = [];
  participationExpanded = false;
  currentRoundTickets = [];
  historyExpanded = false;
  renderHistory();
  setEligibilityStatus("未连接钱包", "muted");
  setTone("roundState", "muted");
  setTone("lockCountdown", "muted");
  updateRoundStatus();
  updateActionHints();
}

async function restoreAuthorizedConnection(requestAccounts = false) {
  const eth = getInjectedProvider();
  if (!eth) return false;
  provider = new ethers.BrowserProvider(eth);
  bindWalletEvents();
  const accounts = requestAccounts ? await provider.send("eth_requestAccounts", []) : await provider.send("eth_accounts", []);
  if (!accounts || accounts.length === 0) {
    $("btnConnect").textContent = "连接钱包";
    return false;
  }
  await syncChainTime(true);
  account = accounts[0];
  signer = await provider.getSigner(account);
  vault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, signer);
  $("btnConnect").textContent = shortAddr(account);
  $("vaultAddr").textContent = CONFIG.vaultAddress;
  setEligibilityStatus("资格检测中...", "muted");
  registerPlayerToBackend(account).catch((e) => log(`地址登记失败: ${humanizeError(e?.message || String(e))}`));
  refresh().catch((e) => log(`连接后后台刷新失败: ${humanizeError(e?.shortMessage || e?.message || String(e))}`));
  return true;
}

async function connect() {
  await runButtonAction("btnConnect", "连接中...", async () => {
    if (!getInjectedProvider()) return showWalletEntryGuide();
    setGlobalLoading(true, "连接钱包", `请在${injectedWalletName || "钱包"}中确认连接请求；手机端请确保当前页面已在钱包内置浏览器中打开。`);
    try {
      await ensureBscMainnet();
      const connected = await restoreAuthorizedConnection(true);
      if (connected) log(`${injectedWalletName || "钱包"}已连接: ${account}`);
    } finally {
      setGlobalLoading(false);
    }
  });
}

async function refresh() {
  if (!vault || !account) return;
  try {
    await syncChainTime(true);
    const [pool, fortune, roundId, claimable, taxToken, streak, epochId] = await Promise.all([
      vault.jackpotPool(),
      vault.fortunePool(),
      vault.currentRoundId(),
      vault.claimableBNB(account),
      vault.taxToken(),
      vault.noWinnerStreak(),
      vault.holderReliefEpochId()
    ]);

    currentClaimable = claimable;
    $("jackpotPool").textContent = fmtBNB(pool);
    $("fortunePool").textContent = fmtBNB(fortune);
    $("roundId").textContent = roundId.toString();
    syncRewardClaimable(fmtBNB(claimable));
    $("taxToken").textContent = !taxToken || taxToken === ethers.ZeroAddress ? "待绑定" : taxToken;
    rememberObservedRound(roundId);

    // 检查是否有持币保底奖励可领
    if (epochId > 0n) {
      await checkReliefClaim(Number(epochId));
    } else {
      reliefPending = null;
      $("btnClaimRelief").style.display = "none";
      setReliefStatus(!taxToken || taxToken === ethers.ZeroAddress ? "持币保底状态：本轮尚未开始" : "持币保底状态：当前未触发保底轮", "muted");
    }

    try {
      const [holding, myStats, round] = await Promise.all([
        vault.MIN_HOLDING(),
        vault.stats(account),
        vault.rounds(roundId)
      ]);
      minHolding = holding;
      roundMeta = round;
      
      const won = fmtBNB(myStats.totalWonBNB);
      const burned = `${fmtToken(myStats.totalBurnedToken)} Token`;
      const pts = myStats.fortunePoints.toString();

      $("myTotalWon").textContent = won;
      $("myTotalBurned").textContent = burned;
      $("myFortunePoints").textContent = pts;
      if ($("myFortunePoints_dup")) $("myFortunePoints_dup").textContent = pts;

      // Drawer targets
      if ($("myTotalWon_drawer")) $("myTotalWon_drawer").textContent = won;
      if ($("myTotalBurned_drawer")) $("myTotalBurned_drawer").textContent = burned;
      if ($("myFortunePoints_drawer")) $("myFortunePoints_drawer").textContent = pts;

      updateRoundStatus();
      await updateLastWinning(roundId);
      await loadDrawHistory(roundId);
      await loadCurrentRoundTickets(roundId);
    } catch (e) {
      log(`部分数据读取失败: ${humanizeError(e.shortMessage || e.message)}`);
    }

    try {
      if (minHolding == null) minHolding = await vault.MIN_HOLDING();
      await updateEligibility(taxToken);
    } catch (e) {
      setEligibilityStatus("资格读取失败", "muted");
      log(`资格读取失败: ${humanizeError(e.shortMessage || e.message)}`);
    }

    updateActionHints();
  } catch (e) {
    setEligibilityStatus("资格读取失败", "muted");
    log(`读取失败: ${humanizeError(e.shortMessage || e.message)}`);
  }
}

async function loadRanks(force = false) {
  if (rankLoadBusy) return;
  const now = Date.now();
  if (!force && now - lastRankLoadAt < 10000) return;

  rankLoadBusy = true;

  // 显示加载动画
  const loadingHtml = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="loading-text">正在同步排行榜数据...</div>
    </div>
  `;
  ['richList_drawer', 'burnList_drawer', 'fortuneList', 'diamondList'].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = loadingHtml;
  });

  try {
    const data = ENABLE_BACKEND_API
      ? await fetch(`${""}/ranks?limit=20`, { cache: "no-store" }).then((res) => {
          if (!res.ok) throw new Error(`榜单接口读取失败: ${res.status}`);
          return res.json();
        })
      : { rich: [], burn: [], fortune: [], diamond: [], counts: { players: 0 } };

    const renderUCL = (elId, rows, valueKey, valueFormatter) => {
      const el = $(elId);
      if (!el) return;
      el.innerHTML = "";
      if (!rows.length) {
        el.innerHTML = '<li class="empty-state">排行榜暂无数据</li>';
        return;
      }
      rows.slice(0, 5).forEach((r, idx) => {
        const item = document.createElement("li");
        item.className = "ucl-rank-item";
        item.innerHTML = `
          <div class="ucl-rank-num">${idx + 1}</div>
          <div class="ucl-rank-avatar">${idx + 1}</div>
          <div class="ucl-rank-info">
            <span class="addr">${shortAddr(r.address)}</span>
            <span class="val">${valueFormatter(r[valueKey], r)}</span>
          </div>
        `;
        el.appendChild(item);
      });
    };

    // Render main grid (UCL style)
    renderUCL("richList", data.rich || [], "totalWonBNB", (_, row) => `${Number(row.totalWonBNB || 0).toFixed(4)} BNB`);
    renderUCL("burnList", data.burn || [], "totalBurnedToken", (v) => `${fmtToken(v)} Token`);
    
    // Render drawer lists (Standard style)
    renderRankList("richList_drawer", data.rich || [], "totalWonBNB", (_, row) => `${Number(row.totalWonBNB || 0).toFixed(6)} BNB`);
    renderRankList("burnList_drawer", data.burn || [], "totalBurnedToken", (v) => `${fmtToken(v)} Token`);
    renderRankList("fortuneList", data.fortune || [], "fortunePoints", (v) => `${v} pts`);
    renderRankList("diamondList", data.diamond || [], "balanceToken", (v) => `${fmtToken(v)} Token`);

    lastRankLoadAt = Date.now();
    log(`榜单刷新完成，已统计 ${(data.counts?.players ?? 0)} 个地址`);
  } catch (e) {
    const errorMsg = '<li class="empty-state">排行榜服务暂不可用</li>';
    if ($("richList")) $("richList").innerHTML = errorMsg;
    if ($("burnList")) $("burnList").innerHTML = errorMsg;
    if ($("richList_drawer")) $("richList_drawer").innerHTML = errorMsg;
    if ($("burnList_drawer")) $("burnList_drawer").innerHTML = errorMsg;
    if ($("fortuneList")) $("fortuneList").innerHTML = errorMsg;
    if ($("diamondList")) $("diamondList").innerHTML = errorMsg;
    log(`榜单读取失败: ${humanizeError(e?.message || String(e))}`);
  } finally {
    rankLoadBusy = false;
  }
}


async function sendTx(fn, title) {
  try {
    setGlobalLoading(true, title, "请在钱包中确认操作...");
    const tx = await fn();
    setGlobalLoading(false);
    log(`${title} 已发送: ${tx.hash}`);
    log(`${title} 已提交到链上，正在等待确认，请勿重复点击。`);
    const rc = await tx.wait();
    log(`${title} 已确认: block ${rc.blockNumber}`);
    if (title === "提交誓约") {
      showSuccessToast("誓约成功", `你的CP组合已完成上链确认，区块 ${rc.blockNumber}`);
    } else if (title === "领取奖励" || title === "领取持币保底奖励") {
      showSuccessToast("领取成功", `奖励已到账并完成链上确认，区块 ${rc.blockNumber}`);
    }
    refresh().catch((err) => {
      log(`${title} 后台刷新失败: ${humanizeError(err?.shortMessage || err?.message || String(err))}`);
    });
    return rc;
  } catch (e) {
    setGlobalLoading(false);
    const rawMessage = e?.shortMessage || e?.message || String(e);
    const friendlyMsg = humanizeError(rawMessage);
    log(`${title} 失败: ${friendlyMsg}`);
    showAlert(friendlyMsg, `${title}失败`);
    if (isAmbiguousTxError(rawMessage)) {
      refresh().then(() => {
        log(`${title} 状态已重新同步，请确认本轮组合、累计消耗或链上交易记录；若同组合已被占用，通常表示上一笔已成功。`);
      }).catch(() => {});
    }
  }
}

async function ensureAttackAllowance() {
  if (!provider || !signer || !account || !vault) {
    throw new Error("请先连接钱包后再提交誓约");
  }

  const [taxToken, ticketPrice] = await Promise.all([
    vault.taxToken(),
    vault.TICKET_PRICE()
  ]);

  if (!taxToken || taxToken === ethers.ZeroAddress) {
    throw new Error("参赛代币尚未绑定");
  }

  const token = new ethers.Contract(taxToken, ERC20_ABI, signer);
  const allowance = await token.allowance(account, CONFIG.vaultAddress);
  if (allowance >= ticketPrice) return;

  const approveAmount = ticketPrice * 5n;
  log(`检测到授权不足，正在先授权 ${fmtToken(approveAmount)} Token...`);
  if (!sessionStorage.getItem("dongyouji-approve-tip")) {
    sessionStorage.setItem("dongyouji-approve-tip", "1");
    await showAlert("首次誓约可能需要两次确认：先授权参赛代币，再提交组合交易。完成第一次确认后，请返回钱包继续完成第二次确认。", "誓约提示");
  }
  setGlobalLoading(true, "授权代币", "请在钱包中确认授权请求；首次誓约可能需要完成两次确认。");
  try {
    const tx = await token.approve(CONFIG.vaultAddress, approveAmount);
    setGlobalLoading(false);
    log(`参赛代币授权已发送: ${tx.hash}`);
    log(`参赛代币授权已提交到链上，正在等待确认，请勿重复点击。`);
    const rc = await tx.wait();
    log(`参赛代币授权已确认: block ${rc.blockNumber}`);
  } catch (e) {
    setGlobalLoading(false);
    throw e;
  }
}


resetDashboard();
setPageView("home");
initReadOnlyContext();
loadPublicData();
loadRanks();
loadLiveFeed();
restoreAuthorizedConnection().catch(() => {});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  loadPublicData().catch(() => {});
  loadLiveFeed().catch(() => {});
  if (account && vault) refresh().catch(() => {});
});
document.querySelectorAll('.rank-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchRankTab(btn.dataset.tab));
  });

  $("btnConnect").onclick = connect;
$("btnOpenPersonal")?.addEventListener("click", () => setDrawerOpen("personalDrawer", true));
$("btnClosePersonal")?.addEventListener("click", () => setDrawerOpen("personalDrawer", false));
$("personalBackdrop")?.addEventListener("click", () => setDrawerOpen("personalDrawer", false));

$("btnOpenRules")?.addEventListener("click", () => setDrawerOpen("rulesDrawer", true));
$("btnCloseRules")?.addEventListener("click", () => setDrawerOpen("rulesDrawer", false));
$("rulesBackdrop")?.addEventListener("click", () => setDrawerOpen("rulesDrawer", false));

$("navHome")?.addEventListener("click", () => setPageView("home"));
$("navStory")?.addEventListener("click", () => {
  setPageView("home");
  setTimeout(() => scrollToBlock("storySection"), 40);
});
$("navMechanics")?.addEventListener("click", () => {
  setDrawerOpen("rewardDrawer", true);
});
$("btnCloseRewards")?.addEventListener("click", () => setDrawerOpen("rewardDrawer", false));
$("rewardBackdrop")?.addEventListener("click", () => setDrawerOpen("rewardDrawer", false));
$("btnRefreshRewards")?.addEventListener("click", async () => {
  if (account && vault) await refresh();
  else await loadPublicData();
});
function openMatchDrawer() {
  setDrawerOpen("matchDrawer", true);
  document.body.dataset.view = "play";
  renderAvatarPicker();
  setTimeout(() => $("firstAvatar")?.focus(), 40);
}
function closeMatchDrawer() {
  setDrawerOpen("matchDrawer", false);
  document.body.dataset.view = "home";
}
$("navPlay")?.addEventListener("click", openMatchDrawer);
$("btnHeroPlay")?.addEventListener("click", openMatchDrawer);
$("btnHomePlay")?.addEventListener("click", openMatchDrawer);
$("btnCloseMatch")?.addEventListener("click", closeMatchDrawer);
$("matchBackdrop")?.addEventListener("click", closeMatchDrawer);
$("btnHeroMechanics")?.addEventListener("click", () => scrollToBlock("mechanicsSection"));

$("btnOpenRanks")?.addEventListener("click", async () => {
  setDrawerOpen("rankDrawer", true, "rich");
  await loadRanks();
});
$("btnCloseRanks")?.addEventListener("click", () => setDrawerOpen("rankDrawer", false));
$("drawerBackdrop")?.addEventListener("click", () => setDrawerOpen("rankDrawer", false));
$("btnOpenHistory")?.addEventListener("click", () => setDrawerOpen("historyDrawer", true));
$("btnOpenHistoryFromMatch")?.addEventListener("click", () => setDrawerOpen("historyDrawer", true));
$("btnCloseHistory")?.addEventListener("click", () => setDrawerOpen("historyDrawer", false));
$("historyBackdrop")?.addEventListener("click", () => setDrawerOpen("historyDrawer", false));
$("btnCloseParticipation")?.addEventListener("click", () => setDrawerOpen("participationDrawer", false));
$("participationBackdrop")?.addEventListener("click", () => setDrawerOpen("participationDrawer", false));

$("btnBind")?.addEventListener("click", async () => {
  await runButtonAction("btnBind", "绑定中...", async () => {
    const token = $("inputToken")?.value.trim();
    if (!ethers.isAddress(token)) return alert("请输入正确的代币地址");
    await sendTx(() => vault.bindTaxToken(token), "绑定参赛代币");
  });
});

$("btnBuy").onclick = async () => {
  const firstAvatar = $("firstAvatar").value;
  const secondAvatar = $("secondAvatar").value;
  if (firstAvatar === "" || secondAvatar === "") return alert("请选择两位心动嘉宾");
  if (firstAvatar === secondAvatar) return alert("必须选择两个不同头像");

  if (busyButtons.has("btnBuy")) return;
  setButtonLoading("btnBuy", true, "誓约提交中...");

  try {
    await ensureAttackAllowance();
    const receipt = await sendTx(() => vault.buyTicket(Number(firstAvatar), Number(secondAvatar)), "提交誓约");
    if (receipt) {
      registerPlayerToBackend(account).catch(() => {});
    }
  } catch (e) {
    log(`提交誓约失败: ${humanizeError(e.shortMessage || e.message)}`);
  } finally {
    setButtonLoading("btnBuy", false);
    setGlobalLoading(false);
    updateActionHints();
  }
};

async function triggerDrawAction(triggerId = "btnDraw") {
  await runButtonAction(triggerId, "开奖中...", async () => {
    await sendTx(() => vault.draw(), "本轮开奖");
  });
}

$("btnDraw")?.addEventListener("click", async () => {
  await triggerDrawAction("btnDraw");
});
$("btnTopDraw")?.addEventListener("click", async () => {
  const confirmed = await showConfirm("如果遇到网络卡顿或轮次未自动切换，你可以手动触发链上开奖/刷新。是否现在发起该操作？", "刷新轮次");
  if (confirmed) {
    await triggerDrawAction("btnTopDraw");
  }
});

$("btnClaimRelief")?.addEventListener("click", async () => {
  await runButtonAction("btnClaimRelief", "领取中...", async () => {
    if (!reliefPending || !vault) return;
    log(`[保底] 准备领取 Epoch ${reliefPending.epochId}，金额 ${fmtBNB(reliefPending.amountWei)}，proof 节点数 ${reliefPending.proof?.length || 0}`);
    await sendTx(
      () => vault.claimHolderRelief(reliefPending.epochId, reliefPending.amountWei, reliefPending.proof),
      "领取持币保底奖励"
    );
    $("btnClaimRelief").style.display = "none";
  });
});

async function claimReward() {
  await runButtonAction("btnClaim", "领取中...", async () => {
    await sendTx(() => vault.claim(), "领取奖励");
  });
}
$("btnClaim").onclick = claimReward;
$("btnClaimRewardModal")?.addEventListener("click", claimReward);

$("btnLoadRanks")?.addEventListener("click", () => loadRanks(true));
$("btnToggleParticipation")?.addEventListener("click", () => {
  renderParticipationInfo();
  setDrawerOpen("participationDrawer", true);
});
$("btnToggleHistory")?.addEventListener("click", () => {
  historyExpanded = !historyExpanded;
  renderHistory();
});

$("firstAvatar")?.addEventListener("change", updateAvatarPreview);
$("secondAvatar")?.addEventListener("change", updateAvatarPreview);
$("avatarGrid")?.addEventListener("click", (event) => {
  const tile = event.target.closest("[data-avatar-id]");
  if (!tile) return;
  handleAvatarPick(tile.dataset.avatarId);
});
$("clearFirstAvatar")?.addEventListener("click", () => {
  if ($("firstAvatar")) $("firstAvatar").value = "";
  updateAvatarPreview();
});
$("clearSecondAvatar")?.addEventListener("click", () => {
  if ($("secondAvatar")) $("secondAvatar").value = "";
  updateAvatarPreview();
});
if ($("firstAvatar")) $("firstAvatar").innerHTML = avatarOptionMarkup("请选择一号嘉宾");
if ($("secondAvatar")) $("secondAvatar").innerHTML = avatarOptionMarkup("请选择二号嘉宾");
updateAvatarPreview();
setInterval(async () => {
  try {
    await syncChainTime();
  } catch {}
  updateRoundStatus();
  updateActionHints();
}, 1000);

setInterval(async () => {
  try {
    await checkRoundTransitionAutoReload();
  } catch {}
}, 5000);

setInterval(() => {
  loadLiveFeed();
}, 8000);

setInterval(() => {
  loadLiveFeed();
}, 8000);

function bindWalletEvents() {
  const eth = getInjectedProvider();
  if (!eth || eth.__ysayBound) return;
  eth.__ysayBound = true;
  eth.on?.("accountsChanged", async (accounts) => {
    if (!accounts?.length) {
      account = null; signer = null; vault = null; $("btnConnect").textContent = "连接钱包";
      log("钱包已断开连接"); resetDashboard(); await loadPublicData(); return;
    }
    provider = new ethers.BrowserProvider(eth);
    account = accounts[0]; signer = await provider.getSigner(account);
    if (!CONFIG.vaultAddress) return $("btnConnect").textContent = shortAddr(account);
    vault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, signer);
    $("btnConnect").textContent = shortAddr(account); setEligibilityStatus("资格检测中...", "muted");
    await registerPlayerToBackend(account); await refresh();
  });
  eth.on?.("chainChanged", async () => {
    log("检测到钱包网络切换，正在刷新数据...");
    const accounts = await eth.request({ method: "eth_accounts" });
    if (!accounts?.length) { resetDashboard(); await loadPublicData(); return; }
    provider = new ethers.BrowserProvider(eth);
    account = accounts[0]; signer = await provider.getSigner(account);
    if (!CONFIG.vaultAddress) return;
    vault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, signer);
    await registerPlayerToBackend(account); await refresh();
  });
}
bindWalletEvents();
