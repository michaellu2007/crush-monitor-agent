// 历史检索（RAG-lite）：node:sqlite FTS5 trigram 全文索引，覆盖会话全量消息
// （不只 UI 的 500 条窗口）。隐私硬约束：检索必须带 contact 参数，严格限定单联系人
// ——跨联系人内容永远不允许拼进同一份结果/上下文。
// 分词用 trigram（SQLite 3.34+，Node 22.12 内置的版本支持）：中文按子串匹配；
// 查询短于 3 字时 trigram 无 trigram 可命中，回退 LIKE（按联系人数据量级毫秒级）。
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { listConversationIds, readConversation } from "./conv-store";
import { createEmbedder, loadEmbedConfig } from "./embedding";

// ---------- RAG 二期：向量分片与 RRF 混合 ----------
// 每联系人一个分片 data/embeddings/<contactId>.json（{convId,msgId,sender,timestamp,text,vec}，
// 自包含免二次查库，原子写）；向量层开关 = .runtime/embed.json 存在与否，缺省行为与一期逐字一致。

export type ShardItem = {
  convId: string;
  msgId: string;
  sender: string;
  timestamp: string | null;
  text: string;
  vec: number[];
};

export function createVectorStore(dir: string) {
  const file = (cid: string) => join(dir, encodeURIComponent(cid) + ".json");
  return {
    readShard(contactId: string): ShardItem[] {
      if (!existsSync(file(contactId))) return [];
      try {
        return JSON.parse(readFileSync(file(contactId), "utf8")) as ShardItem[];
      } catch {
        return [];
      }
    },
    writeShard(contactId: string, items: ShardItem[]) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file(contactId)}.tmp`;
      writeFileSync(tmp, JSON.stringify(items), "utf8");
      renameSync(tmp, file(contactId));
    },
  };
}

/** 增量判定：只 embed 分片里没有的消息（纯函数可测）。 */
export function diffToEmbed(
  shard: ShardItem[],
  messages: IndexedMessage[],
): IndexedMessage[] {
  const have = new Set(shard.map((s) => s.msgId));
  return messages.filter((m) => !have.has(m.id) && String(m.text ?? "").trim());
}

/** RRF（reciprocal rank fusion, k=60）：多路排名融合，两路都命中的排最前。 */
export function rrfFuse(rankLists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of rankLists)
    list.forEach((id, i) =>
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)),
    );
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const EMBEDDINGS_DIR = join(process.cwd(), "data", "embeddings");

/** 混合检索：FTS 关键词路 + 向量语义路 → RRF 融合；无 embed 配置时=纯 FTS（一期行为）。 */
export async function hybridSearch(
  q: string,
  contactId: string,
  limit = 20,
): Promise<HistoryHit[]> {
  const d = getSearchDb();
  const fts = d.search(q, contactId, limit);
  const cfg = loadEmbedConfig();
  if (!cfg) return fts;
  try {
    const shard = createVectorStore(EMBEDDINGS_DIR).readShard(contactId);
    if (!shard.length) return fts;
    const qv = await createEmbedder(cfg).embed([q]);
    if (!qv || !qv[0]) return fts;
    const ranked = shard
      .map((s) => ({ id: s.msgId, cos: cosine(qv[0], s.vec) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, limit);
    const fused = rrfFuse([fts.map((h) => h.msgId), ranked.map((r) => r.id)]);
    const byId = new Map<string, HistoryHit>();
    for (const h of fts) byId.set(h.msgId, h);
    for (const s of shard)
      if (!byId.has(s.msgId))
        byId.set(s.msgId, {
          convId: s.convId,
          msgId: s.msgId,
          sender: s.sender,
          timestamp: s.timestamp,
          text: s.text,
        });
    return fused
      .map((id) => byId.get(id))
      .filter((h): h is HistoryHit => !!h)
      .slice(0, limit);
  } catch {
    return fts; // 向量路任何异常 → 降级纯 FTS
  }
}

export type HistoryHit = {
  convId: string;
  msgId: string;
  sender: string;
  timestamp: string | null;
  text: string;
};

export type IndexedMessage = {
  id: string;
  sender: string;
  text: string;
  timestamp: string | null;
};

export type SearchDb = {
  /** 重建单个会话的索引行（幂等），返回索引的消息数 */
  indexConversation(
    convId: string,
    contactId: string,
    messages: IndexedMessage[],
  ): number;
  /** 单联系人作用域检索；q<3 字走 LIKE 回退 */
  search(q: string, contactId: string, limit?: number): HistoryHit[];
  /** 删除会话的索引行与 meta（会话删除时连带清理，防已删内容仍可搜到） */
  deleteConversation(convId: string): void;
  lastMtime(convId: string): number | undefined;
  setMtime(convId: string, mtimeMs: number): void;
  close(): void;
};

export function createSearchDb(dbPath: string): SearchDb {
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(
      contact_id UNINDEXED, conv_id UNINDEXED, msg_id UNINDEXED,
      timestamp UNINDEXED, sender UNINDEXED, text, tokenize='trigram')`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS meta(conv_id TEXT PRIMARY KEY, mtime REAL)`,
  );
  const delByConv = db.prepare(`DELETE FROM history WHERE conv_id = ?`);
  const insert = db.prepare(
    `INSERT INTO history(contact_id, conv_id, msg_id, timestamp, sender, text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const setMtime = db.prepare(
    `INSERT INTO meta(conv_id, mtime) VALUES (?, ?)
     ON CONFLICT(conv_id) DO UPDATE SET mtime = excluded.mtime`,
  );
  const getMtime = db.prepare(
    `SELECT mtime FROM meta WHERE conv_id = ?`,
  );
  return {
    indexConversation(convId, contactId, messages) {
      delByConv.run(convId);
      let n = 0;
      for (const m of messages) {
        const text = String(m.text ?? "");
        if (!text.trim()) continue;
        insert.run(
          contactId,
          convId,
          String(m.id ?? ""),
          m.timestamp ?? null,
          String(m.sender ?? ""),
          text,
        );
        n++;
      }
      return n;
    },
    search(q, contactId, limit = 20) {
      const query = q.trim();
      if (!query || !contactId) return [];
      const cap = Math.min(50, Math.max(1, limit));
      if ([...query].length >= 3) {
        // 短语包裹（内部双引号翻倍）→ trigram 子串匹配；contact_id 作普通 WHERE
        const phrase = `"${query.replaceAll('"', '""')}"`;
        const rows = db
          .prepare(
            `SELECT conv_id, msg_id, sender, timestamp, text FROM history
             WHERE history MATCH ? AND contact_id = ? LIMIT ?`,
          )
          .all(phrase, contactId, cap);
        return rows.map(rowToHit);
      }
      // <3 字：LIKE 回退（转义 % _ \）
      const pattern =
        "%" + query.replaceAll(/[\\%_]/g, (c) => `\\${c}`) + "%";
      const rows = db
        .prepare(
          `SELECT conv_id, msg_id, sender, timestamp, text FROM history
           WHERE contact_id = ? AND text LIKE ? ESCAPE '\\' LIMIT ?`,
        )
        .all(contactId, pattern, cap);
      return rows.map(rowToHit);
    },
    lastMtime(convId) {
      const row = getMtime.get(convId) as { mtime: number } | undefined;
      return row?.mtime;
    },
    deleteConversation(convId) {
      db.prepare(`DELETE FROM history WHERE conv_id = ?`).run(convId);
      db.prepare(`DELETE FROM meta WHERE conv_id = ?`).run(convId);
    },
    setMtime(convId, mtimeMs) {
      setMtime.run(convId, mtimeMs);
    },
    close() {
      db.close();
    },
  };
}

function rowToHit(r: Record<string, unknown>): HistoryHit {
  return {
    convId: String(r.conv_id ?? ""),
    msgId: String(r.msg_id ?? ""),
    sender: String(r.sender ?? ""),
    timestamp: (r.timestamp as string | null) ?? null,
    text: String(r.text ?? ""),
  };
}

// ---------- 服务端单例（懒同步：会话文件 mtime 变了才重建该会话索引行） ----------
let singleton: SearchDb | null = null;

function convFile(id: string) {
  return join(
    process.cwd(),
    "data",
    "conversations",
    encodeURIComponent(id) + ".json",
  );
}

export function getSearchDb(): SearchDb {
  if (!singleton)
    singleton = createSearchDb(join(process.cwd(), "data", "history-index.db"));
  return singleton;
}

/** 懒同步：扫描会话文件 mtime，重建有变化的索引；embed 配置存在时增量更新向量分片。
 *  返回本轮重建的会话数。重入护栏：上一轮没跑完时直接跳过——每次搜索/工具调用都
 *  fire-and-forget 触发一轮，快速连续搜索会并发出多轮重复扫描（2026-11-19 bug 审查）。 */
let syncing = false;
export async function syncHistoryIndex(): Promise<number> {
  if (syncing) return 0;
  syncing = true;
  try {
    return await syncHistoryIndexInner();
  } finally {
    syncing = false;
  }
}

async function syncHistoryIndexInner(): Promise<number> {
  const d = getSearchDb();
  const embedCfg = loadEmbedConfig();
  let indexed = 0;
  for (const id of listConversationIds()) {
    // 每个会话前让出事件循环：本函数虽有 async 签名，但读文件/重建索引全是同步操作，
    // 不让出的话一次懒同步会把 /api/history/search 等请求堵到同步跑完为止。
    await new Promise((r) => setImmediate(r));
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(convFile(id)).mtimeMs;
    } catch {
      continue;
    }
    if (d.lastMtime(id) === mtimeMs) continue;
    const conv = readConversation(id) as
      | { schema?: number; contactId?: string; messages?: IndexedMessage[] }
      | undefined;
    if (!conv || conv.schema !== 1 || !Array.isArray(conv.messages)) continue;
    const contactId = conv.contactId || id;
    d.indexConversation(id, contactId, conv.messages);
    if (embedCfg) {
      try {
        const store = createVectorStore(EMBEDDINGS_DIR);
        const shard = store.readShard(contactId);
        const live = new Map(
          conv.messages
            .filter((m) => String(m.text ?? "").trim())
            .map((m) => [m.id, m]),
        );
        const kept = shard.filter((s) => live.has(s.msgId));
        const todo = diffToEmbed(kept, conv.messages);
        if (todo.length) {
          const vecs = await createEmbedder(embedCfg).embed(
            todo.map((m) => String(m.text)),
          );
          if (vecs) {
            todo.forEach((m, i) =>
              kept.push({
                convId: id,
                msgId: m.id,
                sender: String(m.sender ?? ""),
                timestamp: m.timestamp ?? null,
                text: String(m.text),
                vec: vecs[i],
              }),
            );
            store.writeShard(contactId, kept);
          }
        } else if (kept.length !== shard.length) {
          store.writeShard(contactId, kept); // 只清掉了已删除的消息
        }
      } catch {
        /* 向量同步失败不影响 FTS 索引 */
      }
    }
    d.setMtime(id, mtimeMs);
    indexed++;
  }
  return indexed;
}
