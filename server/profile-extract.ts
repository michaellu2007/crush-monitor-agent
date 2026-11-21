// 画像抽取：顾问模型从该联系人的聊天记录低频批量抽兴趣/雷区/风格/事件（手动触发）。
// 云端调用只发生在用户点「更新画像」时（非逐条，性能红线不涉及）；输出经宽容解析层
// 规整后与已有画像合并——已有 boundaries/interests 取并集（用户手工加的不丢），events 全量替换。
// 模型无关性：关思考（fastInferenceOptions）+ 剥 <think> + reasoning_content 兜底 +
// shape 宽容规整（server/json-coerce.ts）+ 解析失败带原文重试一次——任何大模型都能用。
import { activeConfig } from "./model-config";
import { fastInferenceOptions } from "./llm-profile";
import { ProviderError } from "./provider";
import { listConversationIds, readConversation } from "./conv-store";
import {
  normalizeProfile,
  PROFILE_LIMITS,
  type ContactProfile,
} from "../shared/profile";
import { readProfile, saveProfile } from "./profile-store";
import { buildTranscript } from "./transcript";
import { transcriptCharBudgetForConfig } from "./context-budget";
import { decideMbti, type AxisInput } from "./mbti-confidence";
import { hasEmoji, visibleLength } from "../shared/trivial";
import { MEDIA_PLACEHOLDERS } from "../shared/media";
import {
  stripThink,
  extractBalancedObject,
  coerceString,
  coerceStringArray,
  coerceEventArray,
  coerceProbability,
} from "./json-coerce";

export type ExtractionResult = {
  interests: string[];
  boundaries: string[];
  styleNote?: string;
  events: { at?: string; note: string }[];
};

/** 宽容解析：任何能捞出字段的 JSON 形态都接受，shape 不匹配降级为空，不抛错。 */
export function parseExtraction(raw: string): ExtractionResult {
  const obj = extractBalancedObject(stripThink(raw)) as Record<string, unknown>;
  return {
    interests: coerceStringArray(
      obj.interests ?? obj.topics ?? obj.hobbies ?? obj.interest,
      PROFILE_LIMITS.interests + 10,
    ),
    boundaries: coerceStringArray(
      obj.boundaries ?? obj.taboos ?? obj.redLines ?? obj.boundary,
      PROFILE_LIMITS.boundaries + 10,
    ),
    styleNote: coerceString(obj.styleNote ?? obj.style ?? obj.communicationStyle),
    events: coerceEventArray(obj.events ?? obj.timeline, PROFILE_LIMITS.events + 10),
  };
}

function findConversation(contactId: string):
  | { id: string; messages: { sender: string; text: string; timestamp: string | null }[] }
  | null {
  for (const id of listConversationIds()) {
    const conv = readConversation(id) as
      | { schema?: number; contactId?: string; messages?: unknown[] }
      | undefined;
    if (conv?.schema === 1 && conv.contactId === contactId && Array.isArray(conv.messages))
      return {
        id,
        messages: conv.messages as {
          sender: string;
          text: string;
          timestamp: string | null;
        }[],
      };
  }
  return null;
}

const SYSTEM = `你是聊天记录分析员。从对话里抽取该联系人的长期画像，只输出**一个 JSON 对象**，不要 markdown、不要解释、不要思考过程：
{"interests":["看展","咖啡"],"boundaries":["前任","工资"],"styleNote":"偏短句，爱用表情包","events":[{"at":"11月","note":"期末周"}]}
格式硬规则：interests 和 boundaries 必须是**字符串数组**（每条 ≤${PROFILE_LIMITS.interestLen} 字）；styleNote 是字符串；events 每项是 {"at":"时间可空","note":"事件"}。
内容规则：只依据对话原话证据；没有证据的字段留空数组；interests≤10 条、boundaries≤10 条、events≤20 条。`;

const EXTRACT_MAX_MESSAGES = 300;

/** 从 openai 兼容响应里取正文；content 空而 reasoning_content 有货时兜底用后者。 */
function textFromOpenAI(data: any): string {
  const msg = data?.choices?.[0]?.message;
  const content = typeof msg?.content === "string" ? msg.content : "";
  if (content.trim()) return content;
  const reasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
  return reasoning;
}

/**
 * 抽取并合并画像。返回 null 表示找不到该联系人的会话。
 * 合并策略：interests/boundaries = 新旧并集（cap 后截断）；events/styleNote 新值覆盖。
 * 解析失败时带模型原输出重试一次（要求只回纯 JSON）——跨模型稳健性。
 */
