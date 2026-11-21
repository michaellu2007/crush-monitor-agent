// 顾问会话服务端存储（2026-11-18 归档版）：data/adv/<convId>.json。
// { current: 当前会话 | null, archived: 归档会话[]（新到旧，cap 10） }
// 取代 saved.adv——服务端磁盘比随聊天保存的快照可靠，且桌面/网页双入口共享同一份。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DialogSummary } from "../shared/types";

export type AdvSession = {
  title?: string; // 归档时用户命名（创建档案），空则回退首问展示
  log: { role: "user" | "assistant"; content: string; ts?: number }[];
  summary: DialogSummary | null;
  goal?: string;
  at: number;
  endedAt?: string;
};

// 落盘目录：默认数据根 data/adv；单测通过 setAdvDirForTests 指到临时目录，
// 避免测试读写生产 data/adv（测试进程崩溃会把测试文件留在真实数据里）
let DIR = process.env.CRUSH_ADV_DIR || join(process.cwd(), "data", "adv");
const ARCHIVE_CAP = 10;

const file = (convId: string) => join(DIR, encodeURIComponent(convId) + ".json");

/** 仅供单测：把落盘目录切到临时目录 */
export function setAdvDirForTests(dir: string): void {
  DIR = dir;
}
/** 仅供单测/诊断：当前落盘目录 */
export function getAdvDir(): string {
  return DIR;
}

function isSession(s: unknown): s is AdvSession {
  const x = s as AdvSession;
  return (
    !!x &&
    Array.isArray(x.log) &&
    x.log.every(
      (t) =>
        !!t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string",
    )
  );
}

export function loadAdv(convId: string): { current: AdvSession | null; archived: AdvSession[] } {
  if (!convId || convId.length > 120) return { current: null, archived: [] };
  if (!existsSync(file(convId))) return { current: null, archived: [] };
  try {
    const d = JSON.parse(readFileSync(file(convId), "utf8"));
    const out = {
      current: isSession(d.current) ? d.current : null,
      archived: Array.isArray(d.archived) ? d.archived.filter(isSession).slice(0, ARCHIVE_CAP) : [],
    };
    return out;
  } catch {
    return { current: null, archived: [] }; // 损坏回退空，下次保存修复
  }
}

function write(convId: string, store: { current: AdvSession | null; archived: AdvSession[] }) {
  mkdirSync(DIR, { recursive: true });
  const tmp = file(convId) + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 1), "utf8");
  renameSync(tmp, file(convId));
}

function normalize(s: AdvSession): AdvSession {
  const firstQ = (s.log ?? []).find((t) => t.role === "user")?.content ?? "";
  return {
    title: s.title?.trim().slice(0, 60) || firstQ.slice(0, 40) || undefined,
    log: (s.log ?? []).slice(-200), // 早期上下文已在摘要里，落盘留尾 200 轮足够回看
    summary: s.summary ?? null,
    goal: s.goal?.slice(0, 500) || undefined,
    at: s.at || Date.now(),
    endedAt: s.endedAt,
  };
}

export function saveCurrent(convId: string, current: AdvSession | null): void {
  if (!convId || convId.length > 120) return;
  const store = loadAdv(convId);
  store.current = current ? normalize(current) : null;
  write(convId, store);
}

/** 删除会话时连带清掉其顾问对话文件（当前+归档），防"已删会话仍能回看"（2026-11-19 bug 审查）。 */
export function deleteAdvFile(convId: string): void {
  if (!convId || convId.length > 120) return;
  try {
    if (existsSync(file(convId))) unlinkSync(file(convId));
  } catch {
    /* 被占用时跳过：下次删除同会话（已不存在）无副作用，文件随 trash 逻辑兜底 */
  }
}

/** 归档：把 current（或传入的会话）压入 archived 最前，超 10 条挤掉最旧；current 置空。 */
export function renameArchived(convId: string, index: number, title: string): boolean {
  if (!convId || convId.length > 120) return false;
  const store = loadAdv(convId);
  if (index < 0 || index >= store.archived.length) return false;
  store.archived[index] = {
    ...store.archived[index],
    title: title.trim().slice(0, 60) || store.archived[index].title,
  };
  write(convId, store);
  return true;
}

export function archiveCurrent(convId: string, session?: AdvSession): number {
  if (!convId || convId.length > 120) return 0;
  const store = loadAdv(convId);
  const toArchive = session ? normalize(session) : store.current;
  if (!toArchive || !toArchive.log.length) {
    store.current = null;
    write(convId, store);
    return store.archived.length;
  }
  store.archived = [
    { ...toArchive, endedAt: new Date().toISOString() },
    ...store.archived.filter((a) => a.at !== toArchive.at),
  ].slice(0, ARCHIVE_CAP);
  store.current = null;
  write(convId, store);
  return store.archived.length;
}
