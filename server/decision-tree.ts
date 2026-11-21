// 决策树 v1：意图 → 顾问生成 2-3 候选动作 → 每动作模拟对方两种回复 →
// 本地判官给每分支打"接球概率" → 树形 JSON（前端渲染可折叠树）。
// 伦理硬规则：边界模式（前端 judge 结果 boundary/refuse ≥0.5、或上下文出现明确
// 拒绝话术、或画像雷区触发）下只输出"尊重边界"节点，不给任何推进分支。
import { z } from "zod";
import { activeConfig } from "./model-config";
import { ProviderError } from "./provider";
import { advisorOpenAICall, advisorText } from "./advise";
import { judgeConfig } from "./model-config";
import { judgeChat, extractJsonObject } from "./judge-chat";
import { coerceString, coerceNumber, coerceProbability } from "./json-coerce";
import { buildTranscript } from "./transcript";
import { transcriptCharBudgetForConfig } from "./context-budget";
import { readProfile } from "./profile-store";
import { RELATIONS } from "../shared/types";

const schema = z.object({
  self: z.string().min(1).max(80),
  other: z.string().min(1).max(80),
  relation: z.enum(["crush", "new", "couple"]),
  intent: z.string().min(1).max(2000),
  messages: z
    .array(
      z.object({
        sender: z.enum(["self", "other"]),
        text: z.string().max(12000),
        timestamp: z.string().max(80).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
  contactId: z.string().max(120).optional(),
  /** 前端从 judge 逐条结果算的边界信号（boundary/refuse ≥0.5 命中） */
  boundaryDetected: z.boolean().optional(),
});

const actionsSchema = z.object({
  actions: z
    .array(
      z.object({
        title: z.string().min(1).max(40),
        draft: z.string().min(1).max(500),
        threshold: z.enum(["低", "中", "高"]),
        rationale: z.string().max(200).default(""),
      }),
    )
    .min(2)
    .max(3),
});

const simSchema = z.object({
  replies: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        valence: z.enum(["积极", "中性", "消极"]),
      }),
    )
    .min(1)
    .max(3),
});

const branchScoreSchema = z.object({
  branches: z
    .array(
      z.object({
        actionIndex: z.number().int().min(1).max(3),
        catchProbability: z.number().min(0).max(1).nullable().optional(),
        note: z.string().max(200).optional(),
      }),
    )
    .min(1),
});

// 明确拒绝话术（词面兜底；宁漏勿错——判定权在前端 judge 结果）
const REFUSAL_TEXT =
  /(别再(联系|找|发|给我)|不要再(联系|找|发|烦)|请你自重|请你尊重|离我远点|不想(再)?(聊|理|见)|拉黑|删好友|不要再问我)/;

/** 边界判定（纯函数可测）：三路并集——judge 信号 / 明确拒绝话术 / 画像雷区。 */
export function collectBoundaryReasons(
  boundaryDetected: boolean | undefined,
  lastOtherTexts: string[],
  profileBoundaries: string[],
): string[] {
  const reasons: string[] = [];
  if (boundaryDetected)
    reasons.push("近期对方消息被判为边界/婉拒（judge 逐条结果）");
  if (lastOtherTexts.some((t) => REFUSAL_TEXT.test(t)))
    reasons.push("近期对方消息含明确拒绝话术");
  if (profileBoundaries.length)
    reasons.push(`画像雷区（硬约束）：${profileBoundaries.join("、")}`);
  return reasons;
}

export type DecisionTree = {
  boundary: boolean;
  boundaryReasons: string[];
  intent: string;
  actions: {
    title: string;
    draft: string;
    threshold: string;
    rationale: string;
    catchProbability: number | null;
    note: string;
    simulations: { text: string; valence: string }[];
  }[];
  generatedAt: string;
};

async function advisorJson<T extends z.ZodTypeAny>(
  config: any,
  systemText: string,
  userText: string,
  schema2: T,
  fallback?: (obj: Record<string, unknown>) => z.infer<T>,
): Promise<z.infer<T>> {
  const data = await advisorOpenAICall(config, [
    { role: "system", content: systemText },
    { role: "user", content: userText },
  ]);
  const text = advisorText(data);
  const obj = extractJsonObject(text) as Record<string, unknown>;
  try {
    return schema2.parse(obj) as z.infer<T>;
  } catch (e) {
    if (fallback) {
      // 兜底产物也要过一次 schema：宽容规整可能凑不满 min 条数（如 actions≥2），
      // 不复验会把空树发给前端（2026-11-19 bug 审查 P3）
      const fb = fallback(obj) as z.infer<T>;
      const re = schema2.safeParse(fb);
      if (re.success) return re.data as z.infer<T>;
      throw e;
    }
    throw e;
  }
}

