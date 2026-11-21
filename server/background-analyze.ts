// 服务端后台分析：把"分析联系人"从前端循环搬到服务端——
// UI 随便浏览/切换任何联系人，分析在服务器上自己跑完并落盘。
// 复用 shared/incremental 的任务编排 + server/analysis 的 analyze（判官配置不变，
// 性能红线同前：判官走 judge 节点，免费档 429 会退避重试后继续）。
// 每批写盘都"重读-合并-写回"：与同步 bat 的并发写不互相覆盖。
import { readConversation, writeConversation } from "./conv-store";
import { incrementalJobs, overviewJob } from "../shared/incremental";
import { analyze } from "./analysis";
import { judgeConfig, activeConfig } from "./model-config";
import type {
  AnalysisRequest,
  LineResult,
  Message,
  Overview,
  Relation,
  UserProfile,
} from "../shared/types";
import type { MemoryEvent } from "../shared/memory";

export type BackgroundJob = {
  convId: string;
  contactName: string;
  status: "running" | "done" | "error" | "cancelled";
  total: number;
  done: number;
  errors: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** 最近一次进度变化的时间（毫秒）——UI 据此显示"已等待 N 秒"，区分慢与卡死 */
  lastTickAt: number;
  /** 正在处理第几个任务（1 基） */
  current: number;
};

type RunningJob = BackgroundJob & {
  controller: AbortController;
  requests: AnalysisRequest[];
};

let job: RunningJob | null = null;

/** 当前任务快照（给 UI 轮询；不含内部句柄）。 */
export function getBackgroundJob(): BackgroundJob | null {
  if (!job) return null;
  const { controller: _c, requests: _r, ...rest } = job;
  return rest;
}

type ConvFile = {
  schema?: number;
  contactId?: string;
  other?: string;
  relation?: Relation;
  notes?: string;
  relationLabel?: string;
  userProfile?: UserProfile;
  messages: Message[];
  lines: Record<string, LineResult>;
  events: Record<string, MemoryEvent>;
  overview?: Overview | null;
  analyzedCount?: number;
};

function readConv(convId: string): ConvFile | null {
  const raw = readConversation(convId) as ConvFile | undefined;
  if (!raw || raw.schema !== 1 || !Array.isArray(raw.messages)) return null;
  return raw;
}

/** 重读磁盘 → 合并本批新增的 lines/overview → 写回（保住同步并发写的其他改动）。 */
function mergeAndWrite(
  convId: string,
  addedLines: Record<string, LineResult>,
  overview?: Overview,
): boolean {
  const cur = readConv(convId);
  if (!cur) return false;
  cur.lines = { ...cur.lines, ...addedLines };
  if (overview) cur.overview = overview;
  cur.analyzedCount = Object.keys(cur.lines).length;
  writeConversation(convId, cur);
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runJob(running: RunningJob) {
  const judge = judgeConfig() ?? activeConfig();
  let attempt = 0;
  for (let i = 0; i < running.requests.length; i++) {
    if (running.controller.signal.aborted) {
      running.status = "cancelled";
      running.finishedAt = new Date().toISOString();
      return;
    }
    const req = running.requests[i];
    running.current = i + 1;
    running.lastTickAt = Date.now();
    try {
      const result = await analyze(req, running.controller.signal, judge);
      const added = Object.fromEntries(
        (result.lines ?? []).map((l) => [l.id, l]),
      );
      const ok = mergeAndWrite(running.convId, added, result.overview);
      if (!ok) throw new Error("会话文件已被删除");
      running.done++;
      running.lastTickAt = Date.now();
      attempt = 0;
    } catch (e) {
      const status = (e as { status?: number }).status;
      const aborted =
        running.controller.signal.aborted || (e as Error).name === "AbortError";
      if (aborted) {
        running.status = "cancelled";
        running.finishedAt = new Date().toISOString();
        return;
      }
      // 免费档 429/5xx：退避后重试同一批（最多 3 次），仍失败计一个错误并继续
      if ((status === 429 || (status ?? 500) >= 500) && attempt < 3) {
        attempt++;
        i--;
        await sleep(10_000 * attempt);
        continue;
      }
      attempt = 0;
      running.errors++;
      running.done++;
    }
  }
  running.status = running.errors && !running.done ? "error" : "done";
  running.finishedAt = new Date().toISOString();
}

export type StartResult =
  | { ok: true; job: BackgroundJob }
  | { ok: false; error: string };

/**
 * 启动后台分析（同一时刻只允许一个任务；同会话重复请求返回当前进度）。
 * 默认只补未分析的新消息（增量）；forceAll=true 全量重跑（贵，慎用）。
 */
export function startBackgroundAnalyze(
  convId: string,
  forceAll = false,
): StartResult {
  if (job && job.status === "running") {
    if (job.convId === convId) {
      const { controller: _c, requests: _r, ...rest } = job;
      return { ok: true, job: rest };
    }
    return { ok: false, error: `已有后台任务在分析「${job.contactName}」` };
  }
  const conv = readConv(convId);
  if (!conv) return { ok: false, error: "找不到该会话" };
  const revision = conv.messages.length;
  const requests: AnalysisRequest[] = incrementalJobs(
    conv.messages,
    conv.relation ?? "crush",
    revision,
    conv.lines ?? {},
    conv.events ?? {},
    true, // 后台跑就是"补新"：最近活跃单元 + 最近 20 条重刷
    undefined,
    conv.userProfile,
    forceAll,
  );
  const overview = overviewJob(
    conv.messages,
    conv.relation ?? "crush",
    revision,
    conv.events ?? {},
    conv.notes,
    conv.relationLabel,
    conv.userProfile,
  );
  const requests_all = [...requests, overview];
  if (!requests_all.length) return { ok: false, error: "没有需要分析的新消息" };
  const running: RunningJob = {
    convId,
    contactName: conv.other ?? convId,
    status: "running",
    total: requests_all.length,
    done: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
    lastTickAt: Date.now(),
    current: 0,
    controller: new AbortController(),
    requests: requests_all,
  };
  job = running;
  void runJob(running).catch((e) => {
    running.status = "error";
    running.error = String((e as Error).message ?? e);
    running.finishedAt = new Date().toISOString();
  });
  const { controller: _c, requests: _r, ...rest } = running;
  return { ok: true, job: rest };
}

export function cancelBackgroundAnalyze(): boolean {
  if (!job || job.status !== "running") return false;
  job.controller.abort();
  return true;
}
