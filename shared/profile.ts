import { MBTI_TYPES } from "./mbti";

/**
 * 对方画像 v1：按联系人持久化的结构化画像（data/profiles/<contactId>.json）。
 * 三层来源（证据分级，与情感文献参考 U 节一致）：
 * - 统计层：computeBaseline 的客观习惯（由前端随请求注入，不在这里重复存）
 * - 抽取层：本文件的 interests/boundaries/styleNote/events——顾问模型从聊天记录
 *   低频批量抽取（POST /api/profile/:contactId/extract 手动触发），或用户手工维护
 * - 推测层：mbti——模型推测的四维倾向（分维置信度），**弱参考中的弱参考**：
 *   只校准语气节奏，不得替代原话证据，与自测标签冲突时以自测为准
 *
 * 定位：弱参考。注入 prompt 时必须带守卫句——画像是理解背景的先验，
 * 不能替代或优先于聊天原话证据；boundaries（边界雷区）例外：它是硬约束，
 * 任何候选不得触碰（与"尊重边界"红线同优先级）。
 */

export type ProfileEvent = { at: string; note: string };

/** 判定分级：high/medium = 可参考；low = 仅提示；insufficient = 不给结论。 */
export type MbtiTier = "high" | "medium" | "low" | "insufficient";
export type MbtiAxisStatus = "ok" | "weak" | "split" | "insufficient";

/** 模型推测的 MBTI（弱参考）：分维置信度而非单点断言，仅供语气校准。
 * 证据不足时 type 与 axes[].pick 可为空——"宁可说测不准"（用户口径）。 */
export type InferredMbti = {
  /** 四轴全部判清才拼得出来；否则缺省（UI 显示"暂无法判断"） */
  type?: string;
  axes: {
    dim: string;
    /** 缺省 = 该轴判不准，不参与四字母拼接 */
    pick?: string;
    percent: number;
    evidence?: string;
    /** 证据/采样异常注记（如"证据未核实""两次采样不一致"） */
    note?: string;
    /** 该轴判定状态与原因（新增，供 UI 逐轴展示） */
    status?: MbtiAxisStatus;
    reason?: string;
  }[];
  /** 整体可信度分级 */
  tier?: MbtiTier;
  /** 证据来自哪一侧（other=对方 / self=用户本人）——归因显式化 */
  source?: "other" | "self";
  /** 真实喂给模型的目标侧文本条数（样本量） */
  samples?: number;
  /** 弱证据总评（如"文本证据有限：N 轴置信 ≤55"），UI 展示用 */
  note?: string;
  inferredAt: string;
};

export type ContactProfile = {
  schema: 1;
  contactId: string;
  /** 兴趣话题 TopN（对方主动提起/投入度高的） */
  interests: string[];
  /** 边界雷区：提到就翻脸/明确避开的话题与行为——候选生成的硬约束 */
  boundaries: string[];
  /** 沟通风格备注（一句话） */
  styleNote?: string;
  /** 重要事件时间线（生日/考试/家事/纪念日…） */
  events: ProfileEvent[];
  /** 模型推测的 MBTI（弱参考，与自测标签冲突时以自测为准；自测标签存 userProfile.mbti） */
  mbti?: InferredMbti;
  updatedAt: string;
};

export const PROFILE_LIMITS = {
  interests: 10,
  boundaries: 10,
  styleNote: 200,
  events: 20,
  interestLen: 30,
  boundaryLen: 40,
  eventNoteLen: 200,
  eventAtLen: 40,
} as const;

function clean(list: string[], maxCount: number, maxLen: number): string[] {
  return list
    .map((s) => s.trim().slice(0, maxLen))
    .filter((s) => s.length > 0)
    .slice(0, maxCount);
}

/** 规整画像（裁剪长度/条数、去重）；contactId 缺失时拒绝。 */
export function normalizeProfile(
  raw: unknown,
  contactId: string,
): ContactProfile | null {
  if (!contactId || contactId.length > 120) return null;
  const p = raw as Partial<ContactProfile> | null | undefined;
  if (!p || typeof p !== "object") return null;
  const uniq = (xs: string[]) => [...new Set(xs)];
  const mbti = normalizeMbti(p.mbti);
  return {
    schema: 1,
    contactId,
    interests: uniq(clean(p.interests ?? [], PROFILE_LIMITS.interests, PROFILE_LIMITS.interestLen)),
    boundaries: uniq(
      clean(p.boundaries ?? [], PROFILE_LIMITS.boundaries, PROFILE_LIMITS.boundaryLen),
    ),
    styleNote:
      typeof p.styleNote === "string" && p.styleNote.trim()
        ? p.styleNote.trim().slice(0, PROFILE_LIMITS.styleNote)
        : undefined,
    events: (p.events ?? [])
      .filter(
        (e): e is ProfileEvent =>
          !!e && typeof e.note === "string" && e.note.trim().length > 0,
      )
      .map((e) => ({
        at: String(e.at ?? "").slice(0, PROFILE_LIMITS.eventAtLen),
        note: e.note.trim().slice(0, PROFILE_LIMITS.eventNoteLen),
      }))
      .slice(0, PROFILE_LIMITS.events),
    mbti,
    updatedAt: new Date().toISOString(),
  };
}