// ---------- 跨模型宽容规整（schema 校验失败时的兜底形态转换） ----------
function coerceActionArray(obj: Record<string, unknown>): z.infer<typeof actionsSchema> {
  const arr = Array.isArray(obj.actions) ? obj.actions : Array.isArray(obj) ? obj : [];
  const actions = arr.slice(0, 3).map((x) => {
    const it = (x ?? {}) as Record<string, unknown>;
    const draft = coerceString(it.draft ?? it.说法 ?? it.content ?? it.text ?? it.message) ?? "";
    const title = (coerceString(it.title ?? it.name) ?? draft.slice(0, 12)) || "候选";
    const thRaw = coerceString(it.threshold ?? it.门槛) ?? "";
    const threshold = thRaw.includes("高") ? "高" : thRaw.includes("中") ? "中" : "低";
    return {
      title,
      draft,
      threshold: threshold as "低" | "中" | "高",
      rationale: coerceString(it.rationale ?? it.reason ?? it.依据) ?? "",
    };
  }).filter((a) => a.draft);
  return { actions: actions as z.infer<typeof actionsSchema>["actions"] };
}

function coerceSimArray(obj: Record<string, unknown>): z.infer<typeof simSchema> {
  const arr = Array.isArray(obj.replies)
    ? obj.replies
    : Array.isArray(obj)
      ? obj
      : [];
  const replies = arr.slice(0, 3).map((x) => {
    const it = (x ?? {}) as Record<string, unknown>;
    const text = coerceString(it.text ?? it.reply ?? it.content ?? it.message) ?? "";
    const vRaw = String(it.valence ?? it.情绪 ?? "");
    const valence = /积极|正向|positive/i.test(vRaw)
      ? "积极"
      : /消极|负|negative/i.test(vRaw)
        ? "消极"
        : "中性";
    return { text, valence: valence as "积极" | "中性" | "消极" };
  }).filter((s) => s.text);
  return { replies: replies as z.infer<typeof simSchema>["replies"] };
}

async function scoreBranches(
  intent: string,
  actions: z.infer<typeof actionsSchema>["actions"],
  sims: (z.infer<typeof simSchema>["replies"] | null)[],
): Promise<{ catchProbability: number | null; note: string }[]> {
  const judge = judgeConfig();
  if (!judge)
    return actions.map(() => ({
      catchProbability: null,
      note: "判官未配置，未校准",
    }));
  if (judge.protocol === "jev")
    return actions.map(() => ({
      catchProbability: null,
      note: "Jev 原生判官不支持草稿打分，未校准",
    }));
  try {
    const listing = actions
      .map((a, i) => {
        const simTexts = (sims[i] ?? []).map((s) => `「${s.text}」(${s.valence})`).join(" / ");
        return `候选${i + 1}【${a.title}】：${a.draft}\n模拟对方回复：${simTexts || "（无）"}`;
      })
      .join("\n\n");
    const raw = await judgeChat(
      judge,
      '你是关系分支评估器。用户的目标和 2-3 个候选发话及模拟回复。给每个候选估"接球概率"（对方积极接话的可能性 0-1）。严格输出 JSON：{"branches":[{"actionIndex":1,"catchProbability":0.5,"note":"一句话依据"}]}',
      `用户目标：${intent}\n\n${listing}`,
      150_000,
    );
    const parsed = branchScoreSchema.parse(extractJsonObject(raw));
    const out = actions.map((_, i) => {
      const hit = parsed.branches.find((b) => b.actionIndex === i + 1);
      return {
        catchProbability:
          typeof hit?.catchProbability === "number"
            ? Math.round(hit.catchProbability * 100) / 100
            : null,
        note: hit?.note ?? "",
      };
    });
    return out;
  } catch {
    return actions.map(() => ({
      catchProbability: null,
      note: "判官打分失败，未校准",
    }));
  }
}

