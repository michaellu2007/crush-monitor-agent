import { z } from "zod";
import { createHash } from "node:crypto";
import { activeConfig, judgeConfig, type LlmConfig, type JudgeConfig } from "./model-config";
import { fastInferenceOptions } from "./llm-profile";
import { ProviderError, providerErrorMessage } from "./provider";
import { RELATIONS, type DialogSummary } from "../shared/types";
import { MBTI_TYPES } from "../shared/mbti";
import { humanGap } from "../shared/segments";
import { buildTacticsNote } from "../shared/tactics";
import { describeProfile, normalizeProfile } from "../shared/profile";
import { judgeChat, extractJsonObject } from "./judge-chat";
import { coerceNumber as coerceNum } from "./json-coerce";
import { buildTranscript } from "./transcript";
import { transcriptCharBudgetForConfig, judgeTranscriptChars } from "./context-budget";
import { markToolsUnsupported, toolsKnownUnsupported } from "./tool-support";
import { streamLlmResponse } from "./llm-stream";
import { loadKnowledge } from "./knowledge-store";
import {
  ADVISOR_TOOLS,
  TOOL_LOOP_MAX_ROUNDS,
  executeTool,
  type ToolContext,
} from "./advisor-tools";

const schema = z.object({
  self: z.string().min(1).max(80),
  other: z.string().min(1).max(80),
  relation: z.enum(["crush", "new", "couple"]),
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
  question: z.string().min(1).max(4000),
  dialog: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
        // 轮次时间戳（ms，可选）：>2h 间隔视为会话段边界，压缩点优先切在边界上
        ts: z.number().optional(),
      }),
    )
    // D3：前端改送全量 dialog（本地传输零成本），钳制交给服务端预算（trimDialogToBudget/
    // compactDialog），上限只防滥用——对齐 messages 的 200 条口径
    .max(200)
    .optional(),
  // D1 摘要冻结：前端缓存的上次压缩事件产物，随请求带回；服务端校验覆盖段指纹
  // 一致才复用（见 docs/agent对话上下文管理调研.md §6.2 D1）
  dialogSummary: z
    .object({
      throughCount: z.number().int().min(1),
      throughHash: z.string().min(8).max(64),
      text: z.string().min(1).max(2000),
    })
    .optional(),
  // 交互模式（2026-11-18）：manual=勾选记录（默认）；auto=顾问用 search_history 自取历史，
  // 摘选只是最近几条的当前语境
  mode: z.enum(["manual", "auto"]).optional(),
  // /goal 设定的会话目标：随每轮注入 prompt，用户 /goal clear 前一直生效
  goal: z.string().max(500).optional(),
  // 情绪水位摘要（前端 shared/valence.ts 本地聚合的结果，非模型评分）：
  // 只作背景事实，帮顾问把"情绪节奏"和"关系信号"分开。
  valenceSummary: z
    .object({
      level: z.number().min(0).max(100),
      change7d: z.number().min(-100).max(100).nullable(),
      negatives7d: z.number().int().nonnegative(),
      points: z.number().int().nonnegative(),
    })
    .optional(),
  // 对方画像：用户断言（MBTI/风格/近况，弱参考）+ 机器统计基线（客观习惯），
  // 只作校准背景——回复的节奏与长度向对方习惯对齐，判断仍必须落在原话上。
  userProfile: z
    .object({
      mbti: z
        .string()
        .regex(/^[IEie][SNsn][TFtf][JPjp]$/)
        .optional(),
      style: z.enum(["secure", "anxious", "avoidant"]).optional(),
      recent: z.string().max(500).optional(),
      baseline: z
        .object({
          window: z.string().max(20),
          sample: z.number().int().min(0),
          shortReplyRate: z.number().min(0).max(1),
          medianLen: z.number().int().min(0),
          medianGapMin: z.number().min(0).nullable(),
          emojiRate: z.number().min(0).max(1),
          initiationRate: z.number().min(0).max(1).nullable(),
        })
        .optional(),
    })
    .optional(),
  // 对方画像 v1（shared/profile.ts 持久化画像，弱参考+硬约束雷区，守卫句内嵌）
  contactProfile: z
    .object({
      interests: z.array(z.string().max(60)).optional(),
      boundaries: z.array(z.string().max(60)).optional(),
      styleNote: z.string().max(300).optional(),
      events: z
        .array(
          z.object({
            at: z.string().max(40).optional(),
            note: z.string().max(250),
          }),
        )
        .optional(),
    })
    .optional(),
  // harness 工具作用域：带了 contactId 才启用 search_history/get_profile 工具循环
  contactId: z.string().max(120).optional(),
});

