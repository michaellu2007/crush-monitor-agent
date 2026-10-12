// 会话持久化：改存服务器磁盘（data/conversations/），关浏览器/清缓存均不丢。
import type { Message, Relation, LineResult, Overview } from "../shared/types";
import type { MemoryEvent } from "../shared/memory";
export type Trend = { at: string; value: number | null; count: number };
export type SavedConversation = {
  schema: 1;
  rubric: string;
  modelFingerprint?: string;
  messages: Message[];
  self: string;
  other: string;
  relation: Relation;
  lines: Record<string, LineResult>;
  events: Record<string, MemoryEvent>;
  overview: Overview | null;
  trend: Trend[];
  analyzedCount: number;
  completed: boolean;
  notes?: string;
  relationLabel?: string;
};
export type ConversationSummary = {
  id: string;
  other: string;
  relation: Relation;
  at: string;
  count: number;
  preview: string;
};

export async function loadConversation(
  id: string = "current",
): Promise<SavedConversation | undefined> {
  const r = await fetch("/api/conversations/" + encodeURIComponent(id));
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error("读取失败");
  return r.json();
}
export async function saveConversation(
  id: string,
  value: SavedConversation | null,
): Promise<void> {
  const r = await fetch("/api/conversations/" + encodeURIComponent(id), {
    method: value ? "PUT" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: value ? JSON.stringify(value) : undefined,
  });
  if (!r.ok) throw new Error("保存失败");
}
export async function listConversations(): Promise<ConversationSummary[]> {
  const r = await fetch("/api/conversations");
  if (!r.ok) throw new Error("读取失败");
  return (await r.json()).conversations;
}
export async function getLastConvId(): Promise<string | null> {
  try {
    const r = await fetch("/api/meta/last-conv");
    const j = await r.json();
    return j.lastConvId ?? null;
  } catch {
    return null;
  }
}
export async function setLastConvId(id: string): Promise<void> {
  try {
    await fetch("/api/meta/last-conv", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastConvId: id }),
    });
  } catch {
    /* 非关键 */
  }
}
// 一次性迁移：服务器还没有会话时，把浏览器 IndexedDB 里的旧记录搬过来。
export async function migrateFromIdb(): Promise<boolean> {
  try {
    const legacy = await readLegacyIdb();
    let moved = 0;
    let firstKey: string | null = null;
    for (const [id, rec] of Object.entries(legacy)) {
      if (!rec || rec.schema !== 1 || !rec.messages.length) continue;
      if (Object.keys(legacy).length > 60) break;
      // 逐条对比：本地更全才覆盖，避免用旧快照盖掉服务器上的新数据
      const remote = await loadConversation(id);
      if (remote && (remote.messages?.length ?? 0) >= rec.messages.length)
        continue;
      await saveConversation(id, rec);
      if (!firstKey) firstKey = id;
      moved++;
    }
    if (moved) {
      const last = await getLastConvId();
      if (!last) await setLastConvId(legacy["current"] ? "current" : firstKey!);
    }
    return moved > 0;
  } catch {
    return false;
  }
}
function readLegacyIdb(): Promise<Record<string, SavedConversation>> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("crush-monitor", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("workspace");
      req.onsuccess = () => {
        const tx = req.result.transaction("workspace");
        const vals = tx.objectStore("workspace").getAll();
        const keys = tx.objectStore("workspace").getAllKeys();
        tx.oncomplete = () => {
          const out: Record<string, SavedConversation> = {};
          keys.result.forEach((k, i) => (out[String(k)] = vals.result[i]));
          resolve(out);
        };
      };
      req.onerror = () => resolve({});
    } catch {
      resolve({});
    }
  });
}
