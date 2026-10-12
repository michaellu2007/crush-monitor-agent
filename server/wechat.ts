// WeChat record import: reads the decrypted db_storage produced by chatlog.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT =
  process.env.WX_DB_ROOT ?? "D:/crush-monitor-1.2.0/wechat-decrypted2/db_storage";
const SELF = "wxid_496mtppr3ug922";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function open(p: string) {
  if (!existsSync(p)) return null;
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch {
    return null;
  }
}
function msgDbPaths() {
  return [0, 1, 2, 3, 4]
    .map((i) => join(ROOT, "message", `message_${i}.db`))
    .filter((p) => existsSync(p));
}
function contactMap() {
  const db = open(join(ROOT, "contact", "contact.db"));
  if (!db) return new Map();
  const rows = db
    .prepare("SELECT username, nick_name, remark FROM contact")
    .all();
  db.close();
  return new Map(
    rows.map((c) => [
      String(c.username),
      String(c.remark || c.nick_name || c.username || ""),
    ]),
  );
}
// rowid -> user_name per shard, plus table name -> shards that hold it.
function scan() {
  const idMaps = new Map<string, Record<number, string>>();
  const tables = new Map<string, string[]>();
  for (const p of msgDbPaths()) {
    const db = open(p);
    if (!db) continue;
    const rows = db.prepare("SELECT rowid, user_name FROM Name2Id").all();
    idMaps.set(
      p,
      Object.fromEntries(rows.map((r) => [r.rowid, r.user_name])),
    );
    for (const t of db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'",
      )
      .all()) {
      tables.set(String(t.name), [...(tables.get(String(t.name)) ?? []), p]);
    }
    db.close();
  }
  return { idMaps, tables };
}
function userNameFor(tableName: string, idMaps: Map<string, Record<number, string>>) {
  const hash = tableName.slice(4);
  for (const map of idMaps.values())
    for (const un of Object.values(map)) if (md5(un) === hash) return un;
  for (const un of contactMap().keys()) if (md5(un) === hash) return un;
  return null;
}
export type ChatSummary = {
  user: string;
  name: string;
  count: number;
  last: string;
};
export function listChats(): ChatSummary[] {
  const { idMaps, tables } = scan();
  const names = contactMap();
  const out: ChatSummary[] = [];
  for (const [table, paths] of tables) {
    const un = userNameFor(table, idMaps);
    if (!un || un.endsWith("@chatroom")) continue;
    let count = 0,
      last = 0;
    for (const p of paths) {
      const db = open(p);
      if (!db) continue;
      const r = db
        .prepare(
          `SELECT COUNT(*) c, MAX(create_time) m FROM ${table}`,
        )
        .get();
      if (!r) continue;
      count += Number(r.c);
      last = Math.max(last, Number(r.m) || 0);
      db.close();
    }
    out.push({
      user: un,
      name: un === SELF ? "我（本机账号）" : (names.get(un) ?? un),
      count,
      last: last
        ? new Date(last * 1000).toLocaleDateString("zh-CN")
        : "",
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
// 微信自带文字表情 → Unicode emoji（显示与语义分析通用）
const FACE_MAP: Record<string, string> = {
  微笑: "🙂", 撇嘴: "😣", 色: "😍", 发呆: "😐", 得意: "😎", 流泪: "😢",
  害羞: "😳", 闭嘴: "🤐", 睡: "😴", 大哭: "😭", 尴尬: "😅", 发怒: "😡",
  调皮: "😜", 呲牙: "😁", 惊讶: "😲", 难过: "🙁", 龇牙: "😁", 冷汗: "😰",
  抓狂: "🤯", 吐: "🤮", 偷笑: "🤭", 愉快: "☺️", 白眼: "🙄", 傲慢: "😤",
  困: "😪", 惊恐: "😱", 悠闲: "😌", 咒骂: "🤬", 疑问: "❓", 嘘: "🤫",
  晕: "😵", 衰: "😞", 骷髅: "💀", 敲打: "👊", 再见: "👋", 擦汗: "😓",
  鼓掌: "👏", 坏笑: "😏", 委屈: "🥺", 快哭了: "😥", 阴险: "😈", 亲亲: "😘",
  笑脸: "😄", 吃瓜: "🍉", 加油: "💪", Emm: "🤔", 旺柴: "🐕", OK: "👌",
  合十: "🙏", 握手: "🤝", 点赞: "👍", 拳头: "✊", 咖啡: "☕", 蛋糕: "🎂",
  玫瑰: "🌹", 心: "❤️", 破涕为笑: "😂", 脸红: "😳", 幽灵: "👻", 庆祝: "🎉",
  转圈: "🌀", 捂脸: "🤦", 翻白眼: "🙄", 右捂脸: "🤦", 左捂脸: "🤦", 哈欠: "🥱",
  猪头: "🐷", 拥抱: "🤗", 强: "💪", 弱: "😖", 饭: "🍚", 西瓜: "🍉",
};
const FACE_RE = /\[([一-龥A-Za-z]{1,6})\]/g;
export function decodeFaces(text: string): string {
  return text.replace(FACE_RE, (raw, name: string) => FACE_MAP[name] ?? raw);
}

export type ImportMessage = {
  sender: "self" | "other";
  text: string;
  timestamp: string;
};
export function getChat(user: string): ImportMessage[] {
  const { idMaps, tables } = scan();
  const table = "Msg_" + md5(user);
  const paths = tables.get(table) ?? [];
  const names = contactMap();
  const rows: {
    sender: "self" | "other";
    text: string;
    ts: number;
    local_id: number;
  }[] = [];
  const tag: Record<number, string> = {
    3: "[图片]",
    34: "[语音]",
    43: "[视频]",
    47: "[表情]",
    48: "[位置]",
    10002: "[撤回]",
  };
  for (const p of paths) {
    const db = open(p);
    if (!db) continue;
    const idMap = idMaps.get(p) ?? {};
    for (const r of db
      .prepare(
        `SELECT local_type, real_sender_id, create_time, local_id, message_content FROM ${table} ORDER BY sort_seq`,
      )
      .all()) {
      if (r.local_type === 10000) continue; // 系统消息
      const senderWx = idMap[Number(r.real_sender_id)] ?? "";
      const body =
        Number(r.local_type) === 1
          ? decodeFaces(String(r.message_content ?? ""))
          : (tag[Number(r.local_type)] ?? "");
      if (!body) continue;
      rows.push({
        sender: senderWx === SELF ? "self" : "other",
        text: body.trim(),
        ts: Number(r.create_time) || 0,
        local_id: Number(r.local_id),
      });
    }
    db.close();
  }
  rows.sort((a, b) => a.ts - b.ts || a.local_id - b.local_id);
  return rows.map((r) => {
    const id = md5(user + "|" + r.ts + "|" + r.local_id);
    const d = new Date(r.ts * 1000);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return {
      id,
      sender: r.sender,
      text: r.text,
      timestamp:
        r.ts > 0
          ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`
          : "",
    };
  });
}
// Re-run chatlog decrypt so newly received messages land in the snapshot.
// Key/dataDir come from wechat-import.json ({ "key", "dataDir" }) or env.
function importConfig() {
  try {
    const c = JSON.parse(readFileSync(join(process.cwd(), "wechat-import.json"), "utf8"));
    return { key: process.env.WX_KEY ?? c.key ?? "", dataDir: process.env.WX_DATA_DIR ?? c.dataDir ?? "" };
  } catch {
    return { key: process.env.WX_KEY ?? "", dataDir: process.env.WX_DATA_DIR ?? "" };
  }
}
export function refresh(): Promise<void> {
  const exe = join(process.cwd(), "chatlog.exe");
  if (!existsSync(exe)) return Promise.reject(new Error("chatlog.exe 不存在"));
  const { key, dataDir } = importConfig();
  if (!key || !dataDir)
    return Promise.reject(
      new Error("缺少解密配置：请在 wechat-import.json 中填写 key 和 dataDir。"),
    );
  const workDir = join(ROOT, "..", "..");
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      [
        "decrypt",
        "--data-dir", dataDir,
        "--data-key", key,
        "--platform", "windows",
        "--version", "4",
        "--work-dir", workDir,
      ],
      { timeout: 300000 },
      (err) => (err ? reject(new Error(String(err.message))) : resolve()),
    );
  });
}