const system = `你是"关系策略师"顾问。用户会给你一段与对方的聊天记录摘选和一个问题；你的任务不是空泛安慰，而是给出能直接执行的行动方案。

回答格式（markdown，条理像专业助手一样清晰，禁止大段堆字）：
### 判断
一两句话：对方当前的状态与意愿（情绪指向谁、想不想聊），引用摘选原话要短。

### 候选
2-3 个候选，每个独立一小块：
**候选1**
- 说法：可直接复制发送的话（贴合摘选里用户自己的语气，保持纯文本可复制）
- 门槛：低/中/高——对方接这个话需要付出的努力
- 温度：克制/温和/热络
- 风险：这个说法最可能翻车的点

### 推荐
明确推荐其中一个候选 + 一句话说理由。

通用要求：小节标题用 ###；字段行用列表；关键结论**加粗**；默认总量 ≤300 字，
用户要详细才展开；「说法」行的内容不加任何格式符号。

硬规则：
- 原话证据优先：判断必须落在摘选原话上，没有证据不下断言；用户自述的场外信息只作背景。
- 多轮对话（消息历史里有此前问答时）：这是同一次咨询的延续，不是新问题——先接住上文再答；用户对已给候选的反馈优先回应；已给过的候选不原样重复（用户明确要"再来一批/换一批"除外）；用户说"上一条/刚才/你说的"指对话历史里的内容，不是聊天记录摘选。
- 对方表达了拒绝、敷衍或需要空间时：不给推进性候选，只解释为什么该退，并给一条尊重边界的收尾话术。
- 出现争执、误会或对方情绪转负时，至少一个候选走"修复"路线：先接情绪，再谈事。
- 候选必须具体、口语、可直接发送；禁止"多关心对方""顺其自然"这类空话。
- 语气自然，直接回答，不输出 JSON。`;

/** D2：system 是消息数组最前缀，必须逐字稳定（跨问题/跨联系人不变）——按题选取的
 * 战术参考移到尾部用户消息里（见 prompt 组装处）。前缀稳定性 = 云 API 隐式缓存命中的
 * 前提，依据 docs/agent对话上下文管理调研.md §6.2 D2。 */
export const ADVISOR_SYSTEM = system;

/**
 * 顾问历史压缩（D1 摘要冻结版，2026-11-11）：压缩从"每请求重摘"改为"低频压缩事件"——
 * 事件间隔内发给模型的消息数组严格 append-only，让云 API 的隐式前缀缓存（GLM 命中约半价，
 * 见 docs/agent对话上下文管理调研.md §5/§6）真正命中。
 * 触发口径：无冻结摘要时轮数 >ADVISOR_RECENT_TURNS、或投影超模型窗口预算 70%
 * （COMPACT_WINDOW_RATIO，窗口按 context-budget.ts 模型自适应）；有冻结摘要时，
 * 摘要覆盖段之后的原话尾巴超过 ADVISOR_TAIL_TURNS 或投影超预算才发起下一次压缩事件。
 * 摘要产物 { throughCount, throughHash, text } 随响应返回、前端随下轮请求带回；
 * 服务端校验 dialogHash(覆盖段) === throughHash 才复用（对话被改动/换人即失效重摘）。
 * 压缩点仍优先切最后一个 >2h 停顿段边界（SEGMENT_GAP_MS，边界后当前段哪怕多于
 * 8 轮也保持原话）；压缩后仍超预算则从头部成对丢轮、保末尾（trimDialogToBudget）。
 * 摘要调用失败退回全量但同样封顶，不阻断主流程。不做话题自动切换（决策表口径不变）。
 */
const ADVISOR_RECENT_TURNS = 8;
/** 已有冻结摘要时，摘要后原话尾巴攒到这么多轮 → 触发下一次压缩事件。 */
const ADVISOR_TAIL_TURNS = 16;
const COMPACT_WINDOW_RATIO = 0.7;
/** 超过 2h 停顿视为会话段边界：压缩点优先落在边界上，而非死板的"最近 8 轮"
 * （调研文档 §9 增量 1：按语义/时间边界开新段，比固定轮数更贴会话语义）。 */
const SEGMENT_GAP_MS = 2 * 60 * 60 * 1000;

/** 对话覆盖段的确定性指纹（D1）：前端只回传不计算，服务端校验防串话。 */
export function dialogHash(
  turns: { role: string; content: string; ts?: number }[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(turns.map((t) => [t.role, t.content, t.ts ?? null])))
    .digest("hex")
    .slice(0, 32);
}

/**
 * 找最后一个段边界：相邻两轮 ts 间隔 > gapMs 时，后者是新段的开始。
 * 返回新段起始下标；无 ts 或无边界返回 -1（退回固定 8 轮口径）。
 */
export function dialogSegmentStart(
  dialog: { ts?: number; [key: string]: unknown }[],
  gapMs = SEGMENT_GAP_MS,
): number {
  let cut = -1;
  for (let i = 1; i < dialog.length; i++) {
    const a = dialog[i - 1].ts;
    const b = dialog[i].ts;
    if (a != null && b != null && b - a > gapMs) cut = i;
  }
  return cut;
}

