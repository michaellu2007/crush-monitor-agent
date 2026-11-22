/**
 * 闭环校准（任务单 F v0）：决策树"预测 vs 实际"的数据结构与判定逻辑。
 * 管道：树节点标记「实际发出」→ 记 data/calibration.json → 对方新回复经逐条分析后
 * 出现 → 判定纯函数 judgeOutcome 给出预填（接住了/没接/证据不足）→ 用户确认后落定。
 * 诚实边界：判定是预填不是金标；样本 <5 不出校准率（宁少报）。
 */

export type CalibrationOutcome = "caught" | "missed";

export type CalibrationRecord = {
  id: string;
  convId: string;
  intent: string;
  draft: string;
  actionIndex: number;
  /** 判官预测的接球概率（0-1），判官不可用时 null */
  catchProbability: number | null;
  /** ISO 时间 */
  at: string;
  /** null = 待确认（对方还没回或还没对账） */
  outcome: CalibrationOutcome | null;
  evidenceMsgId?: string;
};

/** 接球类意图（延续/接住话题的候选键，与 willingness 口径同源）。 */
const CAUGHT_INTENTS = new Set([
  "answer",
  "continue",
  "inform",
  "share",
  "ask",
  "agree",
  "interest",
  "joke",
  "care",
  "comfort",
  "praise",
  "flirt",
  "affection",
  "invite",
  "invite_hint",
]);
/** 收尾/拒绝类意图。 */
const MISS_INTENTS = new Set(["close", "refuse", "boundary"]);

/**
 * 对账判定（预填，非金标）：对方新回复的意图/情绪分布 → 接住了/没接/证据不足。
 * intents/emotions 为该回复的 judge 逐条结果（可空）。
 */
export function judgeOutcome(
  intents: Record<string, number> | undefined,
  emotions: Record<string, number> | undefined,
): CalibrationOutcome | null {
  if (!intents) return null;
  let caught = 0;
  let missed = 0;
  for (const [key, p] of Object.entries(intents)) {
    if (!Number.isFinite(p) || p <= 0) continue;
    if (CAUGHT_INTENTS.has(key)) caught = Math.max(caught, p);
    if (MISS_INTENTS.has(key)) missed = Math.max(missed, p);
  }
  if (missed >= 0.4 && missed >= caught) return "missed";
  if (caught >= 0.4) return "caught";
  // 意图弱时用情绪兜底：明显正向情绪算接球
  const pos = (emotions?.happy ?? 0) + (emotions?.caring ?? 0) + (emotions?.teasing ?? 0);
  if (pos >= 0.6) return "caught";
  return null;
}

export type CalibrationSummary = {
  /** 已确认样本数 */
  n: number;
  caught: number;
  /** 预测准确率（判定接球且实际接住的比例）；n<5 返回 null 不编造 */
  rate: number | null;
};

export function calibrationSummary(records: CalibrationRecord[]): CalibrationSummary {
  const confirmed = records.filter((r) => r.outcome !== null);
  const n = confirmed.length;
  const caught = confirmed.filter((r) => r.outcome === "caught").length;
  return { n, caught, rate: n >= 5 ? Math.round((caught / n) * 100) : null };
}