export async function extractProfile(contactId: string): Promise<ContactProfile | null> {
  const conv = findConversation(contactId);
  if (!conv) return null;
  const config = activeConfig();
  if (!("engine" in config) || config.engine !== "llm")
    throw new ProviderError(
      400,
      "画像抽取需要 OpenAI 兼容顾问模型，请在模型设置中选择非 Jev 协议的配置。",
    );
  const transcript = buildTranscript(
    conv.messages.slice(-EXTRACT_MAX_MESSAGES),
    transcriptCharBudgetForConfig(config),
  );
  const anthropic = config.protocol === "anthropic";
  const callOnce = async (extraInstruction?: string): Promise<any> => {
    const userContent = extraInstruction
      ? `${transcript}\n\n补充要求：${extraInstruction}`
      : transcript;
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(anthropic
          ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${config.apiKey}` }),
      },
      body: JSON.stringify(
        anthropic
          ? {
              model: config.model,
              max_tokens: 2048,
              system: SYSTEM,
              messages: [{ role: "user", content: userContent }],
            }
          : {
              model: config.model,
              temperature: 0,
              max_tokens: 8192, // 推理模型的思考链也在输出预算里，2048 会被思考吃光
              ...fastInferenceOptions(config),
              messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: userContent },
              ],
            },
      ),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok)
      throw new ProviderError(502, `画像抽取调用失败（HTTP ${response.status}）`);
    const data = await response.json();
    const text = anthropic
      ? (data?.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("")
      : textFromOpenAI(data);
    if (typeof text !== "string" || !text.trim())
      throw new ProviderError(502, "抽取模型没有返回内容。");
    return text;
  };
  const parse = (raw: string): ExtractionResult | null => {
    try {
      return parseExtraction(raw);
    } catch {
      return null;
    }
  };
  let text = await callOnce();
  let parsed = parse(text);
  if (!parsed || (!parsed.interests.length && !parsed.boundaries.length && !parsed.events.length && !parsed.styleNote)) {
    // 修复重试：带原输出要求只回纯 JSON（跨模型最常见的救场手段）
    text = await callOnce(
      `你上一次的输出无法解析。请严格只输出一个 JSON 对象，格式：{"interests":["..."],"boundaries":["..."],"styleNote":"...","events":[{"at":"...","note":"..."}]}。不要输出思考过程、markdown 或任何其他文字。`,
    );
    parsed = parse(text);
  }
  const prev = readProfile(contactId);
  const union = (a: string[], b: string[], cap: number) =>
    [...new Set([...a, ...b])].slice(0, cap);
  const merged = normalizeProfile(
    {
      interests: union(prev?.interests ?? [], parsed?.interests ?? [], PROFILE_LIMITS.interests),
      boundaries: union(prev?.boundaries ?? [], parsed?.boundaries ?? [], PROFILE_LIMITS.boundaries),
      styleNote: parsed?.styleNote ?? prev?.styleNote,
      events: parsed?.events ?? [],
    },
    contactId,
  );
  if (!merged) return null;
  return saveProfile(merged, contactId);
}

// ---------- MBTI 推测（弱参考中的弱参考） ----------
// 口径（情感文献参考 U 节）：分维置信度而非单点断言；只校准语气节奏；
// 不得替代原话证据；与用户自测标签冲突时以自测为准；不进判官 prompt。
// 2026-11-03 修准：①证据单侧化——只喂目标人物自己的消息（此前两侧混排，
// 谁话多谁被当"对方"，用户本人是话痨时推测全是自己）；②Prompt 补四维行为判据、
// 去 INTJ 锚点（示例值会把小模型往 I/T/J 上拉）；③双采样合并（P1-1 口径）；
// ④证据逐条回验（evidence 必须能在原文里找到，匹配不上压置信度）。
// 2026-11-04 修准（实测 联系人A 案例：E 对、S/N 与 J/P 全反、T/F 跨次漂移，文献确认
// S/N 与 J/P 是文本信号最弱的两轴）：①分块集成取代同输入双采样——消息池切 2~4 份
// 连续块并行独立推测，轴级多数投票+置信度按票数份额缩放（治跨次漂移与长上下文稀释）；
// ②证据归属硬规则——问对方近况的问句此前被当 TA 的人格证据（实测 3/4 轴证据全是
// 问句），现只允许作 E/I 证据；③行为词面统计（程序计算）注入作校准锚。
// 2026-11-04 二轮修准（联系人A 实测五轮振荡 ISFP→ISTJ→ESFP→ISTP→ISFJ 后仍偏离真实 ENTJ）：
// ①消息池 2000→6000、集成 4→12 票（稀有信号靠多数票聚合，治票数不足时的漂移）；
// ②J 词族补短促拍板（单条"行/走/来/好"，实测 3 倍差于对照）；F 族去"笑死/无语"（幽默反应≠情绪表达）；
// ③词面统计裁决从 prompt 软约束落到代码（高侧 ≥2× 低侧且 ≥5 条强制 pick，实现见 mbti-confidence 决策分级）；
// ④E 判据补"2-4 字主动发问/召集/推进/拍板也算 E 证据"（治短消息人群被读成 I）；
// ⑤并发 mapLimit 限幅。
// 2026-11-04 三轮修准（联系人A 真值 ENTJ 测出 ISTJ，E/N 两轴错；文献依据=掩码实验证 E/I/S/N
// 需双侧词族+LIWC 社交词传统，实测探针：联系人A E 词 137 条 vs I 词 13 条=10.5 倍）：
// ①E/I 落双侧词族——社交能量词（朋友/兄弟/聚/开黑/出去玩…）vs 独处能量词（社恐/懒得去/
// 一个人/回血…），进入与 T/F、J/P 同权的统计裁决；②S/N 落双侧词族——前瞻假设词扩
// 为什么/意义/本质/思路/格局…，新增当下细节词（昨天/刚才/几点/哪里/多少钱）作 S 侧，
// 但只朝 N 单向裁决（S 侧词被叙事复述与事务聊天污染，永远不强制判 S，只作阻力）；
// ③行为统计四族全量输出（含 0%），供裁决可见性与 prompt 校准锚。
// 2026-11-04 五轮修准（联系人A 落盘 ENTJ 四轴全对但 percent 36/44/41/28 全砍半）：
// 8B 模型爱把转写行整行照抄进 evidence（含"对方（2023年4月9日 15:36）："时间戳前缀），
// verifyEvidence 对 TA 侧原文（只有消息正文）必然匹配失败 → percent 全轴砍半 →
// 前端横幅"4/4 轴置信 ≤55 仅作弱参考"。修法：匹配与展示前统一剥转写行前缀
// （cleanEvidence），模型照抄转写行不再算"证据未核实"。
export type MbtiInference = {
  type: string;
  axes: { dim: string; pick: string; percent: number; evidence?: string; note?: string }[];
};

export type MbtiSide = "other" | "self";

/** 证据最少条数：低于此不出结果（与 baseline.ts 的 20 条口径一致，宁缺勿错）。 */
export const MBTI_MIN_MESSAGES = 20;

/** 消息池上限（**双方**消息条数）：人格证据只取 TA 侧，但需要双侧上下文才能判断 TA 是
 * 主动发起还是回应（单侧转写里 E/I 无从判断——实测病灶）。6000 条切 12 块并行集成
 * （每块 ~500 条，单块转写受 buildTranscript 500 条硬顶约束）——集成票数越多，
 * 跨次漂移越小、稀有信号（N 词、主动开话头）越容易被多数票捕获。 */
export const MBTI_MAX_MESSAGES = 6000;

/** 集成块数上限：12 票多数投票（temp 0.7 独立采样），并发经 mapLimit 限幅防上游限流。 */
export const MBTI_MAX_CHUNKS = 12;

/** 短促拍板：单条 1-2 字干脆接球（"行""走""来""好"）＝J 侧信号——短消息聊天里
 * 最高精度的 J 证据（词面统计实测 1.3% vs 对照 0.4%，3 倍差）。 */
export const MBTI_DECISIVE_RE = /^(行|好|好嘞|走|来|可以|成|定了|ok|就这么定|没事|没问题)[吧呀啊哈了嘛哦！？。~]*$/i;

/** 宽容解析：type 取合法四字母；axes 形态不限（percent 容忍 "78%"/0.78）。 */
export function parseMbti(raw: string): MbtiInference | null {
  const obj = extractBalancedObject(stripThink(raw)) as Record<string, unknown>;
  const type = (coerceString(obj.type) ?? "").toUpperCase().match(/[IE][SN][TF][JP]/)?.[0];
  if (!type) return null;
  const arr = Array.isArray(obj.axes) ? obj.axes : [];
  const axes = arr
    .slice(0, 4)
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        dim: coerceString(o.dim ?? o.dimension) ?? "",
        pick: (coerceString(o.pick ?? o.choice) ?? "").toUpperCase().slice(0, 1),
        percent: Math.round((coerceProbability(o.percent ?? o.confidence) ?? 0.5) * 100),
        evidence: cleanEvidence(coerceString(o.evidence)),
        note: coerceString(o.note),
      };
    })
    .filter((a) => a.dim && a.pick);
  return { type, axes };
}

/**
 * 证据清洗（纯函数）：逐行剥"我/对方（时间）："转写行前缀，多行并作分号串，
 * 截断 120 字（展示口径）。verifyEvidence 用同规则但不含分隔符地拼接（见彼处注释）。
 */
export function cleanEvidence(s: string | undefined): string {
  return String(s ?? "")
    .split(/\n+/)
    .map((l) => l.replace(/^(我|对方)(（[^）]*）)?：/, "").trim())
    .filter(Boolean)
    .join("；")
    .slice(0, 120);
}

/** 维度对齐键：取 "E/I 外向-内向" → "E/I"，跨两次采样按它配对。 */
function mbtiAxisKey(dim: string): string {
  return dim.trim().split(/[\s（(]/)[0].slice(0, 3);
}

function meanPct(list: { percent: number }[]): number {
  return list.reduce((n, a) => n + a.percent, 0) / list.length;
}

/**
 * N 路采样合并：每轴按 pick 分桶计票。
 * - 全票一致 → 置信度取均值，无注记；
 * - 平票（如 1:1、2:2）→ 置信度压 50 注记"采样不一致"（pick 取均值置信高的一侧）；
 * - 严格多数 → 置信度 = 多数派均值 × (0.5 + 份额/2)（2:1 适度打折，3:1 轻打折），并注记票型。
 * type 从合并后的 picks 重新拼装，保证 type 与四轴自洽。
 */
export function mergeMbtiSamples(list: MbtiInference[]): MbtiInference {
  const [first] = list;
  if (!first) throw new Error("mergeMbtiSamples 需要至少一个样本");
  if (list.length === 1) return first;
  const total = list.length;
  const keys: string[] = [];
  for (const s of list)
    for (const a of s.axes) {
      const k = mbtiAxisKey(a.dim);
      if (!keys.includes(k)) keys.push(k);
    }
  const axes: MbtiInference["axes"] = [];
  for (const k of keys) {
    const axesFor = list
      .map((s) => s.axes.find((x) => mbtiAxisKey(x.dim) === k))
      .filter((a): a is MbtiInference["axes"][number] => !!a);
    const buckets = new Map<string, MbtiInference["axes"][number][]>();
    for (const a of axesFor) {
      const arr = buckets.get(a.pick) ?? [];
      arr.push(a);
      buckets.set(a.pick, arr);
    }
    const ranked = [...buckets.values()].sort(
      (x, y) => y.length - x.length || meanPct(y) - meanPct(x),
    );
    const [win, runnerUp] = ranked;
    let percent: number;
    let note: string | undefined;
    if (runnerUp && runnerUp.length === win.length) {
      percent = 50;
      note = `采样不一致 (${win.length}:${runnerUp.length})`;
    } else if (win.length === total) {
      percent = Math.round(meanPct(win));
    } else {
      percent = Math.round(meanPct(win) * (0.5 + win.length / total / 2));
      note = `${total} 份采样 ${win.length}:${total - win.length} 分裂`;
    }
    // 回验注记（证据未核实/过短）不能被投票注记覆盖——拼在一起
    const verifyNote = win[0].note;
    axes.push({
      ...win[0],
      percent,
      note: [verifyNote, note].filter(Boolean).join("；") || undefined,
    });
  }
  const pickOf = (prefix: string) => axes.find((x) => mbtiAxisKey(x.dim) === prefix)?.pick ?? "";
  const derived = `${pickOf("E/I")}${pickOf("S/N")}${pickOf("T/F")}${pickOf("J/P")}`;
  return {
    type: /^[IE][SN][TF][JP]$/.test(derived) ? derived : first.type,
    axes,
  };
}

/** 消息池 → ≤maxChunks 份连续块（保持时序、不重叠）；~150 条/块，样本少则 1 块。 */
export function splitChunks<T>(items: T[], maxChunks: number): T[][] {
  if (items.length <= 1) return [items];
  const n = Math.max(1, Math.min(maxChunks, Math.round(items.length / 150)));
  const size = Math.ceil(items.length / n);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// 行为词面族：只收高精度词（宁缺勿滥）。四轴两侧都有词族 → 可做统计裁决；
// S/N 的 S 侧（当下细节词）被叙事复述与事务聊天污染 → 只朝 N 单向裁决（见 onlyHi）。
const MBTI_WORD_HINTS: { label: string; words: string[] }[] = [
  { label: "既定安排词（J 侧信号）", words: ["计划", "安排", "打算", "准备", "日程", "截止", "定了", "预订", "预约", "报了", "已经订", "直接", "赶紧", "马上", "几点", "没问题", "行吧", "好嘞", "走吧", "来吧", "就这"] },
  { label: "随机随性词（P 侧信号）", words: ["随便", "到时候", "再说", "看情况", "随缘", "无所谓", "没想好"] },
  { label: "前瞻假设词（N 侧信号）", words: ["如果", "要是", "万一", "以后", "未来", "想象", "说不定", "估计", "大概", "感觉像", "像是", "为什么", "为啥", "意义", "本质", "核心", "思路", "长远", "将来", "格局", "可能性"] },
  { label: "情绪感受词（F 侧信号）", words: ["开心", "难过", "烦死", "好累", "心疼", "委屈", "感动", "害怕", "紧张", "期待", "喜欢", "气死", "好想", "希望"] },
  { label: "推断方案词（T 侧信号）", words: ["应该", "所以", "因为", "其实", "不如", "直接", "干脆", "没必要", "问题是", "为什么不", "就行", "就可以", "搞定", "就这样", "完事", "到位", "弄好", "弄完", "先去", "再去", "然后"] },
  { label: "社交能量词（E 侧信号）", words: ["朋友", "兄弟", "姐妹", "同学", "同事", "大家", "一群", "聚餐", "聚会", "饭局", "团建", "开黑", "唱k", "唱歌", "打球", "桌游", "轰趴", "party", "出去玩", "组队", "群里"] },
  { label: "独处能量词（I 侧信号）", words: ["社恐", "不想出门", "懒得去", "懒得动", "一个人", "自己待", "独处", "宅", "回血", "充电", "不想说话", "不想去", "怕生", "躺平"] },
  { label: "当下细节词（S 侧信号）", words: ["昨天", "刚才", "刚刚", "几点", "哪里", "哪儿", "多少钱", "怎么走", "具体"] },
];
const CONCRETE_RE = /[0-9０-９]|今[天晚早日]|明[天晚早日]|昨[天晚早日]|[上下]周|几点|\d+[点日号]/;

/** 轴级词面计数（纯函数）：J 计数 = 安排词 ∪ 短促拍板消息（一条消息只计一次）。 */
export type MbtiAxisCounts = {
  total: number;
  j: number;
  p: number;
  t: number;
  f: number;
  n: number;
  s: number;
  e: number;
  i: number;
  concrete: number;
  questions: number;
};

export function mbtiAxisCounts(msgs: { text: string }[]): MbtiAxisCounts | null {
  const texts = msgs.map((m) => String(m.text ?? "")).filter((t) => t.trim());
  if (texts.length < 10) return null;
  const hit = (ws: string[]) => texts.filter((t) => ws.some((w) => t.includes(w))).length;
  const planJ = MBTI_WORD_HINTS[0].words;
  return {
    total: texts.length,
    j: texts.filter((t) => planJ.some((w) => t.includes(w)) || MBTI_DECISIVE_RE.test(t.trim())).length,
    p: hit(MBTI_WORD_HINTS[1].words),
    n: hit(MBTI_WORD_HINTS[2].words),
    f: hit(MBTI_WORD_HINTS[3].words),
    t: hit(MBTI_WORD_HINTS[4].words),
    e: hit(MBTI_WORD_HINTS[5].words),
    i: hit(MBTI_WORD_HINTS[6].words),
    s: hit(MBTI_WORD_HINTS[7].words),
    concrete: texts.filter((t) => CONCRETE_RE.test(t)).length,
    questions: texts.filter((t) => /[？?]/.test(t)).length,
  };
}

/**
 * 行为词面统计（程序计算，纯函数可单测）：给推测模型一个客观校准锚，
 * 治"从几条问句脑补人格"。只报事实计数，解释权留给模型与用户。
 * 四轴两侧词族**总是输出**（含 0%）：统计裁决规则需要两侧数字可见。
 */
export function mbtiBehaviorNotes(msgs: { text: string }[], extraLines?: string[]): string {
  const c = mbtiAxisCounts(msgs);
  if (!c) return "";
  const pct = (n: number) => `${Math.round((n / c.total) * 100)}%`;
  const emoji = msgs
    .map((m) => String(m.text ?? ""))
    .filter((t) => t.trim() && hasEmoji(t)).length;
  const lens = msgs
    .map((m) => visibleLength(String(m.text ?? "")))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const lines: string[] = [
    `【行为统计（程序按词面与消息序列计算，供校准参考，非人格结论）】样本 ${c.total} 条`,
    `- 含具体数字/时间的消息 ${pct(c.concrete)}、提问 ${pct(c.questions)}、带表情 ${pct(emoji)}、长度中位数 ${lens[Math.floor(lens.length / 2)] ?? 0} 字`,
    `- 既定/拍板词（J 侧）：${pct(c.j)}｜随机随性词（P 侧）：${pct(c.p)}`,
    `- 推断方案词（T 侧）：${pct(c.t)}｜情绪感受词（F 侧）：${pct(c.f)}`,
    `- 社交能量词（E 侧）：${pct(c.e)}｜独处能量词（I 侧）：${pct(c.i)}`,
    `- 前瞻假设词（N 侧）：${pct(c.n)}｜当下细节词（S 侧）：${pct(c.s)}`,
  ];
  for (const l of extraLines ?? []) if (l) lines.push(l);
  return lines.join("\n");
}

/**
 * 词面统计裁决（纯函数，代码层兜底）：四轴若一侧词族命中 ≥2× 另一侧且 ≥5 条
 * （噪声地板），强制 pick 取高侧——此前该规则只写在 prompt 里靠模型自觉，
 * 实测 8B 模型不兑现（commit 07c3a10 的"裁决"实为软约束）。percent 钳 ≤65（词面
 * 只是单一维度证据）。S/N 特例 onlyHi="N"：只朝 N 单向裁决——S 侧词（昨天/几点/
 * 多少钱）被叙事复述与事务聊天污染，命中高不构成 S 的硬证据，只作 N 的阻力。
 */

/** 消息长度中位数（字符数）。 */
function medianLen(msgs: { text: string }[]): number {
  const lens = msgs
    .map((m) => visibleLength(String(m.text ?? "")))
    .sort((a, b) => a - b);
  return lens.length ? lens[Math.floor(lens.length / 2)] : 0;
}

/**
 * 双侧结构信号（程序计算，纯函数可单测）：两侧消息长度中位数对比，供"消息极短"
 * 规则校准。注意：谁开新会话（≥12h 第一条）在追人场景被关系动态污染（追的一方
 * 几乎总是开聊方），与人格无关，不作任何轴的证据——实测 联系人A 案例 13/88 vs 75/88。
 */
export function mbtiStructuralNotes(
  messages: { sender: string; text: string; timestamp: string | null }[],
  side: MbtiSide,
): string[] {
  const target = messages.filter((m) => m.sender === side);
  const user = messages.filter((m) => m.sender !== side);
  if (!target.length || !user.length) return [];
  const lines: string[] = [];
  const medT = medianLen(target);
  const medU = medianLen(user);
  if (medT && medU)
    lines.push(`- 消息长度中位数：TA ${medT} 字 / 用户 ${medU} 字`);
  return lines;
}

function normText(s: string): string {
  return String(s ?? "").replace(/\s+/g, "").toLowerCase();
}

/**
 * 证据回验通过率（0..1，纯函数）：与 verifyEvidence 同规则（拆段、剥转写前缀、
 * ≥4 字段做包含匹配），但返回比例而不是打折——供分级决策使用。
 */
export function evidenceMatchRate(
  evidence: string | undefined,
  messages: { text: string }[],
): number {
  const hay = normText(messages.map((m) => String(m.text ?? "")).join("\n"));
  const parts = String(evidence ?? "")
    .split(/[；;\n]+/)
    .map((p) => normText(p.replace(/^(我|对方)(（[^）]*）)?：/, "")))
    .filter((p) => p.length >= 4);
  if (!parts.length) return 0;
  return parts.filter((p) => hay.includes(p)).length / parts.length;
}

/**
 * 证据回验：evidence 拆段（"；"/";"/换行——cleanEvidence 的展示拼接符）逐段核验，
 * 每段剥"我/对方（时间）："转写行前缀后须能在目标侧消息原文里找到（包含匹配）。
 * ≥4 字的段**多数**命中即算核实（模型常引多条原话，单段转述不应全盘否决）；
 * 全不命中或无有效段 → percent 减半并注记。治"引用张冠李戴"。
 */
export function verifyEvidence(
  mbti: MbtiInference,
  messages: { text: string }[],
): MbtiInference {
  const hay = normText(messages.map((m) => String(m.text ?? "")).join("\n"));
  const axes = mbti.axes.map((a) => {
    const parts = String(a.evidence ?? "")
      .split(/[；;\n]+/)
      .map((p) => normText(p.replace(/^(我|对方)(（[^）]*）)?：/, "")))
      .filter((p) => p.length >= 4);
    if (!parts.length)
      return { ...a, percent: Math.round(a.percent / 2), note: "证据过短未核实" };
    const matched = parts.filter((p) => hay.includes(p)).length;
    if (matched === parts.length) return a;
    if (matched * 2 >= parts.length)
      return { ...a, note: `证据部分核实（${matched}/${parts.length} 段）` };
    return { ...a, percent: Math.round(a.percent / 2), note: "证据未核实" };
  });
  return { ...mbti, axes };
}

/**
 * system prompt 按 side 参数化：测我本人（side=self）时目标人物是「我」侧——固定写成
 * "推测对方"会让模型引用对方行，而证据回验对「我」侧原文，必然全挂。
 * 判据正文里的"TA"由开头定义统一指向目标侧，正文无需复制两份。
 */
export const mbtiSystem = (side: MbtiSide): string => {
  const target =
    side === "self"
      ? "目标是推测**「我」（用户本人）**的 MBTI 四维倾向——下文所有「TA/目标人物」均指「我：」行那一侧"
      : "目标是推测**对方（TA）**的 MBTI 四维倾向——下文所有「TA/目标人物」均指「对方：」行那一侧";
  const evLine = side === "self" ? "「我：」行" : "「对方：」行";
  const ctxLine = side === "self" ? "「对方：」行" : "「我：」行";
  return `你是人格观察员。下面转写含双方消息（每行以 我/对方 开头），${target}，只输出**一个 JSON 对象**，不要 markdown、不要思考过程：
{"type":"____","axes":[{"dim":"E/I 外向-内向","pick":"E 或 I","percent":60,"evidence":"逐字引用 TA 的原话短句"},{"dim":"S/N 实感-直觉","pick":"S 或 N","percent":60,"evidence":"..."},{"dim":"T/F 思考-情感","pick":"T 或 F","percent":60,"evidence":"..."},{"dim":"J/P 判断-感知","pick":"J 或 P","percent":60,"evidence":"..."}]}
证据归属硬规则：evidence 必须逐字引用 ${evLine}里目标人物谈**自己**的生活/感受/决定的原话；${ctxLine}只用于判断目标人物每句话是主动发起还是回应，不得作为证据、不得引用进 evidence；目标人物询问对方近况的问句只能作为 E/I 主动性证据；不得编造、不得引用其他人说的话。
四维行为判据（只看可引用的 TA 原话，不脑补）：
- E/I：只看会话内主动性（结合上下文判断）：主动开新话题、主动分享自己的新动态/见闻、隔了许久主动回来续聊、谈起自己的社交圈/局/队友 = E 的证据；只接话、几乎不主动抛新话题 = I 的证据。**短消息聊天里 2-4 字的主动发问/召集/推进/拍板（"干嘛""出来""吃没""走""行"）是外向能量指向人与事务的表现，算 E 侧证据**；行为统计里"社交能量词"显著高于"独处能量词"是 E 的客观数字。行为统计的"带表情"占比 ≥15% 是 E 侧软证据（积极 emoji 使用与外向相关，文献 Hall & Pennington 2013；只用表情收尾、不带任何内容的回复不算）。I 的判定需要 TA 几乎只被动应答且从不抛新话头，不能因"话少"或"回得短"判 I。注意：谁先开新会话受关系模式影响（追的一方几乎总是开聊方），一律不作 E/I 证据；回复短≠内向。
- S/N：S=聊具体细节、当下事务、字面意思；N=比喻联想、谈未来与假设、爱读潜台词。注意：问别人具体近况≠S；**约见面、定时间、推进安排这类事务性内容在 E_NJ 人群的聊天里同样大量出现，不能因内容具体就判 S**——S/N 只看 TA 谈**自己**的经历与想法时是否只用字面信息、还是带假设/联想/抽象概括。行为统计里"前瞻假设词"占比**不低于**"当下细节词"时，S 的 percent ≤55（除非有明确的联想/假设原话反证）；"当下细节词"会被叙事复述与事务聊天推高，仅供参考、不得单独作 S 证据。
- T/F：T=给结论给方案、讲道理、直接纠正、指令与完成导向（"就行""搞定""先…再""然后"）；F=先接住情绪、在意感受、语气软。行为统计里"推断方案词"命中高于"情绪感受词"时，F 的 percent ≤55（除非有明确的情绪原话反证）。不要凭"情绪词少"反向抬高 F。
- J/P：J=拍板、定时间、给安排、收尾干脆（"行""来""就这么定""几点见"都是 J 侧信号；行为统计的"既定/拍板词"占比已含单条"行/走/来/好"式短促拍板）；P=临时起意、选项开放、话题跳跃。注意：线上回复随意≠P，问别人的安排≠J。
消息极短时（行为统计显示长度中位数 ≤10 字）：消息长短、表情多少、句子完整度一律不作为任何轴的证据，只按消息功能判断（拍板/推进/发问=E+J+T 侧；接住情绪/寒暄铺陈=F 侧；谈想象与假设=N 侧；只回应眼前琐事=S 侧）。
置信度硬规则：percent 是倾向置信度 0-100；≥70 必须有跨场景的多个独立证据；单一场景或单条消息 ≤60；证据不足就 ≤55。四个维度必须齐全；type 按 pick 组成四字母。线上文字只是人格的弱样本：拿不准就压低 percent，不要硬选。
若附有【行为统计】：那是程序按词面与消息序列算出的客观数字，按以下规则裁决——某轴两侧词族命中差 ≥2 倍时，该轴 pick 必须取命中高的一侧（percent ≤65；S/N 轴只在 N 侧命中高时适用，S 侧高不得据此判 S）；两侧打平或都 ≤2% 时按原话证据选但 percent ≤50。统计不得被无视，也不要在 evidence 里引用它。`;
};

/** 占位文本（`[图片]`/`[表情包]`/`[链接] 标题` 等整行媒体标记）——没有人格信息，
 * 既不进转写也不进词面统计（实测某会话 23.7% 是这类消息，稀释统计并白占预算）。 */
const PLACEHOLDER_SET = new Set(Object.values(MEDIA_PLACEHOLDERS));
export function isPlaceholderText(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return true;
  if (PLACEHOLDER_SET.has(t)) return true;
  return /^\[(图片|表情包|语音|视频|文件|链接|卡片消息|撤回消息|不支持的消息)\]/.test(t);
}

/** 诊断快照（供 scripts/mbti-diagnose.ts 打印；只含数字/类型/百分比，不含聊天原文）。 */
export type MbtiDiagnostics = {
  side: MbtiSide;
  window: {
    totalMessages: number;
    startAt: string | null;
    endAt: string | null;
    targetCount: number;
    nonTargetCount: number;
    placeholderCount: number;
    targetTextCount: number;
    medianLen: number;
    shortRate: number;
    longCount: number;
  };
  chunks: {
    index: number;
    messages: number;
    targetMessages: number;
    ok: boolean;
    rawType?: string;
    rawAxes?: { dim: string; pick: string; percent: number }[];
    verifiedAxes?: { dim: string; pick: string; percent: number; note?: string }[];
  }[];
  counts: MbtiAxisCounts | null;
  votes: { axis: string; buckets: { pick: string; n: number }[] }[];
  merged: MbtiInference | null;
  adjudicated: MbtiInference | null;
  final: MbtiInference | null;
  weakNotes: string[];
};

/** 轴级投票分布（诊断用；不算 percent，只看票型）。 */
export function summarizeVotes(
  list: MbtiInference[],
): { axis: string; buckets: { pick: string; n: number }[] }[] {
  const axes: string[] = [];
  for (const s of list)
    for (const a of s.axes) {
      const k = mbtiAxisKey(a.dim);
      if (!axes.includes(k)) axes.push(k);
    }
  return axes.map((k) => {
    const buckets = new Map<string, number>();
    for (const s of list) {
      const a = s.axes.find((x) => mbtiAxisKey(x.dim) === k);
      if (a) buckets.set(a.pick, (buckets.get(a.pick) ?? 0) + 1);
    }
    return {
      axis: k,
      buckets: [...buckets.entries()]
        .map(([pick, n]) => ({ pick, n }))
        .sort((a, b) => b.n - a.n),
    };
  });
}

/**
 * 推测 MBTI（四维置信度），side 指定证据来自谁：other=对方（默认）/ self=用户本人。
 * 证据只取目标人物自己的消息，但转写喂**双侧上下文**——单侧转写里无法判断 TA 是
 * 主动发起还是回应（E/I 无从下手）；行为统计也只算 TA 侧词面。
 * 消息池切 2~4 份连续块并行独立推测（temp 0.7 保样本独立性，样本少则同块双采样），
 * 轴级多数投票合并；每块的证据先按本块 TA 侧原文回验再合并。
 * 与用户自测标签冲突时以自测为准（前端展示口径）。
 */
export async function inferMbtiDetailed(
  contactId: string,
  side: MbtiSide = "other",
  opts: { save?: boolean; maxChunks?: number } = {},
): Promise<{ diagnostics: MbtiDiagnostics; profile: ContactProfile | null } | null> {
  const conv = findConversation(contactId);
  if (!conv) return null;
  const config = activeConfig();
  if (!("engine" in config) || config.engine !== "llm")
    throw new ProviderError(
      400,
      "MBTI 推测需要 OpenAI 兼容顾问模型，请在模型设置中选择非 Jev 协议的配置。",
    );
  // 单侧证据过滤 + 样本门槛：样本不足多半是发送者标记反了（WX_SELF_ID 错/未设）
  const own = conv.messages.filter((m) => m.sender === side);
  if (own.length < MBTI_MIN_MESSAGES)
    throw new ProviderError(
      400,
      `${side === "self" ? "你" : "对方"}的有效消息只有 ${own.length} 条（至少 ${MBTI_MIN_MESSAGES} 条才够推测）。若怀疑发送者标记反了（微信导入时 WX_SELF_ID 配错会整体翻转），请重新导入后再试。`,
    );
  const pool = conv.messages.slice(-MBTI_MAX_MESSAGES); // 双侧上下文：TA 是发起还是回应需要看到"我"的消息
  // 诊断用窗口统计（只算数字，不碰原文）
  const ownText = own.filter((m) => !isPlaceholderText(String(m.text ?? "")));
  const ownLens = ownText
    .map((m) => visibleLength(String(m.text)))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const windowStats: MbtiDiagnostics["window"] = {
    totalMessages: conv.messages.length,
    startAt: conv.messages[0]?.timestamp ?? null,
    endAt: conv.messages[conv.messages.length - 1]?.timestamp ?? null,
    targetCount: own.length,
    nonTargetCount: conv.messages.length - own.length,
    placeholderCount: own.length - ownText.length,
    targetTextCount: ownText.length,
    medianLen: ownLens.length ? ownLens[Math.floor(ownLens.length / 2)] : 0,
    shortRate: ownText.length
      ? Math.round(
          (ownLens.filter((n) => n <= 4).length / ownText.length) * 100,
        ) / 100
      : 0,
    longCount: ownLens.filter((n) => n > 20).length,
  };
  const notes = mbtiBehaviorNotes(own.slice(-MBTI_MAX_MESSAGES), mbtiStructuralNotes(conv.messages, side));
  const budget = transcriptCharBudgetForConfig(config);
  /**
   * 块内聚焦：只保留目标侧的有效文本 + 其前后各 6 条上下文，并剔掉占位消息。
   * 依据（联系人A/联系人B实测）：转写里 self 侧占 46–56% 预算、占位消息占 7–24%，
   * 而判断 TA 是发起还是回应只需要邻近上下文，不需要对方全部发言。
   */
  const focusChunk = (chunk: typeof pool, ctx = 6) => {
    const keep = new Set<number>();
    chunk.forEach((m, i) => {
      if (m.sender !== side || isPlaceholderText(String(m.text ?? ""))) return;
      for (let j = Math.max(0, i - ctx); j <= Math.min(chunk.length - 1, i + ctx); j++)
        keep.add(j);
    });
    return chunk.filter(
      (m, i) => keep.has(i) && !isPlaceholderText(String(m.text ?? "")),
    );
  };
  const userContent = (chunk: typeof pool, extra?: string) =>
    `${notes ? `${notes}\n\n` : ""}${buildTranscript(focusChunk(chunk), budget)}${extra ? `\n\n补充要求：${extra}` : ""}`;
  // 集成分支默认 temperature 0.7：多数投票要求样本相互独立，temp 0 会让所有块共享同一
  // 确定性偏差（self-consistency 口径）；解析修复重试用 0 保证稳定输出。
  const call = async (content: string, temperature = 0.7): Promise<string> => {
    const anthropic = config.protocol === "anthropic";
    // 429/5xx 退避重试：12 块并行集成易触发供应商 TPM 限流（实测 429 整批报废是
    // 集成只成 4/12 的主因）；限流按分钟窗口恢复，线性退避 30s/60s/90s
    for (let attemptNo = 0; ; attemptNo++) {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(anthropic
            ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
            : { Authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify(
          anthropic
            ? {
                model: config.model,
                temperature,
                max_tokens: 4096,
                system: mbtiSystem(side),
                messages: [{ role: "user", content }],
              }
            : {
                model: config.model,
                temperature,
                max_tokens: 8192,
                ...fastInferenceOptions(config),
                messages: [
                  { role: "system", content: mbtiSystem(side) },
                  { role: "user", content },
                ],
              },
        ),
        signal: AbortSignal.timeout(180_000),
      });
      if (response.ok) {
        const data = await response.json();
        const text = anthropic
          ? (data?.content ?? [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("")
          : textFromOpenAI(data);
        if (typeof text !== "string" || !text.trim())
          throw new ProviderError(502, "推测模型没有返回内容。");
        return text;
      }
      // 429/5xx 可重试；其余 4xx（鉴权/参数错）重试无意义直接抛
      if (response.status !== 429 && response.status < 500)
        throw new ProviderError(502, `MBTI 推测调用失败（HTTP ${response.status}）`);
      if (attemptNo >= 2)
        throw new ProviderError(502, `MBTI 推测调用失败（限流/服务错误，已退避重试 3 次，HTTP ${response.status}）`);
      await new Promise((r) => setTimeout(r, 30_000 * (attemptNo + 1)));
    }
  };
  const parse = (raw: string): MbtiInference | null => {
    try {
      return parseMbti(raw);
    } catch {
      return null;
    }
  };
  const REPAIR =
    '你上一次的输出无法解析。请严格只输出一个 JSON 对象，格式：{"type":"____","axes":[{"dim":"E/I","pick":"E 或 I","percent":60,"evidence":"原话"}]}。四条 axes 齐全，不要输出思考过程或任何其他文字。';
  // 一次完整尝试：调用 + 解析失败带指令重试一次
  const attempt = async (chunk: typeof pool): Promise<MbtiInference | null> => {
    const parsed = parse(await call(userContent(chunk)));
    if (parsed) return parsed;
    return parse(await call(userContent(chunk, REPAIR), 0));
  };
  // 分块集成：≥2 块时并行独立推测（块间天然多样），样本少时同块双采样（原 P1-1 口径）。
  // mapLimit 限并发：12 路同时打上游易触发供应商并发限流（429 整批报废）。
  const chunks = splitChunks(pool, opts.maxChunks ?? MBTI_MAX_CHUNKS);
  const runs = chunks.length > 1 ? chunks : [pool, pool];
  const results = await mapLimit(runs, 5, attempt);
  const ok: MbtiInference[] = [];
  const chunkDiag: MbtiDiagnostics["chunks"] = [];
  const verified: (MbtiInference | null)[] = [];
  results.forEach((r, i) => {
    // 证据回验只对 TA 侧原文——chunk 含双侧上下文，防止"引用我方消息"蒙混过关
    const raw = r.status === "fulfilled" ? r.value : null;
    const v = raw
      ? verifyEvidence(raw, runs[i].filter((m) => m.sender === side))
      : null;
    verified.push(v);
    if (v) ok.push(v);
    chunkDiag.push({
      index: i + 1,
      messages: runs[i].length,
      targetMessages: runs[i].filter((m) => m.sender === side).length,
      ok: !!v,
      ...(raw
        ? {
            rawType: raw.type,
            rawAxes: raw.axes.map((a) => ({
              dim: mbtiAxisKey(a.dim),
              pick: a.pick,
              percent: a.percent,
            })),
          }
        : {}),
      ...(v
        ? {
            verifiedAxes: v.axes.map((a) => ({
              dim: mbtiAxisKey(a.dim),
              pick: a.pick,
              percent: a.percent,
              ...(a.note ? { note: a.note } : {}),
            })),
          }
        : {}),
    });
  });
  if (!ok.length) throw new ProviderError(502, "推测失败：模型输出无法解析为 MBTI JSON");
  const mergedSamples = mergeMbtiSamples(ok);
  // ── 第 2/3 步：口径修正 ──
  // 词面统计只算"模型同窗口 + 非占位"的 TA 文本：此前用全量 7101 条，与模型实际
  // 看到的 3231 条脱节；占位消息还会把分母撑大、稀释命中率。
  const taWindow = pool.filter(
    (m) => m.sender === side && !isPlaceholderText(String(m.text ?? "")),
  );
  const counts = mbtiAxisCounts(taWindow);
  const winLens = taWindow
    .map((m) => visibleLength(String(m.text)))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const taAll = pool.filter((m) => m.sender === side);
  const sampleShape = {
    medianLen: winLens.length ? winLens[Math.floor(winLens.length / 2)] : 0,
    longCount: winLens.filter((n) => n > 20).length,
    placeholderRatio: taAll.length
      ? (taAll.length - taWindow.length) / taAll.length
      : 1,
  };
  // ── 第 1 步：证据分级决策（替代旧的三重折价）──
  // 每轴三路证据：块间一致率 / 证据回验率 / 词面统计（仅弱轴兜底）。
  const voteBuckets = summarizeVotes(ok);
  const perSampleEvidence: { axis: string; pick: string; rate: number }[][] = [];
  ok.forEach((s) => {
    perSampleEvidence.push(
      s.axes.map((a) => ({
        axis: mbtiAxisKey(a.dim),
        pick: a.pick,
        rate: evidenceMatchRate(a.evidence, taWindow),
      })),
    );
  });
  const axisInputs: AxisInput[] = voteBuckets.map((v) => {
    const winner = v.buckets[0];
    const votes = v.buckets.reduce((n, b) => n + b.n, 0);
    const pick = winner?.pick ?? "";
    const rates = perSampleEvidence
      .flat()
      .filter((r) => r.axis === v.axis && r.pick === pick)
      .map((r) => r.rate);
    const stat: Record<string, [number, number, string]> = {
      "J/P": [counts?.j ?? 0, counts?.p ?? 0, "J"],
      "T/F": [counts?.t ?? 0, counts?.f ?? 0, "T"],
      "E/I": [counts?.e ?? 0, counts?.i ?? 0, "E"],
      // S/N 只允许朝 N 单向裁决（S 侧词被事务性聊天污染）
      "S/N":
        (counts?.n ?? 0) >= (counts?.s ?? 0)
          ? [counts?.n ?? 0, counts?.s ?? 0, "N"]
          : [0, 0, ""],
    };
    const [hi, lo, hiPick] = stat[v.axis] ?? [0, 0, ""];
    return {
      dim: v.axis,
      pick,
      voteShare: votes ? (winner?.n ?? 0) / votes : 0,
      evidenceRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0,
      hitHi: hi,
      hitLo: lo,
      total: counts?.total ?? 0,
      hiPick,
    };
  });
  const decision = decideMbti(axisInputs, sampleShape);
  // 把决策结果与模型给出的证据文本合并成落盘形状
  const decisionAxes = decision.axes.map((a) => {
    const src = mergedSamples.axes.find((x) => mbtiAxisKey(x.dim) === a.dim);
    return {
      dim: src?.dim ?? a.dim,
      ...(a.pick ? { pick: a.pick } : {}),
      percent: a.percent,
      status: a.status,
      reason: a.reason,
      ...(src?.evidence ? { evidence: src.evidence } : {}),
    };
  });
  const weakNotes = [...decision.notes];
  if (ok.length * 2 < runs.length)
    weakNotes.push(`集成仅 ${ok.length}/${runs.length} 块成功，样本代表性下降`);
  const merged = normalizeProfile(
    {
      ...(readProfile(contactId) ?? {}),
      mbti: {
        ...(decision.type ? { type: decision.type } : {}),
        axes: decisionAxes,
        tier: decision.tier,
        source: side,
        // 真实喂给模型的目标侧文本条数（此前误用 TA 全量，夸大 2 倍以上）
        samples: taWindow.length,
        note: weakNotes.join("；") || undefined,
        inferredAt: new Date().toISOString(),
      },
    },
    contactId,
  );
  if (!merged) return null;
  const diagnostics: MbtiDiagnostics = {
    side,
    window: windowStats,
    chunks: chunkDiag,
    counts,
    votes: voteBuckets,
    merged: mergedSamples,
    adjudicated: decision as unknown as MbtiInference,
    final: decision as unknown as MbtiInference,
    weakNotes,
  };
  if (opts.save === false) return { diagnostics, profile: merged };
  return { diagnostics, profile: saveProfile(merged, contactId) };
}

/** 生产入口：只关心落盘后的画像（诊断走 inferMbtiDetailed）。 */
export async function inferMbti(
  contactId: string,
  side: MbtiSide = "other",
): Promise<ContactProfile | null> {
  const r = await inferMbtiDetailed(contactId, side);
  return r?.profile ?? null;
}

/** 并发限幅 map（保序）：最多 limit 个任务同时飞行，逐个落位，异常记 rejected。 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (e) {
        out[i] = { status: "rejected", reason: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
