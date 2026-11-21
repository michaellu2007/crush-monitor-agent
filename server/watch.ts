// 主动预警调度器：后台定时（或手动 POST /api/alerts/check）检查所有会话，
// 跑 shared/watch-rules 的确定性规则，落 data/alerts.json + data/watch.json。
// 零模型调用：只读磁盘上已有的 messages+lines，复用感知层的计算结果。
// 同一会话同一规则 24 小时冷却（手动检查同样遵守），防止轰炸；
// mtime 没变的会话跳过重评。数据文件全部原子写（tmp+rename，照 model-config.ts）。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { listConversationIds, readConversation } from "./conv-store";
import {
  evaluateWatchRules,
  type WatchAlert,
  type WatchConversation,
  type WatchParamsOverride,
} from "../shared/watch-rules";

// .runtime/watch-config.json：预警阈值覆盖（zod strict，范围钳制；文件缺失/非法=默认值）
const watchConfigSchema = z
  .object({
    coolingStreakMin: z.number().int().min(1).max(20).optional(),
    downtrendShortDays: z.number().int().min(2).max(60).optional(),
    downtrendShortMinPoints: z.number().int().min(1).max(200).optional(),
    downtrendChange7d: z.number().min(-100).max(0).optional(),
    inviteStaleHours: z.number().int().min(1).max(720).optional(),
    inviteIntentP: z.number().min(0.1).max(1).optional(),
    initiationWindowDays: z.number().int().min(2).max(90).optional(),
    initiationPrevMin: z.number().int().min(1).max(50).optional(),
    initiationDropRatio: z.number().min(0.1).max(1).optional(),
    initiationSessionGapHours: z.number().int().min(1).max(168).optional(),
  })
  .strict();

const WATCH_CONFIG_FILE = join(process.cwd(), ".runtime", "watch-config.json");

export function loadWatchOverrides(): WatchParamsOverride {
  if (!existsSync(WATCH_CONFIG_FILE)) return {};
  try {
    const parsed = watchConfigSchema.parse(
      JSON.parse(readFileSync(WATCH_CONFIG_FILE, "utf8")),
    );
    return parsed as WatchParamsOverride;
  } catch {
    return {};
  }
}

const DATA_DIR = join(process.cwd(), "data");
const CONV_DIR = join(DATA_DIR, "conversations");
const ALERTS_FILE = join(DATA_DIR, "alerts.json");
const WATCH_FILE = join(DATA_DIR, "watch.json");

export type StoredAlert = {
  id: string;
  convId: string;
  rule: WatchAlert["rule"];
  title: string;
  detail: string;
  /** ISO 时间 */
  at: string;
  acked: boolean;
};

type WatchState = {
  lastCheckAt: number | null;
  /** 会话文件 mtime 缓存：没变的会话本轮跳过 */
  convMtime: Record<string, number>;
  /** "<convId>:<rule>" → 上次报警时刻（ms），24h 冷却依据 */
  lastAlertAt: Record<string, number>;
};

const ALERT_CAP = 100;
export const COOLDOWN_MS = 24 * 3600_000;
const CHECK_INTERVAL_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 30_000;

const emptyState = (): WatchState => ({
  lastCheckAt: null,
  convMtime: {},
  lastAlertAt: {},
});

function loadJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function saveJson(file: string, value: unknown) {
  mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value), "utf8");
  renameSync(temp, file);
}

/** 冷却过滤：同会话同规则 24h 内只报一次（纯函数，供单测）。 */
export function filterCooldown(
  convId: string,
  alerts: WatchAlert[],
  lastAlertAt: Record<string, number>,
  now: number,
  cooldownMs: number = COOLDOWN_MS,
): WatchAlert[] {
  return alerts.filter((a) => {
    const last = lastAlertAt[`${convId}:${a.rule}`];
    return last === undefined || now - last >= cooldownMs;
  });
}

/**
 * 跑一轮检查。force=true 忽略 mtime 缓存重评全部会话（手动「立即检查」用）；
 * 冷却始终生效。返回本轮实际评估的会话数与新增预警数。
 */
