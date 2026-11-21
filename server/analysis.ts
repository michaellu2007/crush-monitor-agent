import { visibleLength } from "../shared/trivial";
import { ANALYSIS_GUARD as guard } from "../shared/analysis-guard";
import { MBTI_TYPES } from "../shared/mbti";
import { EVENT_KINDS } from "../shared/memory";
import { AFFINITY_DIMENSIONS, composeAffinity } from "../shared/affinity";
import { MAX_MESSAGES, MAX_TEXT_CHARS } from "../shared/limits";
import { INTENTS } from "../shared/intents";
import { EMOTIONS, TARGETS } from "../shared/labels";
import { choice, score, noul, type Questions } from "@typesafe-ai/sdk";
import { evaluate } from "./provider";
import { debiasChoiceOrders } from "./debias";
import { condenseMessages, stateMessagesBudget } from "./context-budget";
import type { ActiveConfig, JevJudgeConfig } from "./model-config";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MODEL,
  RUBRIC,
  RELATIONS,
  requestContextKey,
  type AnalysisRequest,
  type AnalysisResponse,
} from "../shared/types";
import {
  judgment,
  actionResult,
  safeStage,
  choiceAnswer,
  noulAnswer,
} from "../shared/rules";
import { parseTs, humanGap } from "../shared/segments";
export const requestSchema = z
  .object({
    memory: z
      .array(
        z.object({
          id: z.string().max(80),
          kind: z.enum(
            Object.keys(EVENT_KINDS) as [
              keyof typeof EVENT_KINDS,
              ...(keyof typeof EVENT_KINDS)[],
            ],
          ),
          status: z.enum(["active", "resolved", "uncertain"]),
          resolvedBy: z.string().max(80).optional(),
        }),
      )
      .max(12)
      .optional(),
    revision: z.number().int().nonnegative(),
    relation: z.enum(["crush", "new", "couple"]),
    contextNotes: z.string().max(2000).optional(),
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
    relationLabel: z.string().max(120).optional(),
    task: z.enum(["overview", "other_messages", "self_message"]),
    targetIds: z.array(z.string().max(80)).max(20),
    messages: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          sender: z.enum(["self", "other"]),
          text: z
            .string()
            .min(1)
            .refine((t) => Array.from(t).length <= MAX_TEXT_CHARS),
          timestamp: z.string().max(80).nullable(),
          kind: z.enum(["text", "unreadable"]),
        }),
      )
      .min(1)
      .max(MAX_MESSAGES),
  })
  .superRefine((v, ctx) => {
    if (
      v.messages.reduce((n, m) => n + Array.from(m.text).length, 0) >
      MAX_TEXT_CHARS
    )
      ctx.addIssue({ code: "custom", message: "聊天过长，请缩小范围" });
    if (
      v.memory?.some(
        (e) =>
          !v.messages.some((m) => m.id === e.id) ||
          (e.resolvedBy && !v.messages.some((m) => m.id === e.resolvedBy)),
      )
    )
      ctx.addIssue({ code: "custom", message: "历史证据缺少原话" });
    if (new Set(v.messages.map((m) => m.id)).size !== v.messages.length)
      ctx.addIssue({ code: "custom", message: "重复消息ID" });
    if (v.targetIds.some((id) => !v.messages.some((m) => m.id === id)))
      ctx.addIssue({ code: "custom", message: "目标消息不存在" });
    if (
      v.task === "self_message" &&
      (!v.targetIds.length ||
        v.targetIds.some(
          (id) => v.messages.find((m) => m.id === id)?.sender !== "self",
        ))
    )
      ctx.addIssue({ code: "custom", message: "我方目标无效" });
    if (
      v.task === "other_messages" &&
      (!v.targetIds.length ||
        v.targetIds.some(
          (id) => v.messages.find((m) => m.id === id)?.sender !== "other",
        ))
    )
      ctx.addIssue({ code: "custom", message: "对方目标无效" });
  });
