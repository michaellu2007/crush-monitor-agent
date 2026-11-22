// MBTI 判定分级（纯函数，可单测）：把"四个字母"改成"逐轴结论 + 可信度"。
// 设计原则（用户口径）：**证据不足时宁可说测不准**，不硬给四字母。
// 输入三路证据，任一路不足则该轴不给 pick：
//   1) 块间投票一致率（模型集成的主证据）
//   2) 证据回验通过率（引用的原话能否在 TA 原文里找到）
//   3) 词面统计（仅作弱轴兜底，且在弱轴之外绝不改写已确定的方向）

export type MbtiTier = "high" | "medium" | "low" | "insufficient";
export type AxisStatus = "ok" | "weak" | "split" | "insufficient";

/** 判定阈值（可调，单测锁定行为）。 */
export const MBTI_GATES = {
  /** 样本充足度：TA 侧文本长度中位数（字） */
  medianLen: 12,
  /** 样本充足度：>20 字的长句条数 */
  longCount: 20,
  /** 样本充足度：占位消息占比上限 */
  placeholderRatio: 0.4,
  /** 轴判定：块间一致率 ≥ 此值算"确定" */
  voteOk: 0.75,
  /** 轴判定：一致率 ≥ 此值算"弱"（可给 pick，置信封顶 60） */
  voteWeak: 0.6,
  /** 证据回验通过率下限（低于此视为引用不可靠） */
  evidenceMin: 0.5,
  /** 词面兜底：命中率下限（命中数 / TA 文本条数）。实测短消息会话命中率普遍 1-2%，
   * 3% 会把有效统计全部挡在门外（联系人A J/P 1.8% 被误杀），故降到 1.5%。 */
  statHitRate: 0.015,
  /** 词面兜底：高侧至少命中条数 */
  statMinHits: 8,
  /** 词面兜底：高低侧倍数 */
  statRatio: 2,
  /** 短消息会话阈值：TA 文本中位数 ≤ 此值时，E/I 与 S/N 不可给"确定"结论
   * （实测证据：联系人A 中位数 6 字，3 块与 12 块结果从 IST 漂到 ENTJ——这两轴
   *  在短句里被模型按"I+少言"刻板印象填空，不是读出来的）。 */
  shortChatMedian: 8,
} as const;

export type SampleShape = {
  medianLen: number;
  longCount: number;
  placeholderRatio: number;
};

/** 样本充足度：三项都达标才算 ok；两项及以上不达标 = insufficient。 */
export function sampleTier(s: SampleShape): "ok" | "thin" | "insufficient" {
  const fails = [
    s.medianLen < MBTI_GATES.medianLen,
    s.longCount < MBTI_GATES.longCount,
    s.placeholderRatio > MBTI_GATES.placeholderRatio,
  ].filter(Boolean).length;
  if (fails === 0) return "ok";
  if (fails === 1) return "thin";
  return "insufficient";
}

export type AxisInput = {
  /** 轴键："E/I" | "S/N" | "T/F" | "J/P" */
  dim: string;
  /** 模型投票胜出侧（E/I/S/N/T/F/J/P）；无票时为空串 */
  pick: string;
  /** 块间一致率 0..1（胜出侧票数 / 有效票数） */
  voteShare: number;
  /** 证据回验通过率 0..1 */
  evidenceRate: number;
  /** 词面统计：高侧/低侧命中数与 TA 文本总数 */
  hitHi: number;
  hitLo: number;
  total: number;
  /** 词面高侧对应的 pick（如 J/P 轴的 J） */
  hiPick: string;
};

export type AxisVerdict = {
  dim: string;
  /** null = 判不准（UI 显示"?"），不参与四字母拼接 */
  pick: string | null;
  percent: number;
  status: AxisStatus;
  reason: string;
};

export type MbtiDecision = {
  /** 四轴全部有 pick 才拼得出来，否则 null */
  type: string | null;
  tier: MbtiTier;
  axes: AxisVerdict[];
  notes: string[];
};

/**
 * 单轴判定：
 * - 样本不足 → insufficient（不给 pick）
 * - 一致率达标 + 证据可信 → ok，percent 由一致率与回验率加权
 * - 一致率达弱阈值 → weak（给 pick，percent ≤60）
 * - 一致率不足 → 词面统计达标则按统计给 weak，否则 split（不给 pick）
 */