export function runWatchCycle(
  opts: { force?: boolean; now?: number } = {},
): { checked: number; added: number } {
  const now = opts.now ?? Date.now();
  const state = loadJson<WatchState>(WATCH_FILE, emptyState());
  const store = loadJson<{ alerts: StoredAlert[] }>(ALERTS_FILE, {
    alerts: [],
  });
  const overrides = loadWatchOverrides();
  let checked = 0;
  let added = 0;
  for (const id of listConversationIds()) {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(CONV_DIR, encodeURIComponent(id) + ".json"))
        .mtimeMs;
    } catch {
      continue;
    }
    if (!opts.force && state.convMtime[id] === mtimeMs) continue;
    const raw = readConversation(id) as
      | (WatchConversation & { schema?: number })
      | undefined;
    if (!raw || raw.schema !== 1 || !Array.isArray(raw.messages)) continue;
    checked++;
    const fired = filterCooldown(
      id,
      evaluateWatchRules(
        { messages: raw.messages, lines: raw.lines ?? {} },
        now,
        overrides,
      ),
      state.lastAlertAt,
      now,
    );
    for (const a of fired) {
      store.alerts.unshift({
        id: randomUUID(),
        convId: id,
        rule: a.rule,
        title: a.title,
        detail: a.detail,
        at: new Date(now).toISOString(),
        acked: false,
      });
      state.lastAlertAt[`${id}:${a.rule}`] = now;
      added++;
    }
    state.convMtime[id] = mtimeMs;
  }
  if (store.alerts.length > ALERT_CAP) {
    // 超上限：未读优先保留，已读的挤掉最旧
    const unread = store.alerts.filter((a) => !a.acked);
    const acked = store.alerts.filter((a) => a.acked);
    store.alerts = [...unread, ...acked].slice(0, ALERT_CAP);
  }
  state.lastCheckAt = now;
  saveJson(WATCH_FILE, state);
  saveJson(ALERTS_FILE, store);
  return { checked, added };
}

export function readAlerts(): {
  alerts: StoredAlert[];
  unread: number;
  lastCheckAt: number | null;
} {
  const store = loadJson<{ alerts: StoredAlert[] }>(ALERTS_FILE, {
    alerts: [],
  });
  const state = loadJson<WatchState>(WATCH_FILE, emptyState());
  const alerts = [...store.alerts].sort((a, b) => b.at.localeCompare(a.at));
  return {
    alerts,
    unread: alerts.filter((a) => !a.acked).length,
    lastCheckAt: state.lastCheckAt,
  };
}

export function ackAlerts(ids?: string[]): number {
  const store = loadJson<{ alerts: StoredAlert[] }>(ALERTS_FILE, {
    alerts: [],
  });
  let n = 0;
  for (const a of store.alerts) {
    if (ids !== undefined && !ids.includes(a.id)) continue;
    if (!a.acked) n++;
    a.acked = true;
  }
  saveJson(ALERTS_FILE, store);
  return n;
}

// ---------- 后台循环 ----------
let timer: ReturnType<typeof setInterval> | null = null;

function safeRun() {
  try {
    const r = runWatchCycle();
    if (r.added > 0)
      console.log(
        `[watch] 新增 ${r.added} 条预警（本轮评估 ${r.checked} 个会话）`,
      );
  } catch (e) {
    console.error("[watch] 检查失败:", (e as Error).message);
  }
}

/** 服务启动后调用；CRUSH_WATCH=0 关闭，CRUSH_WATCH_INTERVAL_MS 调整间隔（测试用）。 */
export function startWatch() {
  if (process.env.CRUSH_WATCH === "0") return;
  const interval = Math.max(
    10_000,
    Number(process.env.CRUSH_WATCH_INTERVAL_MS) || CHECK_INTERVAL_MS,
  );
  setTimeout(safeRun, FIRST_RUN_DELAY_MS).unref();
  timer = setInterval(safeRun, interval);
  timer.unref();
}