const quality: [string, string, ...string[]] = [
  "明显冒犯、强迫或无视已表达的边界",
  "明显不合语境、施压、查户口式追问，或错过关键情绪",
  "基本合适但平淡、泛泛，推进空间有限",
  "具体接住对方话题或情绪，或话头清晰好接，自然而不施压",
  "非常贴合、有趣或体贴，同时给对方舒适的表达空间",
];
const rapport: [string, string, ...string[]] = [
  "明显互相误解或冲突未被回应",
  "多次错过对方的表达重点",
  "基本能接上彼此的表达",
  "持续具体回应彼此的重点",
  "多处具体理解、支持和协调",
];
const enough = {
  sufficient: "上下文足以判断该维度，包括清晰的负向或正向证据",
  limited: "可以有大致解读，但仍有明显歧义",
  insufficient: "信息不足，比如孤立含糊短句、不可见附件，无法判断",
};
const actions = {
  continue: "接住已有话题继续聊",
  ask: "问一个具体轻松问题",
  empathize: "先回应倾诉或不满的感受",
  flirt: "已有被相互接纳的暧昧，可轻轻调情",
  invite: "有足够相互投入和共同兴趣，可以低压力邀约",
  clarify: "意思关键且含糊，需要温和确认",
  wait: "我方已发出需要对方回应的信息，应先等待",
  close: "对方忙或表达结束，本次先收尾",
  respect: "对方明确拒绝接近或要求停止，要尊重边界",
  insufficient: "上下文不足，无法建议",
};
// ponytail: gap needs full date+time; bare "21:53" has no anchor. see shared/segments.
const replyGaps = (messages: AnalysisRequest["messages"]) => {
  const gaps = new Map<string, string>();
  let prev: number | null = null;
  for (const m of messages) {
    const t = parseTs(m.timestamp);
    if (prev !== null && t !== null && t - prev >= 60000)
      gaps.set(m.id, humanGap(t - prev));
    if (t !== null) prev = t;
  }
  return gaps;
};
/**
 * 判官盲区补丁（判官模型评测报告 2026-10-26 第四节）：Qwen3.5-9B 与 JevK5-9B 共同把
 * 爽快答应语境的「行行行」判成 negative——叠词积极语气恰是邀约/答应场景高频形态，
 * 不修则决策树分支概率整体偏悲观。无前置条件注入（区别于 baselineNote 的定向注入）。
 */
const REDUP_NOTE =
  "无负面上下文时，叠词爽快回应（行行行/好好好/可以可以/走走走）默认判积极——常见于爽快答应或欣然同意，不是敷衍或不耐烦。";
const REDUP_INTENT_NOTE =
  "无负面上下文时，叠词爽快回应（行行行/好好好/可以可以/走走走）常是爽快答应，优先按 agree、continue 等延续类候选解读，不是敷衍或想收尾。";