/** 超预算封顶（纯函数）：从头部成对丢轮保末尾，永远保留至少一对。 */
export function trimDialogToBudget(
  dialog: { role: "user" | "assistant"; content: string }[],
  promptChars: number,
  budgetChars: number,
): { role: "user" | "assistant"; content: string }[] {
  const size = (list: typeof dialog) =>
    list.reduce((n, t) => n + t.content.length, 0) + promptChars;
  let out = dialog;
  while (out.length > 2 && size(out) > budgetChars) out = out.slice(2);
  return out;
}

export async function compactDialog(
  config: LlmConfig,
  dialog: { role: "user" | "assistant"; content: string; ts?: number }[],
  promptChars = 0,
  cached?: DialogSummary | null,
): Promise<{
  dialog: { role: "user" | "assistant"; content: string }[];
  summary?: DialogSummary;
}> {
  const budgetChars = Math.round(
    transcriptCharBudgetForConfig(config) * COMPACT_WINDOW_RATIO,
  );
  const projected =
    dialog.reduce((n, t) => n + t.content.length, 0) + promptChars;
  if (dialog.length <= ADVISOR_RECENT_TURNS)
    return { dialog: trimDialogToBudget(dialog, promptChars, budgetChars) };
  // D1 冻结摘要命中：覆盖段逐字未变 → [摘要轮, ...覆盖段之后原话]，
  // 两次压缩事件之间 append-only，云 API 前缀缓存可跨请求命中。
  if (
    cached &&
    cached.throughCount > 0 &&
    cached.throughCount < dialog.length
  ) {
    const covered = dialog.slice(0, cached.throughCount);
    if (dialogHash(covered) === cached.throughHash) {
      const tail = dialog.slice(cached.throughCount);
      const built = [
        {
          role: "user" as const,
          content: `（此前对话的背景摘要：${cached.text}）`,
        },
        ...tail,
      ];
      if (tail.length <= ADVISOR_TAIL_TURNS && projected <= budgetChars)
        return {
          dialog: trimDialogToBudget(built, promptChars, budgetChars),
          summary: cached,
        };
      // 尾巴攒多了或投影超预算 → 落到下面的新压缩事件
    }
  }
  // 新压缩事件：有 >2h 段边界就切在边界上（边界后的当前段保持原话，哪怕多于 8 轮），
  // 没有才退回"最近 8 轮"。
  const seg = dialogSegmentStart(dialog);
  const hasGapCut = seg > 0;
  const older = hasGapCut
    ? dialog.slice(0, seg)
    : dialog.slice(0, -ADVISOR_RECENT_TURNS);
  const recent = hasGapCut
    ? dialog.slice(seg)
    : dialog.slice(-ADVISOR_RECENT_TURNS);
  if (!older.length)
    return { dialog: trimDialogToBudget(dialog, promptChars, budgetChars) };
  // 增量压缩（ZCode/Claude-Code 式渐进压缩，2026-11-17）：旧摘要的覆盖段指纹仍匹配时，
  // 只喂"既有摘要+其后的新增轮次"让压缩器并入更新，不重读全部历史——压缩事件更便宜；
  // 指纹失配（对话被改/换人）才全量重摘
  const prevUsable =
    cached &&
    cached.throughCount > 0 &&
    cached.throughCount < older.length &&
    dialogHash(dialog.slice(0, cached.throughCount)) === cached.throughHash
      ? cached
      : null;
  const incrementalSpan = prevUsable ? older.slice(prevUsable.throughCount) : null;
  const raw = (
    prevUsable && incrementalSpan?.length
      ? [
          `（既有背景摘要，覆盖此前 ${prevUsable.throughCount} 轮）：${prevUsable.text}`,
          ...incrementalSpan.map(
            (t) => `${t.role === "user" ? "用户" : "顾问"}：${t.content}`,
          ),
        ]
      : older.map((t) => `${t.role === "user" ? "用户" : "顾问"}：${t.content}`)
  )
    .join("\n")
    .slice(0, 12_000);
  const sys =
    "把多轮顾问对话压成一段 ≤200 字的背景摘要：用户咨询的主线问题、已给过的关键结论、未决事项。若输入已含既有背景摘要，在其基础上并入其后的新增轮次，输出合并后的完整更新摘要。只输出摘要正文，不要评论。";
  try {
    // D4 摘要确定性：temp 0，同输入同摘要，前端缓存重放安全
    const text =
      config.protocol === "anthropic"
        ? advisorAnthropicText(
            await advisorAnthropicCall(config, sys, raw, [], {
              temperature: 0,
            }),
          )
        : advisorText(
            await advisorOpenAICall(
              config,
              [
                { role: "system", content: sys },
                { role: "user", content: raw },
              ],
              undefined,
              { temperature: 0 },
            ),
          );
    if (!text.trim())
      return { dialog: trimDialogToBudget(dialog, promptChars, budgetChars) };
    const summary: DialogSummary = {
      throughCount: older.length,
      throughHash: dialogHash(older),
      // 硬裁 ≤1500 字：dialogSummary 输入 schema 上限 2000，模型不听"≤200 字"的
      // 嘱咐时若原样放行，前端缓存后下轮请求 400，且重试永远带同一摘要=死循环
      text: text.trim().slice(0, 1500),
    };
    return {
      dialog: trimDialogToBudget(
        [
          { role: "user", content: `（此前对话的背景摘要：${text.trim()}）` },
          ...recent,
        ],
        promptChars,
        budgetChars,
      ),
      summary,
    };
  } catch {
    // 摘要调用失败不阻断顾问主流程，退回全量但封顶
    return { dialog: trimDialogToBudget(dialog, promptChars, budgetChars) };
  }
}

