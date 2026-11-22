import type { LineResult, Message } from "./types";
import { parseTs } from "./segments";
import { aggregateValence } from "./valence";
import { chatWillingness } from "./willingness";
import { computeBaseline } from "./baseline";

/**
 * 主动预警规则：服务端后台定时（或手动「立即检查」）对每个会话跑一遍的确定性判断。
 * 全部复用感知层已有的本地计算（水位/意愿/基线/意图分布），零模型调用，不碰性能红线。
 * now 显式注入（毫秒）——任何时刻回放同一结论，测试不依赖真实时钟。
 *
 * 四条规则与依据：
 * - R1 连续冷淡：chatWillingness 低意愿连击（<0.35 连续 N 条）且会话级偏冷淡。
 *   低意愿本身按人校准（间隔惩罚走对方 P90 基线），爱发短消息的人不会被误报。
 * - R2 水位趋势回落：近 7 天净变化超阈值 且 近 7 天消息的边际影响均值仍为负——
 *   区分"振荡回落"（已反弹不报）与"趋势下跌"（开发主计划 H4；Rinaldi 振荡模型，
 *   见 docs/聊天策略知识库.md T-006），暧昧期的正常波动不报警。
 * - R3 邀约/提问悬空：最后一条 self 消息是邀约/试探邀约/提问（复用判官 intents），
 *   72h 无对方任何回应；line 缺 intents 时回退"文本以问号结尾"。
 * - R4 对方主动骤降：≥12h 开新会话的对方主动次数（与 baseline.ts 同口径），
 *   近 7 天 vs 前 7 天腰斩（docs/聊天策略知识库.md T-009：停止主动比单条冷淡更可靠）。
 *
 * 前置门槛：lines 为空（没跑过逐条分析）或 computeBaseline 不产出（对方文本 <20 条）
 * 时直接不预警——没数据不当信号。
 */

export type WatchRuleId =
  | "cooling_streak"
  | "valence_downtrend"
  | "invite_dangling"
  | "initiation_drop";

export type WatchAlert = {
  rule: WatchRuleId;
  title: string;
  detail: string;
};

/** 结构兼容 SavedConversation 的最小切片（shared 不依赖 src/storage）。 */
export type WatchConversation = {
  messages: Message[];
  lines: Record<string, LineResult>;
};

export const WATCH_PARAMS = {
  /** R1：连续低意愿条数门槛 */
  coolingStreakMin: 3,
  /** R2：趋势观察窗（天）与窗内最少消息数 */
  downtrendShortDays: 7,
  downtrendShortMinPoints: 3,
  /** R2：近 7 天水位变化低于该值才报警（0-100 刻度上的分数） */
  downtrendChange7d: -8,
  /** R3：悬空时长门槛（小时）与意图概率门槛 */
  inviteStaleHours: 72,
  inviteIntentP: 0.5,
  /** R4：主动骤降窗口（天）、前窗最少次数、骤降比例 */
  initiationWindowDays: 7,
  initiationPrevMin: 2,
  initiationDropRatio: 0.5,
  /** ≥12h 无消息算新会话（与 baseline.ts SESSION_GAP 同口径） */
  initiationSessionGapHours: 12,
} as const;

const RULE_TITLES: Record<WatchRuleId, string> = {
  cooling_streak: "对方连续冷淡",
  valence_downtrend: "好感水位趋势回落",
  invite_dangling: "邀约还没有回应",
  initiation_drop: "对方主动变少",
};


/** 运行时实际使用的参数形态（字面量常量的可写化）。 */
export type WatchParams = { -readonly [K in keyof typeof WATCH_PARAMS]: number };

/** 阈值覆盖（.runtime/watch-config.json 经 zod 校验后透传；缺省行为逐字不变）。 */
export type WatchParamsOverride = Partial<WatchParams>;

export function evaluateWatchRules(
  conv: WatchConversation,
  now: number,
  overrides: WatchParamsOverride = {},
): WatchAlert[] {
  const alerts: WatchAlert[] = [];
  if (!Object.keys(conv.lines).length) return alerts;
  if (computeBaseline(conv.messages) === null) return alerts;
  const P: WatchParams = { ...WATCH_PARAMS, ...overrides };
  evaluateCoolingStreak(conv, P, alerts);
  evaluateValenceDowntrend(conv, now, P, alerts);
  evaluateInviteDangling(conv, now, P, alerts);
  evaluateInitiationDrop(conv, now, P, alerts);
  return alerts;
}

/** R1 连续冷淡。 */
function evaluateCoolingStreak(
  conv: WatchConversation,
  P: WatchParams,
  alerts: WatchAlert[],
) {
  const w = chatWillingness(conv.messages, conv.lines);
  if (
    w.value !== null &&
    w.level === "cooling" &&
    w.lowStreak >= P.coolingStreakMin
  ) {
    alerts.push({
      rule: "cooling_streak",
      title: RULE_TITLES.cooling_streak,
      detail: `最近连续 ${w.lowStreak} 条低意愿回复，当前聊天意愿 ${w.value}（偏冷淡）。别急着追问，先看看是不是最近哪句话需要修复。`,
    });
  }
}

