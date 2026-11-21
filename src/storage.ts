// 会话持久化：改存服务器磁盘（data/conversations/），关浏览器/清缓存均不丢。
import type {
  Message,
  Relation,
  LineResult,
  Overview,
  UserProfile,
} from "../shared/types";
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
  userProfile?: UserProfile;
  relationLabel?: string;
  contactId?: string;
};
export type ConversationSummary = {
  id: string;
  other: string;
  contactId?: string;
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
