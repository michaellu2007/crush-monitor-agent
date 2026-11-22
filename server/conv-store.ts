// 会话数据落盘：data/conversations/<id>.json，浏览器关闭/清缓存均不受影响。
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, unlinkSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data", "conversations");
const TRASH_DIR = join(process.cwd(), "data", "trash");
const META_FILE = join(process.cwd(), "data", "meta.json");

export function initStorage() {
  mkdirSync(DATA_DIR, { recursive: true });
}
const file = (id: string) => join(DATA_DIR, encodeURIComponent(id) + ".json");

export function readConversation(id: string): unknown | undefined {
  if (!existsSync(file(id))) return undefined;
  try {
    return JSON.parse(readFileSync(file(id), "utf8"));
  } catch {
    return undefined;
  }
}
export function writeConversation(id: string, value: unknown | null) {
  if (value === null) {
    // 删除进回收站（data/trash/，gitignore 内）：误删可手工找回，不自动清理
    if (existsSync(file(id))) {
      mkdirSync(TRASH_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const trashPath = join(TRASH_DIR, `${encodeURIComponent(id)}.${stamp}.json`);
      try {
        renameSync(file(id), trashPath);
      } catch {
        // 文件被占用（Windows 读写并发常见）rename 会失败——退回"先复制进回收站再删"，
        // 回收站兜底承诺不因并发失效（2026-11-19 bug 审查）
        copyFileSync(file(id), trashPath);
        unlinkSync(file(id));
      }
    }
    return;
  }
  // 原子写（与 adv-store 同模式）：先写临时文件再 rename——进程崩在半路不会留下
  // 截断 JSON（截断会让 readConversation 返回 undefined，会话从列表"消失"）
  // 自建目录：全新 clone / 直接调用的测试里 data/conversations 不存在（2026-11-21）
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file(id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, file(id));
}

/** PUT 合并写（2026-11-19 竞态修复）：前端全量快照可能落后于服务端——后台分析/同步
 * 刚写入的 lines/overview 不在浏览器内存里，直接覆盖会把分析结果抹掉。
 * 合并规则：消息列表以前端为准（删除/编辑要生效）；分析行按消息 id 取并集
 * （同 id 双方都有时前端优先，它是用户当前视图的最新分析）；overview 被前端
 * 显式带值才覆盖（后台刚算出的总览不被空快照清掉）。 */
export function mergeConversationWrite(id: string, incoming: unknown) {
  if (!incoming || typeof incoming !== "object") {
    writeConversation(id, (incoming as unknown) ?? null);
    return;
  }
  const existing = readConversation(id) as Record<string, unknown> | undefined;
  if (!existing || typeof existing !== "object") {
    writeConversation(id, incoming);
    return;
  }
  const inc = incoming as Record<string, unknown>;
  const messages = Array.isArray(inc.messages) ? inc.messages : [];
  const ids = new Set(messages.map((m) => String((m as any)?.id ?? "")));
  const merged: Record<string, unknown> = {
    ...inc,
    lines: { ...((existing.lines as object) ?? {}), ...((inc.lines as object) ?? {}) },
    overview: inc.overview ?? existing.overview ?? null,
  };
  // 前端删掉的消息，其分析行不残留（否则消息没了分析还在，重新导入会错配）
  if (merged.lines && typeof merged.lines === "object" && messages.length) {
    for (const k of Object.keys(merged.lines as object))
      if (!ids.has(k)) delete (merged.lines as Record<string, unknown>)[k];
  }
  if (merged.lines && typeof merged.lines === "object")
    merged.analyzedCount = Object.keys(merged.lines as object).length;
  writeConversation(id, merged);
}
export function listConversationIds(): string[] {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => decodeURIComponent(f.slice(0, -5)));
}
export function getLastConvId(): string | null {
  try {
    if (!existsSync(META_FILE)) return null;
    return JSON.parse(readFileSync(META_FILE, "utf8")).lastConvId ?? null;
  } catch {
    return null;
  }
}
export function setLastConvId(id: string) {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(META_FILE, JSON.stringify({ lastConvId: id }), "utf8");
}