export async function advise(
  body: unknown,
  send?: (event: string, data: unknown) => void,
): Promise<{
  text: string;
  dialogSummary?: DialogSummary;
}> {
  const input = schema.parse(body);
  const config = activeConfig();
  if (!("engine" in config) || config.engine !== "llm")
    throw new ProviderError(
      400,
      "顾问对话需要 OpenAI 兼容模型，请在模型设置中选择非 Jev 协议的配置。",
    );
  const transcript = buildTranscript(
    input.messages,
    transcriptCharBudgetForConfig(config),
    { self: input.self, other: input.other },
  );
  const vs = input.valenceSummary;
  const up = input.userProfile;
  const bl = up?.baseline;
  const profileNote = up
    ? `对方画像（用户提供标签 + 机器统计基线，仅作校准背景，判断必须落在摘选原话上）：
${up.mbti ? `- 类型自测：${up.mbti.toUpperCase()}${MBTI_TYPES[up.mbti.toUpperCase()] ? `（${MBTI_TYPES[up.mbti.toUpperCase()].traits}）` : ""}\n` : ""}${up.style ? `- 沟通风格：${up.style === "avoidant" ? "偏回避型——慢回短回是其常态，别当冷淡" : up.style === "anxious" ? "偏焦虑型——高频长消息是其常态，别当强好感" : "偏安全型——节奏与内容大体一致"}\n` : ""}${up.recent ? `- 近况：${up.recent}\n` : ""}${bl ? `- 行为基线（机器统计，${bl.window}，n=${bl.sample}）：短回复占 ${Math.round(bl.shortReplyRate * 100)}%${bl.medianGapMin != null ? `，回复间隔中位数约 ${humanGap(bl.medianGapMin * 60000)}` : ""}${bl.initiationRate != null ? `，主动开聊 ${Math.round(bl.initiationRate * 100)}%` : ""}——候选说法的长度和预期回复节奏向对方习惯对齐，不要给对方习惯之外的过高回应门槛\n` : ""}`
    : "";
  const valenceNote = vs
    ? `对方情绪水位（本地规则聚合的确定性曲线，不是模型评分、不是好感度）：当前 ${vs.level}/100${
        vs.change7d != null
          ? `，近 7 天变化 ${vs.change7d > 0 ? "+" : ""}${vs.change7d}`
          : ""
      }${
        vs.negatives7d > 0
          ? `；近 7 天负信号 ${vs.negatives7d} 条`
          : "；近 7 天无明显负信号"
      }。解读约束：水位反映的是对方的情绪节奏而非喜欢程度——水位低或下行时，先接情绪、给空间，不要把低水位直接当成冷淡或回避的证据；水位高时也别把它当成可推进的证据。`
    : "";
  const contactProfileNote = input.contactProfile
    ? describeProfile(normalizeProfile(input.contactProfile, "advise"))
    : "";
  // 多轮续问的自适应注记：只在有对话历史时加（首问零成本），把小模型的注意力
  // 从"每轮原样重发的转写摘选"拉回对话连续性上（2026-11-11 用户实测 R1-8B 续问像新会话）
  const followUpNote = (input.dialog?.length ?? 0) > 0
    ? "（这是同一次咨询的续问，此前问答见消息历史：先接住上文，别当全新问题从头分析）\n"
    : "";
  // /goal 会话目标：用户设定后随每轮注入，建议优先服务它
  const goalNote = input.goal
    ? `（本次咨询目标：${input.goal}——所有判断与候选优先服务这个目标）\n`
    : "";
  // auto 模式注记：摘选只是当前语境，更早历史让模型自己用 search_history 检索
  const autoNote = input.mode === "auto"
    ? "（自动模式：下方摘选只是最近几条的当前语境；回答涉及更早历史时，先用 search_history 工具检索核实，不要凭空猜测）\n"
    : "";
  const prompt = `${followUpNote}${goalNote}${autoNote}${buildTacticsNote(input.question)}关系状态：${RELATIONS[input.relation]}
${valenceNote ? `${valenceNote}\n` : ""}${profileNote ? `${profileNote}\n` : ""}${contactProfileNote ? `${contactProfileNote}\n` : ""}聊天记录摘选（发送者：内容）：
${transcript}

用户的问题：${input.question}`;
  const anthropic = config.protocol === "anthropic";
  // D2：system 逐字稳定（ADVISOR_SYSTEM），战术参考已随 buildTacticsNote 进尾部 prompt
  const systemPrompt = ADVISOR_SYSTEM;
  // 多轮对话先压缩（>8 轮或投影超窗口 70% 把更早的压成摘要）再进 prompt；
  // D1：带上前端缓存的冻结摘要，命中则零成本复用、不重摘
  const { dialog, summary } = await compactDialog(
    config,
    input.dialog ?? [],
    prompt.length,
    input.dialogSummary,
  );
  let text: string;
  // 流式通道（2026-11-18）：send 存在时思考过程/工具动作/正文增量实时推给前端；
  // anthropic 协议暂无流式（done 一次性返回）。非流式调用方（/api/advise）行为不变。
  const on = send
    ? {
        onReasoning: (chunk: string) => send("reasoning", { text: chunk }),
        // 正文增量：工具循环的每一轮（含最终回答轮）都要转发——2026-11-19 根修：
        // 之前 onContent 只接在无工具分支，带 contactId 的真实 UI 请求走工具循环，
        // 正文从未流式过（只在 done 一次性落地），前端"思考中"卡到底才出全文。
        onContent: (chunk: string) => send("delta", { text: chunk }),
        note: (text: string) => send("note", { text }),
      }
    : undefined;
  if (anthropic) {
    text = advisorAnthropicText(
      await advisorAnthropicCall(config, systemPrompt, prompt, dialog),
    );
  } else {
    const baseMessages = [
      { role: "system", content: systemPrompt },
      ...dialog,
      { role: "user", content: prompt },
    ];
    // 带 contactId → harness 工具循环（search_history/get_profile/score_draft）；
    // 无 contactId 但有自配知识库 → 也启用循环，只为 search_knowledge（其余工具由
    // executeTool 的 contactId 守卫自兜底）；端点不支持 function calling 时自动回退单发。
    text = input.contactId || loadKnowledge().length
      ? await advisorToolLoop(config, baseMessages, {
          contactId: input.contactId ?? "",
        }, on)
      : on
        ? advisorText(await advisorStreamCall(config, baseMessages, on))
        : advisorText(await advisorOpenAICall(config, baseMessages));
  }
  return {
    text: await selfReviewCandidates(text.trim()),
    // D1：新压缩事件（或透传命中的旧摘要）随响应返回，前端缓存后随下轮带回
    dialogSummary: summary,
  };
}

