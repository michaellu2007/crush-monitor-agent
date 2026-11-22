import type { MemoryEvent, MemoryUpdate } from "./memory";
import type { AffinityDimension } from "./affinity";
import type { MediaInfo } from "./media";
export type Relation = "crush" | "new" | "couple";
export type Message = {
  id: string;
  sender: "self" | "other";
  text: string;
  timestamp: string | null;
  kind: "text" | "unreadable";
  /** 媒体详情（图片地址/链接等）：只在本机展示；AI 上下文只发 text 占位符 */
  media?: MediaInfo;
};
export type Parsed = {
  speaker: string;
  text: string;
  timestamp: string | null;
};
export type Judgment = {
  value: number | null;
  confidence: number;
  status: "clear" | "ambiguous" | "insufficient";
  probabilities: Record<string, number>;
};
export type LineResult = {
  event?: { kind: MemoryEvent["kind"]; confidence: number };
  skipped?: string;
  id: string;
  score: Judgment;
  /** self 消息：话题发起分类（initiate=发起新话头，reply=回应/延续前文） */
  mode?: "initiate" | "reply";
  emotions?: Record<string, number>;
  targets?: Record<string, number>;
  intents?: Record<string, number>;
};
export type Overview = {
  memoryEvidenceIds?: string[];
  contextCount?: number;
  affinity: Judgment;
  affinityDimensions?: AffinityDimension[];
  affinityRawValue?: number;
  boundaryApplied?: boolean;
  stage: string;
  rapport?: Judgment;
  action: string;
  alternative?: string;
  evidenceId: string | null;
  actionEvidenceId: string | null;
  actionAnchorId?: string;
};
export type Task = "overview" | "other_messages" | "self_message";
/** 机器从聊天记录统计的对方行为基线（shared/baseline.ts 计算，客观事实层）。 */
export type ContactBaseline = {
  /** 统计窗口标签："近90天" | "全部历史" */
  window: string;
  /** 纳入统计的对方文本消息数 */
  sample: number;
  /** 短回复（剥掉表情标点后 ≤4 字）占对方全部文本消息的比例（0-1） */
  shortReplyRate: number;
  /** 对方消息长度中位数（字符） */
  medianLen: number;
  /** 对方回复间隔中位数（分钟；时间戳不足时为 null） */
  medianGapMin: number | null;
  /** 含 emoji/表情字符的消息占比（0-1） */
  emojiRate: number;
  /** 由对方主动开启会话的占比（≥12h 间隔开新会话；会话数不足时为 null） */
  initiationRate: number | null;
};
/** 用户自述的对方背景（结构化场外信息，弱证据：只校准解读，不替代原话）。 */
export type UserProfile = {
  /** 四字母 MBTI 自测标签，仅作语气风格弱参考 */
  mbti?: string;
  /** 沟通风格（依恋类型）：安全/焦虑/回避——回应节奏解读的校准依据 */
  style?: "secure" | "anxious" | "avoidant";
  /** 近况补充（现实背景，≤500 字） */
  recent?: string;
  /** 实测基线：前端从全量 messages 现算（valenceSummary 同模式），随请求注入，不落盘 */
  baseline?: ContactBaseline;
};
export type AnalysisRequest = {
  memory?: Pick<MemoryEvent, "id" | "kind" | "status" | "resolvedBy">[];
  contextNotes?: string;
  userProfile?: UserProfile;
  relationLabel?: string;
  revision: number;
  relation: Relation;
  messages: Message[];
  task: Task;
  targetIds: string[];
};
export type AnalysisResponse = {
  memoryUpdates?: MemoryUpdate[];
  revision: number;
  contextHash: string;
  model: string;
  rubricVersion: string;
  overview?: Overview;
  lines?: LineResult[];
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
};
export const MODEL = "jev-1.13.0";
export const RUBRIC = "crush-2026-10-28.0";
export const RELATIONS: Record<Relation, string> = {
  crush: "Crush / 暧昧中",
  new: "刚认识",
  couple: "恋爱中",
};
export const STAGES: Record<string, string> = {
  unknown: "信息不足",
  contact: "刚搭上线",
  flow: "聊得起来",
  flirt: "出现暧昧",
  date: "有具体约会安排",
  mutual: "明确互表心意",
};
export const ACTIONS: Record<string, { label: string; detail: string }> = {
  continue: { label: "顺着聊", detail: "接住刚才的话题，别急着切换频道。" },
  ask: {
    label: "轻轻追问",
    detail: "问一个具体、容易回答的小问题，把球轻轻递过去。",
  },
  empathize: {
    label: "先接情绪",
    detail: "先回应对方的感受，再考虑讲道理或给建议。",
  },
  flirt: {
    label: "轻轻调情",
    detail: "顺着已经被接住的玩笑，留一点刚刚好的暧昧。",
  },
  invite: {
    label: "试着约一下",
    detail: "把共同兴趣变成一个具体、没有压力的小邀约。",
  },
  clarify: {
    label: "直接问清",
    detail: "这句话有不止一种理解，温和确认比反复猜更有效。",
  },
  wait: {
    label: "等对方接球",
    detail: "球已经递出去了。先留一点空间，不用急着补发。",
  },
  close: {
    label: "今天先收尾",
    detail: "让聊天停在舒服的位置，下次还有话可说。",
  },
  respect: {
    label: "尊重边界",
    detail: "对方表达了拒绝或需要空间。尊重这个意思，停止推进。",
  },
  insufficient: {
    label: "再多一点上下文",
    detail: "这几句话还看不准，补上前后文再一起看看。",
  },
};
export function statusLabel(j?: Judgment) {
  return !j || j.status === "insufficient"
    ? "信息不足"
    : j.status === "clear"
      ? "判断较明确"
      : "有歧义";
}
export function meanQuality(
  messages: Message[],
  lines: Record<string, LineResult>,
) {
  const v = messages
    .filter((m) => m.sender === "self")
    .map((m) => lines[m.id]?.score.value)
    .filter((x): x is number => typeof x === "number");
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
export function contextKey(messages: Message[], relation: Relation) {
  return JSON.stringify({
    model: MODEL,
    rubric: RUBRIC,
    relation,
    messages: messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      text: m.text,
      timestamp: m.timestamp,
      kind: m.kind,
    })),
  });
}

export function requestContextKey(input: AnalysisRequest) {
  return (
    contextKey(input.messages, input.relation) +
    JSON.stringify(
      (input.memory ?? []).map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        resolvedBy: e.resolvedBy,
      })),
    )
  );
}

/** 顾问对话冻结摘要（D1 摘要冻结协议，见 docs/agent对话上下文管理调研.md §6.2）：
 * 服务端压缩事件产出，前端缓存后随下轮请求带回；throughHash 是覆盖段（前 throughCount 轮）
 * 的确定性指纹，服务端校验通过才复用，两次压缩事件之间消息数组 append-only。 */
export type DialogSummary = {
  /** 摘要覆盖的对话轮数（dialog 数组的前缀长度） */
  throughCount: number;
  /** 覆盖段逐字指纹（sha256 前 32 位） */
  throughHash: string;
  /** ≤200 字背景摘要正文 */
  text: string;
};

/** 用户自配知识库条目（2026-11-18）：顾问 search_knowledge 工具的数据源。
 * 全局作用域（用户自己的资料，无联系人隐私约束）；服务端钳制条数/长度。 */
export type KnowledgeEntry = {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
};