export function decideAxis(input: AxisInput, sample: "ok" | "thin" | "insufficient"): AxisVerdict {
  const { dim, pick, voteShare, evidenceRate, hitHi, hitLo, total, hiPick } = input;
  const noPick = (status: AxisStatus, reason: string): AxisVerdict => ({
    dim,
    pick: null,
    percent: 0,
    status,
    reason,
  });
  if (sample === "insufficient" || !pick)
    return noPick("insufficient", sample === "insufficient" ? "样本不足（消息过短或占位过多）" : "模型未给出该轴");

  const statStrong =
    total > 0 &&
    hitHi / total >= MBTI_GATES.statHitRate &&
    hitHi >= MBTI_GATES.statMinHits &&
    hitHi >= MBTI_GATES.statRatio * hitLo;

  // 两路证据冲突：投票明确（≥voteOk）却与强统计反向 → 不给结论。
  // 依据（实测）：统计词表长度不对称（N 侧 30 词 vs S 侧 8 词），谁都能被覆盖成 N，
  // 两个联系人都被判成"ENTJ"——那不是证据，是词表长度差。冲突时诚实弃权。
  if (statStrong && hiPick && hiPick !== pick && voteShare >= MBTI_GATES.voteOk)
    return noPick(
      "split",
      `两路证据冲突（投票 ${pick} ${Math.round(voteShare * 100)}% vs 词面 ${hiPick} ${hitHi}:${hitLo}），不给结论`,
    );
  // 投票不明确 + 统计强 → 统计定方向（只算弱结论）
  if (statStrong && hiPick && hiPick !== pick)
    return {
      dim,
      pick: hiPick,
      percent: Math.min(60, Math.round(50 + 2 * Math.min(5, hitHi / MBTI_GATES.statMinHits))),
      status: "weak",
      reason: `词面统计覆盖（原文方向 ${hitHi} vs ${hitLo} 条）`,
    };

  // 模型高度一致但证据引用不可靠：降为弱结论，不直接采信
  const evidenceOk = evidenceRate >= MBTI_GATES.evidenceMin;
  if (voteShare >= MBTI_GATES.voteOk && evidenceOk) {
    const percent = Math.round(100 * (0.6 * voteShare + 0.4 * evidenceRate));
    return {
      dim,
      pick,
      percent: Math.min(95, Math.max(50, percent)),
      status: "ok",
      reason: `块间一致 ${Math.round(voteShare * 100)}%、证据核实 ${Math.round(evidenceRate * 100)}%`,
    };
  }
  if (voteShare >= MBTI_GATES.voteWeak)
    return {
      dim,
      pick,
      percent: Math.min(60, Math.round(100 * (0.6 * voteShare + 0.4 * evidenceRate))),
      status: "weak",
      reason: evidenceOk
        ? `块间一致仅 ${Math.round(voteShare * 100)}%`
        : `证据核实仅 ${Math.round(evidenceRate * 100)}%`,
    };
  // 投票分裂：只有词面统计强到能独立支撑时才给弱结论，方向以统计高侧为准
  if (statStrong && hiPick)
    return {
      dim,
      pick: hiPick,
      percent: Math.min(55, Math.round(50 + 5 * Math.min(3, hitHi / MBTI_GATES.statMinHits))),
      status: "weak",
      reason: `投票分裂（一致率 ${Math.round(voteShare * 100)}%），仅词面统计支撑（${hiPick} 侧 ${hitHi} vs ${hitLo}）`,
    };
  return noPick(
    "split",
    `块间投票分歧（一致率 ${Math.round(voteShare * 100)}%），词面统计不足以独立支撑`,
  );
}

/** 汇总四轴 → 类型/tier。四轴全有 pick 才给 type（用户口径：宁可说测不准）。 */
export function decideMbti(
  inputs: AxisInput[],
  sample: SampleShape,
): MbtiDecision {
  const tierIn = sampleTier(sample);
  const shortChat = sample.medianLen > 0 && sample.medianLen <= MBTI_GATES.shortChatMedian;
  const axes = inputs.map((i) => {
    const v = decideAxis(i, tierIn);
    if (!shortChat || v.status !== "ok") return v;
    const dim = v.dim.split(" ")[0];
    if (dim !== "E/I" && dim !== "S/N") return v;
    // 短消息会话里的 E/I、S/N：只有词面统计同向支撑才维持"确定"，否则降为弱结论
    const statStrong =
      i.total > 0 &&
      i.hitHi / i.total >= MBTI_GATES.statHitRate &&
      i.hitHi >= MBTI_GATES.statMinHits &&
      i.hitHi >= MBTI_GATES.statRatio * i.hitLo &&
      i.hiPick === v.pick;
    if (statStrong) return v;
    return {
      ...v,
      percent: Math.min(60, v.percent),
      status: "weak" as AxisStatus,
      reason: "短消息会话：该轴文本信号不足，已降为弱结论",
    };
  });
  const notes: string[] = [];
  if (tierIn === "insufficient")
    notes.push("文本证据不足：消息过短或占位消息过多，本次不给结论");
  else if (tierIn === "thin") notes.push("样本偏薄：结论置信已下调");
  if (shortChat) notes.push("短消息会话：E/I 与 S/N 最容易误判，置信已压低");
  const missing = axes.filter((a) => !a.pick);
  const okCount = axes.filter((a) => a.status === "ok").length;

  let tier: MbtiTier;
  if (!axes.length || missing.length === axes.length) tier = "insufficient";
  else if (missing.length > 0) tier = "low";
  else if (okCount === axes.length) tier = "high";
  // 短消息会话要求 3 轴确定才算 medium：否则四字母里会混进两个 60% 的"弱字母"
  else if (okCount >= (shortChat ? 3 : 2)) tier = "medium";
  else tier = "low";

  const order = ["E/I", "S/N", "T/F", "J/P"];
  const ordered = [...axes].sort(
    (a, b) => order.indexOf(a.dim.split(" ")[0]) - order.indexOf(b.dim.split(" ")[0]),
  );
  const picked = order
    .map((k) => ordered.find((a) => a.dim.split(" ")[0] === k)?.pick ?? "")
    .join("");
  const lettersValid = /^[IE][SN][TF][JP]$/.test(picked);
  // 只要四轴都有方向就给四字母——置信由 tier 表达（低可信会显式标注），
  // 判不准的轴（无 pick）才是"宁可说测不准"的边界。
  const type = lettersValid ? picked : null;
  if (!type && missing.length)
    notes.push(`仅判清 ${axes.length - missing.length}/${axes.length} 轴，不足以给出四字母`);
  else if (type && tier === "low") notes.push("四轴方向已给出，但置信偏低，仅作弱参考");
  return { type, tier, axes: ordered, notes };
}