type OpenAIMessage = Record<string, unknown>;

export async function advisorOpenAICall(
  config: LlmConfig,
  messages: OpenAIMessage[],
  tools?: unknown,
  extraBody?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      ...fastInferenceOptions(config),
      ...(extraBody ?? {}),
      messages,
      ...(tools ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    // 上游 4xx 原样保留（工具循环首轮 4xx → 去 tools 重试的兜底依赖 status 区间；
    // 400 被映射成 502 会让兜底变死代码——硅基流动 R1/Xing 等不支持 function
    // calling 的模型实测 400，见 tests/advisor-status.test.ts）；5xx 统一 502。
    throw new ProviderError(
      response.status >= 400 && response.status < 500
        ? response.status
        : 502,
      `顾问调用失败（HTTP ${response.status}）${(error as any)?.error?.message ? `：${(error as any).error.message}` : ""}`,
    );
  }
  const data = await response.json();
  // D5 命中率观测：响应里现成字段 log 一行即验收证据，不建观测层（调研文档 §6.2 D5）
  const cachedTokens = data?.usage?.prompt_tokens_details?.cached_tokens;
  if (cachedTokens != null)
    console.log(
      `[advise] prompt cache hit ${cachedTokens}/${data?.usage?.prompt_tokens ?? "?"} tokens (${config.model})`,
    );
  return data;
}

/** 流式顾问调用：stream:true + 增量回调（reasoning→前端"思考中"，content→正文）。
 * 返回与非流式同构 envelope——advisorText/工具循环零改动。 */
export async function advisorStreamCall(
  config: LlmConfig,
  messages: OpenAIMessage[],
  on: { onReasoning?: (chunk: string) => void; onContent?: (chunk: string) => void },
  tools?: unknown,
): Promise<any> {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      ...fastInferenceOptions(config),
      messages,
      stream: true,
      ...(tools ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(180000), // 思考型模型流式全程可能超 120s，放宽
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ProviderError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      `顾问调用失败（HTTP ${response.status}）${(error as any)?.error?.message ? `：${(error as any).error.message}` : ""}`,
    );
  }
  return streamLlmResponse(response, on, "顾问模型");
}

