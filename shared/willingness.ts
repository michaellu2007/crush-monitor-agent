import type { LineResult, Message } from "./types";
import { parseTs } from "./segments";

/**
 * 聊天意愿：对方"想不想继续聊"的程度，从既有信号本地推导——
 * 意图接球强度为主体，情绪×指向做修正（不耐烦冲着外部事件 ≠ 不想和我聊），
 * 回复间隔做节奏修正：间隔先与对方自己的历史节奏（P90）比，超出个人常态才扣
 * （文献 C6：Jin & Peña 2010——焦虑型高频、回避型低频短回，节奏必须按人校准）。
 * 不新增模型问题，旧会话（无 targets）可追溯计算。
 */

const INTENT_WILLINGNESS: Record<string, number> = {
  // 强延续：主动递球
  ask: 0.95,
  invite: 0.95,
  flirt: 0.9,
  affection: 0.9,
  invite_hint: 0.85,
  continue: 0.85,
  interest: 0.85,
  joke: 0.8,
  // 中延续：接住但不一定递球
  care: 0.8,
  comfort: 0.8,
  praise: 0.8,
  ease: 0.75,
  share: 0.75,
  agree: 0.75,
  attention: 0.7,
  thanks: 0.7,
  answer: 0.7,
  inform: 0.7,
  opinion: 0.7,
  help: 0.75,
  advice: 0.7,
  validation: 0.65,
  clarify: 0.6,
  apologize: 0.6,
  explain: 0.55,
  comfort_seek: 0.55,
  vent: 0.5,
  // 弱延续：在说话但没有推进
  other: 0.5,
  unknown: 0.5,
  acknowledge: 0.4,
  change: 0.35,
  disagree: 0.3,
  // 收尾与拒绝
  close: 0.15,
  refuse: 0.05,
  boundary: 0.02,
};

/** 两条消息之间的间隔（毫秒），任一时间戳缺失返回 null。 */
export function gapMsBetween(
  prev: string | null,
  cur: string | null,
): number | null {
  const a = parseTs(prev ?? "");
  const b = parseTs(cur ?? "");
  return a !== null && b !== null ? b - a : null;
}

/** 消息级意愿（0..1）。line 缺意图分布时返回 null。
 *  baselineMs：对方自己历史回复间隔的 P90（由 chatWillingness 计算）——
 *  间隔惩罚按 max(0, 1 − baseline/gap) 阻尼：没超出个人常态几乎不扣，
 *  远超个人常态恢复绝对幅度。缺基线（历史不足）时退回绝对阈值。 */
export function messageWillingness(
  line: LineResult | undefined,
  gapMs: number | null,
  baselineMs?: number | null,
): number | null {
  const intents = line?.intents;
  if (!intents) return null;
  let base = 0;
  let total = 0;
  for (const [key, p] of Object.entries(intents)) {
    const w = INTENT_WILLINGNESS[key];
    if (w === undefined || !Number.isFinite(p) || p <= 0) continue;
    base += w * p;
    total += p;
  }
  if (total <= 0) return null;
  // 概率未覆盖满（unknown 等被模型省略）时按已覆盖部分归一
  let v = base / total;
  const neg =
    (line?.emotions?.annoyed || 0) +
    (line?.emotions?.angry || 0) +
    (line?.emotions?.disappointed || 0) +
    (line?.emotions?.sad || 0);
  const targets = line?.targets;
  if (targets && neg > 0) {
    // 冲我来：重罚；冲外部事件：只罚话题不罚关系；对方自己状态低落：轻微
    v -= neg * (targets.me || 0) * 0.45;
    v -= neg * (targets.external || 0) * 0.1;
    v -= neg * (targets.other_self || 0) * 0.05;
  }
  if (gapMs !== null) {
    const h = gapMs / 3600000;
    const abs = h >= 48 ? 0.2 : h >= 24 ? 0.12 : h >= 6 ? 0.06 : 0;
    if (abs > 0) {
      const damp =
        baselineMs && baselineMs > 0
          ? Math.max(0, 1 - baselineMs / gapMs)
          : 1;
      v -= abs * damp;
    }
  }
  return Math.min(1, Math.max(0, v));
}

export type ChatWillingness = {
  /** 0..100，null=最近对方消息没有可用的意图分布 */
  value: number | null;
  level: "engaged" | "neutral" | "cooling" | null;
  /** 最近连续低意愿（<35）的对方消息条数 */
  lowStreak: number;
  /** 最近一条负面情绪主要指向外部事件 → 建议先安慰而非退开 */
  comfortHint: boolean;
};

/** 最近序位法 P90；历史间隔不足 5 个返回 null（样本太少，退回绝对阈值）。 */
function replyP90(gaps: number[]): number | null {
  if (gaps.length < 5) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/** 会话级意愿：最近活跃期的对方消息，越新权重越高。 */
export function chatWillingness(
  messages: Message[],
  lines: Record<string, LineResult>,
): ChatWillingness {
  // 第一遍：对方每条回复的到达间隔（相对上一条任意消息）。
  // 基线只看该消息之前的历史间隔——当前间隔若是历史最长，不应自我吸收进 P90。
  const otherGaps: { msg: Message; gapMs: number | null }[] = [];
  let prevTs: number | null = null;
  for (const m of messages) {
    const ts = parseTs(m.timestamp);
    if (m.sender === "other") {
      otherGaps.push({
        msg: m,
        gapMs: ts !== null && prevTs !== null ? ts - prevTs : null,
      });
    }
    if (ts !== null) prevTs = ts;
  }
  const scored: { v: number; msg: Message }[] = [];
  const priorGaps: number[] = [];
  for (const { msg, gapMs } of otherGaps) {
    const v = messageWillingness(lines[msg.id], gapMs, replyP90(priorGaps));
    if (v !== null) scored.push({ v, msg });
    if (gapMs !== null) priorGaps.push(gapMs);
  }
  if (!scored.length)
    return { value: null, level: null, lowStreak: 0, comfortHint: false };
  const recent = scored.slice(-30);
  let weightSum = 0;
  let acc = 0;
  recent.forEach((s, i) => {
    const w = 0.6 + (0.4 * i) / Math.max(1, recent.length - 1);
    acc += s.v * w;
    weightSum += w;
  });
  const value = Math.round((acc / weightSum) * 100);
  let lowStreak = 0;
  for (let i = scored.length - 1; i >= 0 && scored[i].v < 0.35; i--) lowStreak++;
  const last = scored[scored.length - 1];
  const emotions = lines[last.msg.id]?.emotions || {};
  const negDominant =
    Math.max(
      emotions.annoyed || 0,
      emotions.angry || 0,
      emotions.disappointed || 0,
      emotions.sad || 0,
    ) >= 0.4;
  const comfortHint =
    negDominant && (lines[last.msg.id]?.targets?.external || 0) >= 0.5;
  const level: ChatWillingness["level"] =
    value >= 60 ? "engaged" : value >= 35 ? "neutral" : "cooling";
  return { value, level, lowStreak, comfortHint };
}

export const WILLINGNESS_LABELS: Record<
  NonNullable<ChatWillingness["level"]> | "low",
  string
> = {
  engaged: "愿意聊",
  neutral: "一般",
  cooling: "偏冷淡",
  low: "想收尾",
};