export async function buildDecisionTree(body: unknown): Promise<DecisionTree> {
  const input = schema.parse(body);
  const config = activeConfig();
  if (!("engine" in config) || config.engine !== "llm")
    throw new ProviderError(
      400,
      "决策树需要 OpenAI 兼容顾问模型，请在模型设置中选择非 Jev 协议的配置。",
    );
  if (config.protocol === "anthropic")
    throw new ProviderError(400, "决策树 v0 暂只支持 OpenAI 协议的顾问模型。");

  // ---------- 边界判定（三路并集，命中即边界模式） ----------
  const lastOther = input.messages
    .filter((m) => m.sender === "other")
    .slice(-10)
    .map((m) => m.text);
  const profile = input.contactId ? readProfile(input.contactId) : null;
  const reasons = collectBoundaryReasons(
    input.boundaryDetected,
    lastOther,
    profile?.boundaries ?? [],
  );

  const transcript = buildTranscript(
    input.messages,
    transcriptCharBudgetForConfig(config),
    { self: input.self, other: input.other },
  );
  const baseContext = `关系状态：${RELATIONS[input.relation]}
聊天记录摘选：
${transcript}

用户目标：${input.intent}`;
  const generatedAt = new Date().toISOString();

  // ---------- 边界模式：只给尊重边界节点 ----------
  if (reasons.length) {
    let closing =
      "好，那就先这样，你先忙。有需要随时找我。";
    try {
      const data = await advisorJson(
        config,
        '你是关系策略师。对方已表达拒绝或需要空间，给一条尊重边界的收尾话术：不纠缠、不追问原因、语气自然，≤40 字。严格输出 JSON：{"actions":[{"title":"尊重边界","draft":"话术","threshold":"低","rationale":"理由"}]}',
        baseContext,
        actionsSchema,
      );
      if (data.actions[0]?.draft) closing = data.actions[0].draft;
    } catch {
      /* 生成失败用默认收尾 */
    }
    return {
      boundary: true,
      boundaryReasons: reasons,
      intent: input.intent,
      actions: [
        {
          title: "尊重边界",
          draft: closing,
          threshold: "低",
          rationale: "对方已表达拒绝或需要空间。尊重这个意思，停止推进。",
          catchProbability: null,
          note: "边界模式下不预测接球概率",
          simulations: [],
        },
      ],
      generatedAt,
    };
  }

  // ---------- 正常模式：候选动作 → 模拟回复 → 判官打分 ----------
  const gen = await advisorJson(
    config,
    `你是关系策略师。根据聊天摘选与用户目标，生成 2-3 个候选动作：可直接发送的具体说法（贴合摘选里用户的语气）、回应门槛（低/中/高）、一句依据。候选之间策略要不同（如追问/自嘲递球/小额分享）。禁止空话；禁止触碰任何雷区。严格输出 JSON：{"actions":[{"title":"简短标题","draft":"可直接发送的话","threshold":"低|中|高","rationale":"依据"}]}`,
    baseContext,
    actionsSchema,
    coerceActionArray,
  );
  const sims: (z.infer<typeof simSchema>["replies"] | null)[] = [];
  for (const a of gen.actions) {
    try {
      const sim = await advisorJson(
        config,
        `你在角色扮演聊天中的对方（只依据摘选里的对方性格与语气，不要降格成完美配合）。对用户发来的这句话，模拟 2 种真实反应：一种偏积极、一种偏消极/中性。严格输出 JSON：{"replies":[{"text":"对方的回复","valence":"积极|中性|消极"}]}`,
        `${baseContext}\n\n用户准备发：「${a.draft}」`,
        simSchema,
        coerceSimArray,
      );
      sims.push(sim.replies);
    } catch {
      sims.push(null);
    }
  }
  const scores = await scoreBranches(input.intent, gen.actions, sims);
  return {
    boundary: false,
    boundaryReasons: [],
    intent: input.intent,
    actions: gen.actions.map((a, i) => ({
      title: a.title,
      draft: a.draft,
      threshold: a.threshold,
      rationale: a.rationale,
      catchProbability: scores[i]?.catchProbability ?? null,
      note: scores[i]?.note ?? "",
      simulations: sims[i] ?? [],
    })),
    generatedAt,
  };
}