export function advisorText(data: any): string {
  const t = data?.choices?.[0]?.message?.content;
  if (typeof t !== "string" || !t.trim())
    throw new ProviderError(502, "模型没有返回内容，请重试。");
  return t.trim();
}

async function advisorAnthropicCall(
  config: LlmConfig,
  systemPrompt: string,
  prompt: string,
  dialog: { role: "user" | "assistant"; content: string }[],
  extraBody?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      ...(extraBody ?? {}),
      system: systemPrompt,
      messages: [...dialog, { role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ProviderError(
      response.status >= 400 && response.status < 500
        ? response.status
        : 502,
      `顾问调用失败（HTTP ${response.status}）${(error as any)?.error?.message ? `：${(error as any).error.message}` : ""}`,
    );
  }
  const data = await response.json();
  // D5：anthropic 口径的命中字段不同，同样只 log 一行
  const cacheRead = data?.usage?.cache_read_input_tokens;
  if (cacheRead != null)
    console.log(
      `[advise] anthropic cache read ${cacheRead} tokens (${config.model})`,
    );
  return data;
}

function advisorAnthropicText(data: any): string {
  const t = (data?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
  if (typeof t !== "string" || !t.trim())
    throw new ProviderError(502, "模型没有返回内容，请重试。");
  return t.trim();
}

/**
 * 工具循环：模型可调用 search_history/get_profile/score_draft（单轮最多 6 次），
 * 最多 TOOL_LOOP_MAX_ROUNDS 轮；轮次用尽后不带工具强制收口。
 * 首轮 4xx（401 除外）视为端点不支持 function calling → 回退单发模式，且
 * 只有回退成功才记负样本（上下文超长等 4xx 去不去 tools 都挂，不算 tools 拒因）
 * ——见 server/tool-support.ts 自适应缓存，之后对该模型直接单发不再先挨 400。
 */
export async function advisorToolLoop(
  config: LlmConfig,
  baseMessages: OpenAIMessage[],
  ctx: ToolContext,
  on?: {
    onReasoning?: (chunk: string) => void;
    onContent?: (chunk: string) => void;
    note?: (text: string) => void;
  },
): Promise<string> {
  // 已学到"该模型不支持 tools"→ 直接单发，不再打注定 400 的第一枪
  if (toolsKnownUnsupported(config.endpoint, config.model))
    return advisorText(await advisorOpenAICall(config, baseMessages));
  let messages = baseMessages;
  for (let round = 0; round < TOOL_LOOP_MAX_ROUNDS; round++) {
    let data: any;
    try {
      // 流式回调（含 onContent）随每一轮转发：工具轮正文通常为空（delta 空、无害），
      // 最终回答轮的正文增量由此真正到达前端（2026-11-19 流式根修）
      data = on?.onReasoning || on?.onContent
        ? await advisorStreamCall(
            config,
            messages,
            { onReasoning: on.onReasoning, onContent: on.onContent },
            ADVISOR_TOOLS,
          )
        : await advisorOpenAICall(config, messages, ADVISOR_TOOLS);
    } catch (e) {
      const status = (e as any)?.status;
      if (
        round === 0 &&
        e instanceof ProviderError &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 401
      ) {
        const text = advisorText(await advisorOpenAICall(config, messages));
        markToolsUnsupported(config.endpoint, config.model);
        return text;
      }
      throw e;
    }
    const msg = data?.choices?.[0]?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) return advisorText(data);
    messages = [...messages, msg];
    for (const tc of toolCalls.slice(0, 6)) {
      on?.note?.(
        `🔧 ${String(tc?.function?.name ?? "工具")}：${String(tc?.function?.arguments ?? "").slice(0, 60)}`,
      );
      const result = await executeTool(
        String(tc?.function?.name ?? ""),
        String(tc?.function?.arguments ?? ""),
        ctx,
      );
      messages.push({
        role: "tool",
        tool_call_id: String(tc?.id ?? ""),
        content: result,
      });
    }
    // 超过 6 个被截断的调用也要补 tool 响应——call/answer 不配对会被上游 400
    // （2026-11-19 bug 审查 P3）
    for (const tc of toolCalls.slice(6)) {
      messages.push({
        role: "tool",
        tool_call_id: String(tc?.id ?? ""),
        content: "（本轮工具调用次数超限，未执行）",
      });
    }
  }
  return advisorText(await advisorOpenAICall(config, messages));
}

// ---------- 判官通道（候选自审 / 发前体检） ----------
// 判官 = model.json 里启用的本地评估模型（性能红线：打分不走红云端）。
// 本地 judge 不可用时一切自审静默跳过/标注未校准，绝不阻断顾问主流程。
// judgeChat 网络调用见 server/judge-chat.ts（与 advisor-tools 的 score_draft 共用）。

/** 从顾问回复里抽候选说法（system prompt 约定的「说法：」行）；抽不到就算了。 */
export function extractCandidates(text: string): string[] {
  const out: string[] = [];
  // 先剥 **加粗**（模型会把「说法」标签加粗成 **说法**：，裸正则会被标签后的 * 卡住）
  const flat = text.replace(/\*\*/g, "");
  const re = /^\s*(?:[-*\d.)、①②③\s]*)说法[：:]\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    const line = m[1]
      .trim()
      .replace(/^["「『]/, "")
      .replace(/["」』]$/, "")
      .trim();
    if (line) out.push(line);
    if (out.length >= 5) break;
  }
  return out;
}

const reviewSchema = z.object({
  best: z.number().int().min(1).max(5),
  scores: z
    .array(
      z.object({
        index: z.number().int().min(1).max(5),
        threshold: z.number().min(0).max(100),
        risk: z.number().min(0).max(100),
        note: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(5),
});

/** 解析判官评分（模型无关：容忍字符串数字/百分号/缺 note，best 缺省取门槛最低者）。 */
export function parseJudgeScores(raw: string): z.infer<typeof reviewSchema> {
  const o = extractJsonObject(raw) as Record<string, unknown>;
  const rawScores = Array.isArray(o.scores)
    ? o.scores
    : Array.isArray(o)
      ? o
      : [];
  const scores = rawScores
    .map((s) => {
      const it = (s ?? {}) as Record<string, unknown>;
      const index = coerceNum(it.index) ?? coerceNum(it.i) ?? 0;
      const threshold = Math.min(
        100,
        Math.max(0, coerceNum(it.threshold ?? it.门槛) ?? 50),
      );
      const risk = Math.min(100, Math.max(0, coerceNum(it.risk ?? it.风险) ?? 50));
      const note = typeof it.note === "string" ? it.note : undefined;
      return { index: Math.round(index), threshold: Math.round(threshold), risk: Math.round(risk), note };
    })
    .filter((s) => s.index >= 1 && s.index <= 20);
  if (!scores.length) throw new Error("判官评分里没有可用条目");
  const bestRaw = coerceNum(o.best);
  const best =
    bestRaw && bestRaw >= 1 && bestRaw <= scores.length
      ? Math.round(bestRaw)
      : [...scores].sort((a, b) => a.threshold - b.threshold)[0].index;
  return reviewSchema.parse({ best, scores });
}

/**
 * 候选自审：候选 ≥2 且本地判官可用时，让判官按回应门槛/风险给每个候选打分，
 * 把推荐追加到回复末尾。任何失败（无判官/解析失败/超时）都原样返回，不阻断。
 */
async function selfReviewCandidates(text: string): Promise<string> {
  let candidates: string[];
  let judge: JudgeConfig | null;
  try {
    candidates = extractCandidates(text);
    judge = judgeConfig();
  } catch {
    return text;
  }
  if (candidates.length < 2 || !judge) return text;
  if (judge.protocol === "jev") return text; // Jev 原生判官无 chat 打分形态，静默跳过
  try {
    const listing = candidates.map((c, i) => `候选${i + 1}：${c}`).join("\n");
    const raw = await judgeChat(
      judge,
      '你是聊天草稿评审。对每个候选说法按两个维度打 0-100 分：threshold=回应门槛（对方接话需要付出的努力，越低越容易接）、risk=翻车风险。严格输出 JSON：{"best":推荐候选序号,"scores":[{"index":序号,"threshold":0,"risk":0,"note":"一句话理由"}]}，不要输出其他内容。',
      `聊天上下文里用户准备发的候选说法：\n${listing}`,
    );
    const review = parseJudgeScores(raw);
    const lines = review.scores
      .filter((s) => s.index >= 1 && s.index <= candidates.length)
      .map(
        (s) =>
          `- 候选${s.index}：回应门槛 ${Math.round(s.threshold)}/100，风险 ${Math.round(s.risk)}/100${s.note ? `——${s.note}` : ""}`,
      );
    if (!lines.length) return text;
    const best =
      review.best >= 1 && review.best <= candidates.length
        ? `\n判官推荐：候选${review.best}（回应门槛最低、最容易被接住）。`
        : "";
    return `${text}\n\n——\n判官自审（本地判官对候选的门槛/风险打分，仅供参考）：\n${lines.join("\n")}${best}`;
  } catch {
    return text; // 自审失败不影响顾问主回复
  }
}

const checkSchema = z.object({
  draft: z.string().min(1).max(2000),
  messages: z
    .array(
      z.object({
        sender: z.enum(["self", "other"]),
        text: z.string().max(12000),
        timestamp: z.string().max(80).nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
  self: z.string().min(1).max(80).optional(),
  other: z.string().min(1).max(80).optional(),
});

const draftCheckSchema = z.object({
  threshold: z.number().min(0).max(100),
  warmth: z.enum(["克制", "温和", "热络"]),
  risk: z.number().min(0).max(100),
  riskNote: z.string().max(500),
  comments: z
    .array(
      z.object({
        quote: z.string().max(200),
        note: z.string().max(300),
      }),
    )
    .max(10),
  rewrite: z.string().max(1000),
});

export type DraftCheck =
  | { available: true; check: z.infer<typeof draftCheckSchema> }
  | { available: false; message: string };

/** 解析判官的草稿体检 JSON（模型无关：字符串数字/枚举模糊匹配/缺字段兜底）。 */
export function parseDraftCheck(raw: string): z.infer<typeof draftCheckSchema> {
  const o = extractJsonObject(raw) as Record<string, unknown>;
  const num = (v: unknown, d: number) =>
    Math.round(Math.min(100, Math.max(0, coerceNum(v) ?? d)));
  const wRaw = String(o.warmth ?? "");
  const warmth = wRaw.includes("热")
    ? "热络"
    : wRaw.includes("温") || wRaw.includes("和")
      ? "温和"
      : "克制";
  const comments = Array.isArray(o.comments)
    ? o.comments
        .map((c) => {
          const it = (c ?? {}) as Record<string, unknown>;
          const quote = String(it.quote ?? it.sentence ?? "").slice(0, 200);
          const note = String(it.note ?? it.comment ?? "").slice(0, 300);
          return quote || note ? { quote, note } : null;
        })
        .filter((c): c is { quote: string; note: string } => !!c)
        .slice(0, 10)
    : [];
  return draftCheckSchema.parse({
    threshold: num(o.threshold, 50),
    warmth,
    risk: num(o.risk, 50),
    riskNote: String(o.riskNote ?? o.risk_note ?? "").slice(0, 500),
    comments,
    rewrite: String(o.rewrite ?? "").slice(0, 1000),
  });
}

/**
 * 发前体检：草稿 + 最近上下文 → 本地判官出三维评分（回应门槛/温度/风险）+
 * 逐句点评 + 一条改写。判官未配置时返回 available:false（前端标注"未校准"）。
 */
/** /compact 指令的后端（2026-11-18）：立即跑一次压缩事件，返回新摘要——不生成回答。
 * 对话 ≤8 轮时 compactDialog 直接返回原样（无 summary），前端据此提示"还短，无需压缩"。 */
const compactBodySchema = z.object({
  dialog: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
        ts: z.number().optional(),
      }),
    )
    .max(200),
  dialogSummary: z
    .object({
      throughCount: z.number().int().min(1),
      throughHash: z.string().min(8).max(64),
      text: z.string().min(1).max(2000),
    })
    .optional(),
});

export async function compactNow(body: unknown): Promise<{ summary?: DialogSummary }> {
  const input = compactBodySchema.parse(body);
  const config = activeConfig();
  if (!("engine" in config) || config.engine !== "llm")
    throw new ProviderError(
      400,
      "压缩需要 OpenAI 兼容模型，请在模型设置中选择非 Jev 协议的配置。",
    );
  const { summary } = await compactDialog(
    config,
    input.dialog ?? [],
    0,
    input.dialogSummary,
  );
  return { summary };
}

export async function checkDraft(body: unknown): Promise<DraftCheck> {
  const input = checkSchema.parse(body);
  const judge = judgeConfig();
  if (!judge)
    return {
      available: false,
      message: "本地判官未配置（模型设置里开启评估模型后可用）。",
    };
  if (judge.protocol === "jev")
    return {
      available: false,
      message: "判官为 Jev 原生协议（systemone 概率读出），不支持草稿体检。",
    };
  // 判官侧预算封顶（judgeTranscriptChars）：此前 200 条×12000 字符无上限，
  // 长会话会把 16k 本地判官直接撑爆
  const transcript = buildTranscript(
    (input.messages ?? []) as { sender: string; text: string; timestamp?: string | null }[],
    judgeTranscriptChars(judge.model, judge.contextTokens),
    { self: input.self, other: input.other },
  );
  const raw = await judgeChat(
    judge,
    '你是聊天草稿体检员。给用户准备发送的草稿打分：threshold=回应门槛 0-100（越低对方越容易接）、warmth=温度（克制/温和/热络）、risk=翻车风险 0-100、riskNote=最可能翻车的点、comments=逐句点评（quote 引原句、note 一句点评）、rewrite=一条更稳的改写。严格输出 JSON：{"threshold":0,"warmth":"温和","risk":0,"riskNote":"","comments":[],"rewrite":""}，不要输出其他内容。',
    transcript
      ? `最近对话：\n${transcript}\n\n草稿：\n${input.draft}`
      : `草稿：\n${input.draft}`,
    90_000,
  );
  return { available: true, check: parseDraftCheck(raw) };
}

export function adviseErrorMessage(error: unknown) {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof z.ZodError) return "顾问请求格式不正确。";
  return providerErrorMessage(error);
}