/** R2 水位趋势回落：近 7 天净降幅超阈值 + 近期消息边际影响仍在净拉低水位（趋势而非已反弹的振荡）。 */
function evaluateValenceDowntrend(
  conv: WatchConversation,
  now: number,
  P: WatchParams,
  alerts: WatchAlert[],
) {
  const curve = aggregateValence(conv.messages, conv.lines, { now });
  const shortMs = P.downtrendShortDays * 86400000;
  // 7 天窗口起点的水位 = 最后一个 ≥7 天前的点的累计水位；没有就数据不足、不判
  let levelAtWindowStart: number | null = null;
  let infSum = 0,
    infN = 0;
  for (const p of curve.points) {
    const ts = p.at === null ? null : parseTs(p.at);
    if (ts === null) continue;
    if (ts <= now - shortMs) levelAtWindowStart = p.level;
    const age = now - ts;
    if (age < 0 || age > shortMs) continue;
    infSum += p.influence;
    infN++;
  }
  // 注意不能用 summarizeValence 的 change7d：其锚点取"第一条 ≥7 天前的点"（长历史会话
  // 即全程起点），语义是"比历史起点"，不是"比 7 天前"。
  const drop7d =
    levelAtWindowStart === null ? null : Math.round((curve.level - levelAtWindowStart) * 10) / 10;
  if (
    infN < P.downtrendShortMinPoints ||
    drop7d === null ||
    drop7d > P.downtrendChange7d ||
    // 近 7 天的边际信号平均仍在往下压（若已在回升，说明是振荡回落，不报）
    infSum / infN >= 0
  )
    return;
  alerts.push({
    rule: "valence_downtrend",
    title: RULE_TITLES.valence_downtrend,
    detail: `水位较 ${P.downtrendShortDays} 天前下降 ${Math.abs(
      drop7d,
    )} 分，且近期消息仍在净拉低水位（${infN} 条）。先分辨是对方状态低谷还是与你有关，再决定要不要修复。`,
  });
}

/** R3 邀约/提问悬空：最后一条是我方消息且超时无对方回应。 */
function evaluateInviteDangling(
  conv: WatchConversation,
  now: number,
  P: WatchParams,
  alerts: WatchAlert[],
) {
  const last = conv.messages.at(-1);
  if (!last || last.sender !== "self") return;
  const ts = parseTs(last.timestamp ?? "");
  if (ts === null) return;
  if (now - ts < P.inviteStaleHours * 3600000) return;
  const intents = conv.lines[last.id]?.intents;
  let kind: "invite" | "ask" | null = null;
  if (intents && Object.keys(intents).length > 0) {
    const inviteP = Math.max(intents.invite ?? 0, intents.invite_hint ?? 0);
    const askP = intents.ask ?? 0;
    if (inviteP >= P.inviteIntentP) kind = "invite";
    else if (askP >= P.inviteIntentP) kind = "ask";
  } else if (/[?？]\s*$/.test(last.text.trim())) {
    // 旧会话没有意图分布：回退词面判断，只认问号结尾（宁漏勿错）
    kind = "ask";
  }
  if (!kind) return;
  const hours = Math.round((now - ts) / 3600000);
  const label = kind === "invite" ? "邀约" : "提问";
  alerts.push({
    rule: "invite_dangling",
    title: kind === "invite" ? RULE_TITLES.invite_dangling : "提问还没有回应",
    detail: `你最后发出的${label}已经 ${hours} 小时没有回应。${
      hours >= 7 * 24
        ? "可以换个由头轻触一次，别追问原来那句。"
        : "再等一等也完全可以，不用催。"
    }`,
  });
}

/** R4 对方主动骤降：≥12h 开新会话的对方主动次数近 7 天 vs 前 7 天。 */
function evaluateInitiationDrop(
  conv: WatchConversation,
  now: number,
  P: WatchParams,
  alerts: WatchAlert[],
) {
  const gapMs = P.initiationSessionGapHours * 3600000;
  const winMs = P.initiationWindowDays * 86400000;
  let recent = 0,
    prev = 0,
    prevTs: number | null = null;
  for (const m of conv.messages) {
    const t = parseTs(m.timestamp ?? "");
    if (t === null) continue;
    if (
      m.sender === "other" &&
      (prevTs === null || t - prevTs >= gapMs)
    ) {
      if (t >= now - winMs) recent++;
      else if (t >= now - 2 * winMs) prev++;
    }
    prevTs = t;
  }
  if (
    prev >= P.initiationPrevMin &&
    recent < prev * P.initiationDropRatio
  ) {
    alerts.push({
      rule: "initiation_drop",
      title: RULE_TITLES.initiation_drop,
      detail: `主动开聊：近 ${P.initiationWindowDays} 天 ${recent} 次，之前 ${P.initiationWindowDays} 天 ${prev} 次。先想想最近互动里有没有该修复的话，别急着加频试探。`,
    });
  }
}
