import type { LineResult, Message } from "./types";
import { parseTs } from "./segments";

/**
 * 确定性聚合层：把逐条 judge 的情绪×指向分布聚合成一条 0-100 的"情绪水位"曲线。
 * 纯本地计算，零模型调用；旧会话可随时回放。
 *
 * 只聚合对方消息（sender=other）：水位跟踪的是对方的情绪状态，我方回复质量是另一条线。
 * 没有 targets 的旧会话按词面极性计入（"妈的吐槽外部"会被当负信号）——指向修正依赖
 * RUBRIC crush-2026-10-12.0 之后的 targets 数据，此处不做无据推断。
 *
 * 参数依据（情感文献参考.md A/F3/H 节，文献只定方向与数量级，具体值待本项目数据标定）：
 * - 半衰期 10 天：指数衰减 A(t)=A_event·2^(−t/10)（Verduyn & Lavrijsen 2015 定数量级）
 * - 负信号加权默认走前景理论价值函数 v(x)=−λ·(−x)^β（λ≈2.25、β≈0.88，Tversky & Kahneman
 *   1992；自带敏感度递减）；可切线性 1.5×（主计划初版参数，Baumeister 2001 只证"负>正"）
 * - 单条影响力上限 1 分（0-100 刻度），线性钳制防单条消息主导（Rozin & Royzman 污染机制）
 * - 指向修正（开发主计划第二节：词语极性 ≠ 关系信号）：负情绪指向外部事件 → 转为信任
 *   正信号（"妈的，国庆人太多"= 愿意向我吐槽）；指向我 → 按负权重放大；指向对方自己/
 *   无指向 → 大幅衰减
 */

/** 情绪 → 效价（Russell 1980 愉悦轴，-1..1），键与 shared/labels.ts EMOTIONS 同源。 */
const EMOTION_VALENCE: Record<string, number> = {
  happy: 0.9,
  caring: 0.7,
  shy: 0.6,
  teasing: 0.5,
  surprised: 0.2,
  calm: 0,
  confused: -0.1,
  annoyed: -0.6,
  disappointed: -0.7,
  sad: -0.8,
  angry: -0.95,
  unknown: 0,
};

export const VALENCE_PARAMS = {
  /** 衰减半衰期（天） */
  halfLifeDays: 10,
  /** 单条影响力上限（0-100 刻度上的分数） */
  maxInfluence: 1,
  /** 中性基线 */
  baseline: 50,
  /** 前景理论：正侧敏感度 α、负侧敏感度 β、损失厌恶 λ */
  prospect: { alpha: 0.88, beta: 0.88, lambda: 2.25 },
  /** 线性模式的负信号倍率（主计划初版参数） */
  linearNegativeWeight: 1.5,
  /** 指向外部事件的负情绪 → 转为该倍幅度的信任正信号 */
  trustGain: 0.5,
  /** 指向对方自己（自嘲/喊累）的负情绪衰减 */
  selfDamp: 0.3,
  /** 无指向（口头禅/感叹）的负情绪衰减 */
  generalDamp: 0.3,
} as const;

export type Weighting = "prospect" | "linear";

export type ValencePoint = {
  id: string;
  at: string | null;
  /** 指向修正后的效价（约 -2.3..1，负侧可超 -1 因为带权重） */
  valence: number;
  /** 衰减并钳制后对水位的实际影响（-maxInfluence..maxInfluence 分） */
  influence: number;
  /** 该条消息之后的累计水位（0-100） */
  level: number;
};

export type ValenceCurve = {
  /** 当前水位 0-100，中性为 50 */
  level: number;
  /** 按时间序的水位曲线（无时间戳的消息排在最后、不衰减） */
  points: ValencePoint[];
  /** 负信号清单（指向我 ≥0.5，或无 targets 时效价 ≤-0.5 的消息），供预警/顾问引用 */
  negatives: { id: string; at: string | null; valence: number }[];
};

/**
 * 曲线摘要：给顾问 prompt 用的压缩事实（token 廉价、零模型调用）。
 * 参考时刻取曲线里最新的可解析时间戳（与 aggregateValence 默认 now 一致，
 * 不用 Date.now()——同一会话任何时候摘要都相同，可回放、可测试）。
 */
export type ValenceSummary = {
  /** 当前水位 0-100 */
  level: number;
  /** 近 7 天水位变化（正=回升）；数据不足 7 天时 null，不编造 */
  change7d: number | null;
  /** 近 7 天负信号条数（无时间戳无法排除，宁多报） */
  negatives7d: number;
  /** 曲线点数（0 = 没有可聚合的情绪数据，调用方应省略摘要） */
  points: number;
};

