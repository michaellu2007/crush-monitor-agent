// 模型工具能力自适应缓存（2026-11-05）：记录哪些 (供应商, 模型) 不支持
// function calling。硅基流动 /models 只回 id 不含能力字段，"查询式"不可行；
// 改为学习式——advisor 工具循环首轮 4xx（非 401）且去 tools 重试成功 → 记
// 负样本原子落盘，此后对该模型直接单发，不再每次先打一发注定 400 的请求。
// 换模型自动重新适应，零硬编码；文件在 .runtime（含运行态，不入库）。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const DEFAULT_FILE = ".runtime/tool-support.json";
let file = DEFAULT_FILE;
const mem = new Map<string, boolean>();

function load() {
  if (mem.size) return;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw))
      if (typeof v === "boolean") mem.set(k, v);
  } catch {
    /* 首次无文件 / 损坏：按全支持处理 */
  }
}

/** (端点 origin | 模型) → 能力键。origin 跨协议路径稳定（/chat/completions vs /messages）。 */
export function capKey(endpoint: string, model: string): string {
  return `${new URL(endpoint).origin}|${model}`;
}

export function toolsKnownUnsupported(endpoint: string, model: string): boolean {
  load();
  return mem.get(capKey(endpoint, model)) === false;
}

/** 原子落盘；失败只影响本次记忆不抛——主流程不能被缓存写挂。 */
export function markToolsUnsupported(endpoint: string, model: string): void {
  load();
  mem.set(capKey(endpoint, model), false);
  try {
    mkdirSync(".runtime", { recursive: true });
    const tmp = file + "." + randomUUID() + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(mem)), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, file);
  } catch {
    /* 写盘失败退化为进程内记忆 */
  }
}

/** 测试隔离：换文件 + 清内存。 */
export function resetToolSupportForTest(path = DEFAULT_FILE): void {
  file = path;
  mem.clear();
}