export function buildRequest(input: AnalysisRequest, maxMessagesChars?: number) {
  const targetIndex =
    input.task === "self_message"
      ? Math.min(
          ...input.targetIds.map((id) =>
            input.messages.findIndex((m) => m.id === id),
          ),
        )
      : -1;
  let messages =
    input.task === "self_message"
      ? input.messages.slice(
          0,
          targetIndex + (input.targetIds.length === 1 ? 1 : 0),
        )
      : input.messages;
  const ids = new Map(input.messages.map((m, i) => [m.id, String(i)]));
  const gaps = replyGaps(input.messages);
  // 判官窗口预算：超限 keep-recent 钳制（丢弃最旧、保留最近与被判目标，附注记
  // 告知判官）。16k 本地判官对现有段形状（≤9000 字）no-op；只在小窗口判官或
  // 9k-12k 字的多选/长消息请求生效——那正是 Ollama 静默左 eviction 的区间。
  // 见 docs/agent上下文设计.md §3.1。
  let omittedMessages = 0;
  if (maxMessagesChars) {
    const condensed = condenseMessages(
      messages,
      maxMessagesChars,
      new Set(input.targetIds),
    );
    if (condensed.omitted) {
      messages = condensed.messages;
      omittedMessages = condensed.omitted;
    }
  }
  const compact = (m: AnalysisRequest["messages"][number]) => ({
    id: ids.get(m.id)!,
    sender: m.sender,
    text: m.text,
    ...(m.timestamp ? { timestamp: m.timestamp } : {}),
    ...(gaps.get(m.id) ? { gap: gaps.get(m.id)! } : {}),
    ...(m.kind === "unreadable" ? { kind: m.kind } : {}),
  });
  const state = {
    relationship: input.relationLabel?.trim() || RELATIONS[input.relation],
    ...(input.contextNotes
      ? {
          contextNotes: input.contextNotes,
          contextNotesNote:
            "contextNotes 是 self 本人提供的场外信息（现实事件、性格理解等），可能有主观偏差：只作为理解聊天记录的背景，不能替代或优先于聊天原话证据。",
        }
      : {}),
    ...(input.userProfile
      ? {
          userProfile: {
            ...(input.userProfile.mbti
              ? {
                  mbti: input.userProfile.mbti.toUpperCase(),
                  ...(MBTI_TYPES[input.userProfile.mbti.toUpperCase()]
                    ? {
                        mbtiProfile:
                          MBTI_TYPES[
                            input.userProfile.mbti.toUpperCase()
                          ].traits,
                      }
                    : {}),
                  mbtiNote:
                    "MBTI 是用户自测的性格标签，mbtiProfile 是该类型的典型沟通习惯描述：只用于校准解读、避免把性格常态误读成态度变化，不是证据，不能由它推断好感、意图或关系走向。",
                }
              : {}),
            ...(input.userProfile.style
              ? {
                  style: input.userProfile.style,
                  styleNote:
                    input.userProfile.style === "avoidant"
                      ? "对方沟通风格偏回避型：回复慢、短、少是其常态，不要因此推断冷淡或疏远；以原话内容和阶段性变化为准，单次慢回不算降温证据。"
                      : input.userProfile.style === "anxious"
                        ? "对方沟通风格偏焦虑型：高频、长消息是其常态，不要因消息多就推断好感强；以内容质量和相互投入解读。"
                        : "对方沟通风格偏安全型：回复节奏与内容大体一致，按常规证据解读即可。",
                }
              : {}),
            ...(input.userProfile.recent
              ? {
                  recent: input.userProfile.recent,
                  recentNote:
                    "近况是 self 自述的现实背景，帮助理解语境（考试、换工作、生病等），不构成聊天原话证据。",
                }
              : {}),
            ...(input.userProfile.baseline
              ? {
                  baseline: input.userProfile.baseline,
                  baselineNote:
                    "baseline 是机器从完整聊天记录统计的对方行为基线（客观事实，非人工评价、非模型评分）：shortReplyRate=对方文本消息中短回复（剥掉表情标点后≤4字）的占比；medianGapMin=对方回复间隔中位数（分钟）；initiationRate=由对方主动开启会话的占比。只用于校准解读：若简短、慢回是对方常态，单次简短或慢回不构成态度变化证据；基线描述习惯，不是对具体某条消息情绪或意图的证据。",
                }
              : {}),
          },
        }
      : {}),
    timeGapNote:
      "消息的 gap 是与上一条消息的时间间隔。明显更长的间隔意味着更高的回应成本：回复变慢、间隔拉长通常是热度下降或回避的信号；长期高频率、短间隔说明投入度高。把它作为节奏证据，但单次间隔不足以定性。",
    messages: messages.map(compact),
    ...(omittedMessages
      ? {
          messagesNote: `更早的 ${omittedMessages} 条消息因判官上下文窗口预算被省略，只保留最近内容；对省略部分不能脑补证据，证据只落在可见原话上。`,
        }
      : {}),
    ...(input.task === "overview"
      ? {
          conversationEnd: messages.at(-1) ? compact(messages.at(-1)!) : null,
          historicalEvidence: (input.memory ?? []).map((e) => ({
            sourceId: ids.get(e.id)!,
            eventCandidate: EVENT_KINDS[e.kind],
            previousStatus: e.status,
            resolutionSourceId: e.resolvedBy
              ? (ids.get(e.resolvedBy) ?? null)
              : null,
          })),
        }
      : {}),
  };
  const questions: Questions = {};
  const ask = (s: string) => `${guard} ${s}`;
  const ev = (s: string) => choice(ask(`是否有足够文本证据判断${s}？`), enough);
  if (input.task === "overview") {
    for (const d of AFFINITY_DIMENSIONS) {
      questions[`affinity_${d.key}`] = score(
        ask(
          `${d.question} 只评价 other 对 self。按消息顺序理解，近期明确表达优先于早期已被撤回的信号；不能凭没有展示的经历补证据。historicalEvidence 是从原话提取的候选背景，不是已确认事实；核对原文，以近期交流评价当前状态，旧的关心不能掩盖近期拒绝。`,
        ),
        [...d.levels],
      );
      questions[`affinity_${d.key}_enough`] = ev(
        `${d.label}，需有相关表达或互动机会；没出现相关场景不能当成负面证据`,
      );
    }
    const historyIds = new Set((input.memory ?? []).map((e) => e.id));
    const recentCandidates = Object.fromEntries([
      ["none", "没有明确后续原话"],
      ...messages
        .filter((m) => !historyIds.has(m.id))
        .slice(-80)
        .map((m) => [ids.get(m.id)!, null]),
    ]);
    for (const event of input.memory ?? []) {
      questions[`memory_${event.id}_status`] = choice(
        ask(
          `核对消息ID ${ids.get(event.id)} 所表达的事件（候选类别：${EVENT_KINDS[event.kind]}），在后续实际聊天中现在是什么状态？先前的模型分类和状态不是事实，必须依据原话。忙碌或换话题不代表撤回拒绝；未提到后续不能认为已解决。`,
        ),
        {
          active: "仍有效或尚待回应，没有明确结束证据",
          resolved: "后续原话明确兑现、取消、回答、撤回或纠正了这件具体事情",
          uncertain: "有歧义，无法判定是否仍有效",
        },
      );
      questions[`memory_${event.id}_proof`] = choice(
        ask(
          `哪条后续原话最直接证明消息ID ${ids.get(event.id)} 的具体事件已被兑现、取消、回答、撤回或纠正？必须对应同一件事；没有就选none。`,
        ),
        recentCandidates,
      );
    }
    questions.enough = ev("当前互动默契");
    if (input.relation === "couple")
      questions.rapport = score(
        ask("评价两人当前可见互动的默契程度。"),
        rapport,
      );
    else
      questions.stage = choice(
        ask(
          "这段交流最高支持哪一个关系里程碑？必须有直接证据，不能把日常交流当成表白。",
        ),
        {
          unknown: "无法确定",
          contact: "只建立联系",
          flow: "互相交流、话题接得起来",
          flirt: "有相互暧昧的直接信号",
          date: "双方已有具体约会安排",
          mutual: "双方明确表达恋爱心意",
        },
      );
    questions.action = choice(
      ask(
        "综合当前可见对话、近期氛围、关系状态和历史原话，self 现在下一步最适合做什么？conversationEnd 标明本次分析覆盖到的位置，不要求只针对最后一句话给建议。历史里仍相关的事情可以作为建议依据，但已被回复、解决、取消或新信息改变的事情，不能当成仍待回应的旧状态。",
      ),
      actions,
    );
    questions.boundary = noul(
      ask(
        "other 是否明确表达了当前仍有效的拒绝追求、拒绝恋爱、不要联系或停止推进的边界？已被后续明确撤回的旧拒绝不算；忙碌、单次没空、玩笑不等于拒绝恋爱。",
      ),
    );
    questions.pending = noul(
      ask(
        "conversationEnd 是 self 发出的，且尚未得到 other 回应、适合先等对方接球吗？conversationEnd.sender 若是 other，答案为否；不要把历史里已收到回应的 self 消息算作等待。",
      ),
    );
    const candidates = Object.fromEntries([
      ["none", "没有直接证据"],
      ...messages
        .filter((m) => m.kind === "text")
        .slice(-200)
        .map((m) => [ids.get(m.id)!, null]),
    ]);
    questions.evidence = choice(
      ask("哪条消息最直接体现 other 对 self 的接近或疏远信号？"),
      candidates,
    );
    questions.actionEvidence = choice(
      ask(
        "综合当前聊天氛围、关系和事情的最新进展，哪条原话最直接支持 self 现在的下一步交流需求？可以选择近期或历史消息，但需要确认它仍适用于当前状态；不要因为旧消息曾经重要就忽略后续回答、解决、取消或变化。没有直接证据就选 none。",
      ),
      candidates,
    );
  } else {
    for (const id of input.targetIds) {
      const m = input.messages.find((m) => m.id === id);
      if (!m || m.kind !== "text") continue;
      if (input.task === "other_messages") {
        // 实测基线只注入"短回复"目标（剥掉表情标点 ≤4 字）的情绪/意图题——
        // 高占比=常态校准（别把 TA 的日常短回复当冷淡），低占比=偏离习惯提示。
        // 无基线或非短消息时题目文本与原先逐字一致（U 节"三处定向使用"之一）。
        const bl = input.userProfile?.baseline;
        const baselineNote =
          bl && visibleLength(m.text) <= 4
            ? `对方行为基线（机器统计，${bl.window}，n=${bl.sample}）：短回复占 ${Math.round(bl.shortReplyRate * 100)}%${
                bl.medianGapMin != null
                  ? `，回复间隔中位数约 ${humanGap(bl.medianGapMin * 60000)}`
                  : ""
              }。${
                bl.shortReplyRate >= 0.5
                  ? "此类简短回复是对方常态：简短本身不构成冷淡或想结束的证据，重点看本条是否回应了前文、对方之后是否延续。"
                  : "对方平时很少这样短回，本条偏离其习惯，更值得结合前后文留意；但单凭简短仍不足以定性。"
              }`
            : "";
        questions[`${id}_event`] = choice(
          ask(
            `消息ID ${ids.get(id)} 本身明确表达哪类值得保留的事件？结合前后文理解，不能把暗示推断成事实。`,
          ),
          EVENT_KINDS,
        );
        questions[`${id}_emotions`] = choice(
          ask(
            `${baselineNote}目标消息ID ${ids.get(id)}，sender=other。结合上下文判断这句话最可能表达的主要情绪。考虑玩笑、反话与多义；返回各个候选情绪的分布，不评价好感强度。${REDUP_NOTE}`,
          ),
          Object.fromEntries(
            Object.entries(EMOTIONS).map(([k, v]) => [k, v.criteria]),
          ),
        );
        questions[`${id}_targets`] = choice(
          ask(
            `目标消息ID ${ids.get(id)}，sender=other。这句话的情绪与态度指向谁？结合前后文找对象，前文提到的事件、他人或争执都要纳入。关键区分：即使用了脏话或重话，只要针对第三方的人或事，就不是对 self 的不满。语气词、口头禅式的感叹没有具体对象。指向混合时按最主导的对象判断。`,
          ),
          Object.fromEntries(
            Object.entries(TARGETS).map(([key, value]) => [
              key,
              value.criteria,
            ]),
          ),
        );
        questions[`${id}_intents`] = choice(
          ask(
            `${baselineNote}目标消息ID ${ids.get(id)}，sender=other。结合当前可见对话，判断这句话最主要的沟通意图或目的。区分情绪与意图。各选项是竞争性解读，不是同时成立的心理成分。日常回答、分享、接话也是有效意图；有具体证据才选择暧昧或隐藏动机，不因关系设置预设每句话都在调情。明确边界不可解释为反向邀请。先看这轮话题由谁发起：若目标消息是在回应 self 发起的话头或问题，它本身就是接球，优先按 answer、inform、continue 等回应类候选解读，不因语气平淡或消息简短就判为close。${REDUP_INTENT_NOTE}不知道选unknown，候选不覆盖选other。`,
          ),
          Object.fromEntries(
            Object.entries(INTENTS).map(([key, value]) => [
              key,
              value.criteria,
            ]),
          ),
        );
      } else {
        // Each Jev question sees shared state plus its own instructions only.
        // Keep later replies outside both; batched self ratings cannot see future messages.
        const ownContext =
          input.targetIds.length > 1
            ? input.messages
                .slice(
                  targetIndex,
                  input.messages.findIndex((m) => m.id === id) + 1,
                )
                .map(compact)
            : [];
        const instructions = (question: string) => ({
          question: ask(question),
          continuation: ownContext,
        });
        questions[`${id}_event`] = choice(
          instructions(
            `消息ID ${ids.get(id)} 本身明确表达哪类值得保留的事件？只基于当前可见的原话，不能把暗示当事实。`,
          ),
          EVENT_KINDS,
        );
        questions[`${id}_mode`] = choice(
          instructions(
            `目标消息ID ${ids.get(id)}，sender=self。这条消息在当时是发起新话头，还是回应延续前文？发起新话头=开启一个对方没有在等的新话题或新问题，此前话题已聊完或自然停住；回应延续=接对方的话、回答对方的问题或跟进双方正在聊的话题。只按该消息发出时可见的上下文判断。`,
          ),
          {
            reply: "回应/延续前文话题",
            initiate: "发起新话头",
          },
        );
        questions[`${id}_score`] = score(
          instructions(
            `目标消息ID ${ids.get(id)}，sender=self。结合 state.messages 与 continuation，按顺序只评价该消息发出时的表达质量，不评价追求成功与否。若是回应延续：重点看是否接住对方的话题或情绪、自然不施压；若是发起新话头：重点看话头是否好接（给对方留了容易接的口）、是否自然不突兀、避免查户口式连环提问。`,
          ),
          quality,
        );
        questions[`${id}_enough`] = choice(
          instructions(
            `结合 state.messages 与 continuation，是否有足够文本证据评价消息ID ${ids.get(id)} 的表达质量？`,
          ),
          enough,
        );
      }
    }
  }
  // 选项去偏：盐值取消息 ID 集——同一请求内排列一致（保住 definitions 去重），
  // 不同会话/增量批次排列不同（位置偏差跨请求抵消，见 server/debias.ts）。
  const salt = input.messages.map((m) => m.id).join("|");
  return {
    state,
    questions: debiasChoiceOrders(questions, salt),
    model: MODEL,
  };
}
export async function analyze(
  input: AnalysisRequest,
  signal?: AbortSignal,
  config?: ActiveConfig | JevJudgeConfig,
): Promise<AnalysisResponse> {
  const start = performance.now();
  // 判官 LLM 配置 → state.messages 预算（模型感知钳制）；jev 原生协议自管窗口不钳。
  const payload = buildRequest(
    input,
    config && "engine" in config
      ? stateMessagesBudget(config.model, config.contextTokens)
      : undefined,
  );
  const result = await evaluate(payload, signal, config);
  const a = result.answers;
  const output: AnalysisResponse = {
    revision: input.revision,
    contextHash: createHash("sha256")
      .update(requestContextKey(input))
      .digest("hex"),
    model: result.model,
    rubricVersion: RUBRIC,
    usage: result.usage,
    latencyMs: Math.round(performance.now() - start),
  };
  const evidence = (v: unknown) => {
    const choice = choiceAnswer.parse(v);
    return choice.confidence >= 0.35 &&
      input.messages[Number(choice.choice)]?.id &&
      /^\d+$/.test(choice.choice)
      ? input.messages[Number(choice.choice)].id
      : null;
  };
  if (input.task === "overview") {
    output.memoryUpdates = (input.memory ?? []).map((event) => {
      const status = choiceAnswer.parse(a[`memory_${event.id}_status`]);
      const proof = choiceAnswer.parse(a[`memory_${event.id}_proof`]);
      const proofId = evidence(a[`memory_${event.id}_proof`]);
      const after =
        input.messages.findIndex((m) => m.id === proofId) >
        input.messages.findIndex((m) => m.id === event.id);
      return {
        id: event.id,
        status:
          status.choice === "resolved" &&
          status.confidence >= 0.7 &&
          proof.confidence >= 0.7 &&
          after
            ? ("resolved" as const)
            : status.choice === "active" && status.confidence >= 0.7
              ? ("active" as const)
              : ("uncertain" as const),
        evidenceId: proofId,
      };
    });
    const dimensions = AFFINITY_DIMENSIONS.map((d) => ({
      key: d.key,
      label: d.label,
      weight: d.weight,
      judgment: judgment(a[`affinity_${d.key}`], a[`affinity_${d.key}_enough`]),
    }));
    const composite = composeAffinity(
      dimensions,
      noulAnswer.parse(a.boundary).noul,
    );
    output.overview = {
      memoryEvidenceIds: (input.memory ?? []).flatMap((e) => [
        e.id,
        ...(e.resolvedBy ? [e.resolvedBy] : []),
      ]),
      contextCount: input.messages.length,
      affinity: composite.affinity,
      affinityDimensions: dimensions,
      affinityRawValue: composite.rawValue,
      boundaryApplied: composite.boundaryApplied,
      stage: input.relation === "couple" ? "unknown" : safeStage(a.stage),
      rapport:
        input.relation === "couple" ? judgment(a.rapport, a.enough) : undefined,
      ...actionResult(a.action, a.boundary, a.pending),
      evidenceId: evidence(a.evidence),
      actionEvidenceId: evidence(a.actionEvidence),
      actionAnchorId: input.messages.at(-1)!.id,
    };
  } else
    output.lines = input.targetIds
      .filter((id) => input.messages.find((m) => m.id === id)?.kind === "text")
      .map((id) => {
        const eventAnswer = choiceAnswer.parse(a[`${id}_event`]);
        const event = {
          kind: (eventAnswer.choice in EVENT_KINDS
            ? eventAnswer.choice
            : "none") as keyof typeof EVENT_KINDS,
          confidence: eventAnswer.confidence,
        };
        if (input.task === "other_messages") {
          const emotions = choiceAnswer.parse(a[`${id}_emotions`]);
          return {
            id,
            event,
            emotions: emotions.probabilities,
            targets: choiceAnswer.parse(a[`${id}_targets`]).probabilities,
            intents: choiceAnswer.parse(a[`${id}_intents`]).probabilities,
            score: {
              value: null,
              confidence: emotions.confidence,
              status: "ambiguous" as const,
              probabilities: {},
            },
          };
        }
        return {
          id,
          event,
          mode:
            choiceAnswer.parse(a[`${id}_mode`]).choice === "initiate"
              ? ("initiate" as const)
              : ("reply" as const),
          score: judgment(a[`${id}_score`], a[`${id}_enough`]),
        };
      });
  return output;
}