export function summarizeValence(curve: ValenceCurve): ValenceSummary {
  const timed = curve.points
    .map((p) => ({ p, ts: p.at === null ? null : parseTs(p.at) }))
    .filter((x): x is { p: ValencePoint; ts: number } => x.ts !== null);
  const now = timed.reduce((max, x) => Math.max(max, x.ts), 0);
  let change7d: number | null = null;
  if (now > 0) {
    const cutoff = now - 7 * 86400000;
    const anchor = timed.find((x) => x.ts <= cutoff);
    // 有 7 天前的锚点才谈"近 7 天变化"，否则数据不足 → null
    if (anchor && curve.points.length > 1) change7d = round1(curve.level - anchor.p.level);
  }
  const negatives7d = curve.negatives.filter((n) => {
    if (!n.at) return true;
    const ts = parseTs(n.at);
    return ts === null || (now > 0 && ts >= now - 7 * 86400000);
  }).length;
  return {
    level: curve.level,
    change7d,
    negatives7d,
    points: curve.points.length,
  };
}

/** 效价 → 0-100 刻度上的分数（正负不对称由加权模式决定）。 */
function shape(valence: number, weighting: Weighting): number {
  const { prospect, linearNegativeWeight } = VALENCE_PARAMS;
  if (valence >= 0)
    return weighting === "prospect"
      ? Math.pow(valence, prospect.alpha)
      : valence;
  const mag = -valence;
  return weighting === "prospect"
    ? -prospect.lambda * Math.pow(mag, prospect.beta)
    : -linearNegativeWeight * mag;
}

/** 目标修正：负情绪按指向改写（正情绪不修正——开心不管指向谁都是正信号）。 */
function targetAdjusted(
  raw: number,
  targets: Record<string, number> | undefined,
): number {
  if (raw >= 0 || !targets) return raw;
  const mag = -raw;
  const me = targets.me ?? 0;
  const external = targets.external ?? 0;
  const self = targets.other_self ?? 0;
  const general = targets.general ?? 0;
  const { trustGain, selfDamp, generalDamp } = VALENCE_PARAMS;
  return mag * (external * trustGain) - mag * (me + self * selfDamp + general * generalDamp);
}

/**
 * 聚合对方情绪水位。opts.now 为衰减参考时刻（毫秒），默认取消息里最新的时间戳——
 * 显式传入可对同一会话做"如果现在是 X 时刻"的回放，也让测试 deterministic。
 */
export function aggregateValence(
  messages: Message[],
  lines: Record<string, LineResult>,
  opts: { now?: number; weighting?: Weighting } = {},
): ValenceCurve {
  const weighting = opts.weighting ?? "prospect";
  type Entry = {
    id: string;
    at: string | null;
    ts: number | null;
    valence: number;
    targetsMe: number;
    hasTargetsData: boolean;
    order: number;
  };
  const entries: Entry[] = [];
  let newest = 0;
  messages.forEach((m, order) => {
    if (m.sender !== "other" || m.kind !== "text") return;
    const emotions = lines[m.id]?.emotions;
    if (!emotions) return;
    let raw = 0;
    for (const [key, p] of Object.entries(emotions)) {
      const v = EMOTION_VALENCE[key];
      if (v === undefined || !Number.isFinite(p) || p <= 0) continue;
      raw += v * p;
    }
    const ts = parseTs(m.timestamp ?? "");
    if (ts !== null && ts > newest) newest = ts;
    if (Math.abs(raw) < 1e-9) return;
    const targets = lines[m.id]?.targets;
    entries.push({
      id: m.id,
      at: m.timestamp,
      ts,
      valence: targetAdjusted(raw, targets),
      targetsMe: targets?.me ?? 0,
      hasTargetsData: !!targets,
      order,
    });
  });
  const now = opts.now ?? newest;
  const halfLifeMs = VALENCE_PARAMS.halfLifeDays * 86400000;
  entries.sort((a, b) => {
    if (a.ts === null && b.ts === null) return a.order - b.order;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return a.ts - b.ts || a.order - b.order;
  });
  const points: ValencePoint[] = [];
  const negatives: ValenceCurve["negatives"] = [];
  let level: number = VALENCE_PARAMS.baseline;
  for (const e of entries) {
    const ageMs = e.ts === null ? 0 : Math.max(0, now - e.ts);
    const decay = Math.pow(2, -ageMs / halfLifeMs);
    const influence = clamp(
      shape(e.valence, weighting) * decay,
      -VALENCE_PARAMS.maxInfluence,
      VALENCE_PARAMS.maxInfluence,
    );
    level = clamp(level + influence, 0, 100);
    points.push({
      id: e.id,
      at: e.at,
      valence: round2(e.valence),
      influence: round2(influence),
      level: round1(level),
    });
    if (e.valence < 0 && (e.targetsMe >= 0.5 || (!e.hasTargetsData && e.valence <= -0.5)))
      negatives.push({ id: e.id, at: e.at, valence: round2(e.valence) });
  }
  return { level: round1(level), points, negatives };
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
