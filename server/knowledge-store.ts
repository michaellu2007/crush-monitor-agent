// 用户自配知识库存储（2026-11-18）：data/knowledge.json，顾问 search_knowledge 工具的数据源。
// 钳制条数/长度防失控（50 条 × 内容 2000 字）；原子写（tmp+rename）；损坏回退空库不抛。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { KnowledgeEntry } from "../shared/types";

const FILE = join(process.cwd(), "data", "knowledge.json");
export const KNOWLEDGE_LIMITS = {
  entries: 50,
  title: 60,
  content: 2000,
};

function isEntry(e: unknown): e is KnowledgeEntry {
  const k = e as KnowledgeEntry;
  return (
    !!k &&
    typeof k.id === "string" &&
    typeof k.title === "string" &&
    typeof k.content === "string"
  );
}

export function loadKnowledge(): KnowledgeEntry[] {
  if (!existsSync(FILE)) return [];
  try {
    const arr = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(arr)) return [];
    return arr.filter(isEntry).slice(0, KNOWLEDGE_LIMITS.entries);
  } catch {
    return []; // 损坏/半截 JSON：空库起步，下次保存即修复
  }
}

export function saveKnowledge(list: unknown[]): KnowledgeEntry[] {
  const clean: KnowledgeEntry[] = list
    .filter(isEntry)
    .slice(0, KNOWLEDGE_LIMITS.entries)
    .map((e) => ({
      id: e.id.trim() || randomUUID().slice(0, 8),
      title: e.title.trim().slice(0, KNOWLEDGE_LIMITS.title),
      content: e.content.trim().slice(0, KNOWLEDGE_LIMITS.content),
      updatedAt: e.updatedAt || new Date().toISOString(),
    }))
    .filter((e) => e.title || e.content); // 全空条目丢弃
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(clean, null, 1), "utf8");
  renameSync(tmp, FILE);
  return clean;
}

/** 关键词检索：词命中计分（标题命中×2），top-limit；无词/无命中返回空。 */
export function searchKnowledge(q: string, limit = 3): KnowledgeEntry[] {
  const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  return loadKnowledge()
    .map((e) => {
      const hay = e.title + "\n" + e.content;
      const score = terms.reduce(
        (n, t) => n + (hay.includes(t) ? (e.title.includes(t) ? 2 : 1) : 0),
        0,
      );
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}
