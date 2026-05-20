import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const backendRoot = path.resolve(projectRoot, "backend");
const dbPath = path.resolve(backendRoot, "data", "ranks.sqlite");

function pad(title) {
  console.log(`\n=== ${title} ===`);
}

function readAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function readOne(db, sql, params = []) {
  const rows = readAll(db, sql, params);
  return rows[0] ?? null;
}

function printRows(rows) {
  if (!rows.length) {
    console.log("无数据");
    return;
  }
  console.table(rows);
}

async function openDb() {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`数据库文件不存在: ${dbPath}`);
  }

  const SQL = await initSqlJs({
    locateFile(file) {
      return path.resolve(backendRoot, "node_modules", "sql.js", "dist", file);
    },
  });

  return new SQL.Database(fs.readFileSync(dbPath));
}

function normalizeAddress(address) {
  return String(address || "").trim();
}

function isLikelyAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function formatBNB(wei) {
  try {
    return `${(Number(BigInt(wei)) / 1e18).toFixed(8)} BNB`;
  } catch {
    return String(wei);
  }
}

function printUsage() {
  console.log(`用法:
  node .\\scripts\\inspect-db.mjs
  node .\\scripts\\inspect-db.mjs summary
  node .\\scripts\\inspect-db.mjs address 0x你的地址
  node .\\scripts\\inspect-db.mjs relief [epochId]
  node .\\scripts\\inspect-db.mjs sql "SELECT * FROM players LIMIT 10"
`);
}

async function main() {
  const db = await openDb();
  const [, , command = "summary", arg] = process.argv;

  if (command === "summary") {
    pad("数据库文件");
    console.log(dbPath);

    pad("数据表");
    const tables = readAll(
      db,
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
      `
    );
    printRows(tables);

    pad("各表行数");
    const counts = [];
    for (const { name } of tables) {
      const row = readOne(db, `SELECT COUNT(*) AS count FROM ${name}`);
      counts.push({ table: name, count: row?.count ?? 0 });
    }
    printRows(counts);

    pad("最新保底 Epoch");
    printRows(
      readAll(
        db,
        `
        SELECT epoch_id, pool_amount_wei, snapshot_block, triggered_at_ms, merkle_root, claim_deadline_ms, settled
        FROM holder_relief_epochs
        ORDER BY epoch_id DESC
        LIMIT 5
        `
      )
    );

    pad("最新实时动态");
    printRows(
      readAll(
        db,
        `
        SELECT id, type, title, created_at_ms
        FROM live_feed
        ORDER BY created_at_ms DESC
        LIMIT 10
        `
      )
    );

    pad("扫描状态");
    printRows(
      readAll(
        db,
        `
        SELECT key, value
        FROM scanner_state
        ORDER BY key
        `
      )
    );

    return;
  }

  if (command === "address") {
    const address = normalizeAddress(arg);
    if (!isLikelyAddress(address)) {
      throw new Error("请传入合法地址，例如: node .\\scripts\\inspect-db.mjs address 0x1234...");
    }

    pad("查询地址");
    console.log(address);

    pad("players");
    printRows(
      readAll(
        db,
        `
        SELECT address, first_seen_block, last_seen_block, buy_count, is_contract
        FROM players
        WHERE lower(address) = lower(?)
        `,
        [address]
      )
    );

    pad("player_stats_cache");
    printRows(
      readAll(
        db,
        `
        SELECT address, total_won_bnb_wei, total_burned_token, fortune_points, claimable_bnb_wei, balance_token, updated_at_ms
        FROM player_stats_cache
        WHERE lower(address) = lower(?)
        `,
        [address]
      )
    );

    pad("token_holders");
    printRows(
      readAll(
        db,
        `
        SELECT address, balance_wei, last_updated_block, first_seen_block
        FROM token_holders
        WHERE lower(address) = lower(?)
        `,
        [address]
      )
    );

    pad("relief_claims");
    printRows(
      readAll(
        db,
        `
        SELECT epoch_id, address, amount_wei
        FROM relief_claims
        WHERE lower(address) = lower(?)
        ORDER BY epoch_id DESC
        `,
        [address]
      )
    );

    return;
  }

  if (command === "relief") {
    const epochId = String(arg || "").trim();
    const latest = readOne(db, `SELECT epoch_id FROM holder_relief_epochs ORDER BY epoch_id DESC LIMIT 1`);
    const targetEpoch = epochId || String(latest?.epoch_id || "");
    if (!targetEpoch) {
      throw new Error("当前没有保底 Epoch 数据");
    }

    pad(`保底 Epoch ${targetEpoch}`);
    printRows(readAll(db, `SELECT epoch_id, pool_amount_wei, snapshot_block, triggered_at_ms, merkle_root, claim_deadline_ms, settled FROM holder_relief_epochs WHERE epoch_id = ?`, [targetEpoch]));

    const claims = readAll(
      db,
      `SELECT epoch_id, address, amount_wei FROM relief_claims WHERE epoch_id = ? ORDER BY CAST(amount_wei AS NUMERIC) DESC`,
      [targetEpoch]
    ).map((row) => ({
      ...row,
      amount_bnb: formatBNB(row.amount_wei),
    }));

    pad(`Epoch ${targetEpoch} 分配明细`);
    printRows(claims);
    return;
  }

  if (command === "sql") {
    const sql = String(arg || "").trim();
    if (!sql) {
      throw new Error('请传 SQL，例如: node .\\scripts\\inspect-db.mjs sql "SELECT * FROM players LIMIT 10"');
    }

    pad("自定义 SQL");
    console.log(sql);
    printRows(readAll(db, sql));
    return;
  }

  printUsage();
}

main().catch((err) => {
  console.error(`\n[inspect-db] ${err.message}`);
  process.exitCode = 1;
});