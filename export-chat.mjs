// Export WeChat 4.x decrypted messages to crush-monitor paste format.
// Usage:
//   node export-chat.mjs list
//   node export-chat.mjs all              -> chats/*.txt
//   node export-chat.mjs <md5表名或user_name> -> chats/<名字>.txt
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config"; // 直接用 node 跑，需自己加载 .env（见 .env.example）

const ROOT = process.env.WX_DB_ROOT || join(process.cwd(), "wechat-decrypted2", "db_storage");
const OUT = join(process.cwd(), "chats");
const SELF = process.env.WX_SELF_ID || ""; // 本机微信账号，配置在 .env，不入库
const md5 = (s) => createHash("md5").update(s).digest("hex");

const open = (p) => new DatabaseSync(p, { readOnly: true });

const contact = open(`${ROOT}/contact/contact.db`)
  .prepare("SELECT username, nick_name, remark FROM contact")
  .all();
const nameOf = new Map(
  contact.map((c) => [c.username, c.remark || c.nick_name || c.username]),
);

// rowid -> user_name maps and chat tables, one pass per db
const msgDbPaths = [0, 1, 2, 3, 4]
  .map((i) => `${ROOT}/message/message_${i}.db`)
  .filter((p) => exists(p));
function exists(p) {
  try {
    open(p).prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}
const idMaps = new Map(); // dbPath -> {rowid: user_name}
const tables = new Map(); // tableName -> { dbPaths: [] } — 同名表跨分库合并
for (const p of msgDbPaths) {
  const db = open(p);
  const rows = db.prepare("SELECT rowid, user_name FROM Name2Id").all();
  idMaps.set(p, Object.fromEntries(rows.map((r) => [r.rowid, r.user_name])));
  for (const t of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")
    .all()) {
    const e = tables.get(t.name) || { dbPaths: [] };
    e.dbPaths.push(p);
    tables.set(t.name, e);
  }
  db.close();
}

function displayName(userName) {
  if (userName === SELF) return "我";
  return nameOf.get(userName) || userName;
}

function fmtTime(unix) {
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TYPE_SKIP = new Set([10000]); // 系统消息
function typeTag(t) {
  return (
    { 3: "[图片]", 34: "[语音]", 43: "[视频]", 47: "[表情]", 48: "[位置]", 51: "", 10002: "[撤回]" }[t] ??
    "[消息]"
  );
}

function fetchRows(tableName, dbPaths) {
  const rows = [];
  for (const p of dbPaths) {
    const db = open(p);
    rows.push(
      ...db
        .prepare(
          `SELECT local_type, real_sender_id, create_time, local_id, message_content FROM ${tableName} ORDER BY sort_seq`,
        )
        .all()
        .map((r) => ({ ...r, dbPath: p })),
    );
    db.close();
  }
  return rows.sort((a, b) => a.create_time - b.create_time || a.local_id - b.local_id);
}

function chatSummary(name, { dbPaths }) {
  const rows = fetchRows(name, dbPaths);
  const last = [...rows].reverse().find((r) => r.local_type === 1);
  return {
    name,
    count: rows.length,
    first: rows[0]?.create_time,
    last: rows.at(-1)?.create_time,
    preview: last ? String(last.message_content ?? "").slice(0, 40).replace(/\n/g, " ") : "",
  };
}

function userNameForTable(tableName, dbPath) {
  // table name is Msg_<md5(user_name)>; match against every known user_name
  const hash = tableName.slice(4);
  for (const map of idMaps.values())
    for (const un of Object.values(map)) if (md5(un) === hash) return un;
  for (const un of nameOf.keys()) if (md5(un) === hash) return un;
  return null;
}

function exportChat(tableName, dbPaths, outFile) {
  const rows = fetchRows(tableName, dbPaths);
  const idMapFor = (p) => idMaps.get(p) || {};
  const lines = [];
  for (const r of rows) {
    if (TYPE_SKIP.has(r.local_type)) continue;
    const speaker = displayName(
      idMapFor(r.dbPath)[r.real_sender_id] || `id${r.real_sender_id}`,
    );
    const time = fmtTime(r.create_time);
    const body =
      r.local_type === 1
        ? String(r.message_content ?? "")
        : typeTag(r.local_type);
    if (!body) continue;
    lines.push(`${speaker}\n${time}\n${body.trim()}`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(outFile, lines.join("\n\n") + "\n", "utf8");
  return lines.length;
}

// ---- main ----
const cmd = process.argv[2] || "list";
const enriched = [];
for (const [name, { dbPaths }] of tables) {
  const un = userNameForTable(name, dbPaths[0]);
  if (!un) continue;
  if (un.endsWith("@chatroom")) continue; // 群聊跳过
  const s = chatSummary(name, { dbPaths });
  enriched.push({ table: name, dbPaths, userName: un, who: displayName(un), ...s });
}
enriched.sort((a, b) => (b.last || 0) - (a.last || 0));

if (cmd === "list") {
  for (const [i, c] of enriched.entries())
    console.log(
      `[${i}] ${c.who} | ${c.count}条 | 最后 ${fmtTime(c.last)} | ${c.preview}`,
    );
} else if (cmd === "all") {
  for (const c of enriched) {
    const safe = c.who.replace(/[\\/:*?"<>|]/g, "_");
    const n = exportChat(c.table, c.dbPaths, join(OUT, `${safe}.txt`));
    console.log(`${safe}.txt <- ${n}条`);
  }
} else {
  const c = enriched[Number(cmd)] ?? enriched.find((x) => x.userName === cmd || x.table === cmd);
  if (!c) {
    console.error("没找到这个聊天，先跑 node export-chat.mjs list");
    process.exit(1);
  }
  const safe = c.who.replace(/[\\/:*?"<>|]/g, "_");
  const n = exportChat(c.table, c.dbPaths, join(OUT, `${safe}.txt`));
  console.log(`${join(OUT, safe + ".txt")} <- ${n}条`);
}