/** 规整推测 MBTI：四轴全有合法 pick 才保留 type（与 axes 强一致）；
 * 任缺一轴 → type 丢弃，只保留逐轴结论（"宁可说测不准"）。 */
function normalizeMbti(raw: unknown): InferredMbti | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<InferredMbti> & { type?: unknown };
  const pct = (v: unknown) => {
    const n =
      typeof v === "number"
        ? v
        : typeof v === "string"
          ? parseFloat(v.replace(/[^\d.]/g, ""))
          : NaN;
    if (!Number.isFinite(n)) return 0;
    return Math.round(Math.min(100, Math.max(0, n > 1 ? n : n * 100)));
  };
  const AXIS_ORDER = ["E/I", "S/N", "T/F", "J/P"];
  const axisKey = (dim: string) => dim.trim().split(/[\s（(]/)[0].slice(0, 3);
  const axes = (Array.isArray(r.axes) ? r.axes : [])
    .slice(0, 4)
    .map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const pickRaw = String(o.pick ?? "").toUpperCase().slice(0, 1);
      const statusRaw = String(o.status ?? "");
      return {
        dim: String(o.dim ?? "").slice(0, 30),
        pick: /^[EISNTFJP]$/.test(pickRaw) ? pickRaw : undefined,
        percent: pct(o.percent),
        evidence: String(o.evidence ?? "").slice(0, 120) || undefined,
        note: String(o.note ?? "").slice(0, 40) || undefined,
        status:
          statusRaw === "ok" || statusRaw === "weak" || statusRaw === "split" || statusRaw === "insufficient"
            ? (statusRaw as MbtiAxisStatus)
            : undefined,
        reason: String(o.reason ?? "").slice(0, 60) || undefined,
      };
    })
    .filter((a) => a.dim && axisKey(a.dim));
  if (!axes.length) return undefined;
  // type 与 axes 强一致：按轴序重拼，任一轴缺 pick 或不合法 → 无 type
  const derived = AXIS_ORDER.map(
    (k) => axes.find((a) => axisKey(a.dim) === k)?.pick ?? "",
  ).join("");
  const type = /^[IE][SN][TF][JP]$/.test(derived) ? derived : undefined;
  const tierRaw = String((r as { tier?: unknown }).tier ?? "");
  const tier =
    tierRaw === "high" || tierRaw === "medium" || tierRaw === "low" || tierRaw === "insufficient"
      ? (tierRaw as MbtiTier)
      : undefined;
  const source = r.source === "self" || r.source === "other" ? r.source : undefined;
  const samples =
    typeof r.samples === "number" && Number.isFinite(r.samples) && r.samples >= 0
      ? Math.round(r.samples)
      : undefined;
  const note = String((r as { note?: unknown }).note ?? "").slice(0, 80) || undefined;
  return { type, axes, tier, source, samples, note, inferredAt: new Date().toISOString() };
}

/** 画像 → 顾问 prompt 注入块（含守卫句；空画像返回空串）。 */
export function describeProfile(p: ContactProfile | null | undefined): string {
  if (!p) return "";
  const lines: string[] = [];
  if (p.interests.length)
    lines.push(`- 兴趣话题：${p.interests.join("、")}（候选可自然借用，别堆砌）`);
  if (p.boundaries.length)
    lines.push(
      `- 边界雷区（硬约束，任何候选不得提及或试探）：${p.boundaries.join("、")}`,
    );
  if (p.styleNote) lines.push(`- 沟通风格：${p.styleNote}`);
  if (p.events.length) {
    const evs = p.events
      .slice(-5)
      .map((e) => `${e.at ? `${e.at} ` : ""}${e.note}`)
      .join("；");
    lines.push(`- 近期重要事件：${evs}（关心可以，反复追问不行）`);
  }
  if (p.mbti) {
    const info = p.mbti.type ? MBTI_TYPES[p.mbti.type] : undefined;
    const axes = (p.mbti.axes ?? [])
      .map((a) => {
        const dimShort = a.dim.split(/[-/（(]/)[0] || a.dim;
        return a.pick
          ? `${dimShort}倾向${a.pick} ${a.percent}%`
          : `${dimShort}未判清`;
      })
      .join(" · ");
    const headline = p.mbti.type
      ? `${p.mbti.type}${info ? `（${info.label}）` : ""}${p.mbti.tier ? `，可信度 ${p.mbti.tier}` : ""}`
      : `暂无法判断${p.mbti.tier ? `（可信度 ${p.mbti.tier}）` : ""}`;
    lines.push(
      `- 推测人格（模型推测，弱参考；与用户自测标签冲突时以自测为准）：${headline}${axes ? `，${axes}` : ""}。仅用于校准语气与节奏，不得替代原话证据`,
    );
  }
  if (!lines.length) return "";
  return `对方画像（长期抽取/用户维护，仅作背景与硬约束，判断必须落在摘选原话上）：
${lines.join("\n")}`;
}
