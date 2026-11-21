// 上下文预算：按选取的模型决定喂多少聊天转写。
// - model.json 里显式配了 contextTokens → 优先用它（对付未知/新模型）
// - 否则按模型名启发式推断上下文窗口（宁小勿大——截断只是丢最旧的上下文，超限是直接报错）
// tokens → 字符：中文按 ~1.2 字/token 保守换算，并预留 8k tokens 给系统提示与输出。
import type { LlmConfig } from "./model-config";

const RESERVE_TOKENS = 8_000;
const CHARS_PER_TOKEN = 1.2;
const MIN_CHARS = 20_000;
const MAX_CHARS = 1_500_000;

/** 按模型名推断上下文窗口（tokens）。保守取值：拿不准一律 32k。 */
export function contextTokensForModel(model: string): number {
  const m = String(model ?? "").toLowerCase();
  // 显式标注窗口的变体优先（如 "kimi-32k"、"qwen-long-10m"）
  const explicit = m.match(/(\d+)\s*(k|m)\b/);
  if (explicit) {
    const n = Number(explicit[1]) * (explicit[2] === "m" ? 1_000_000 : 1_000);
    if (n >= 4_000 && n <= 10_000_000) return n;
  }
  if (m.includes("gemini")) return 900_000;
  if (m.includes("8b")) return 128_000; // 8B 档小模型一律 128k（用户口径；含 deepseek 蒸馏 8B）
  if (m.includes("qwen-long") || m.includes("1m")) return 800_000;
  if (m.includes("kimi") || m.includes("moonshot")) return 200_000;
  if (m.includes("claude")) return 180_000;
  if (m.includes("deepseek")) return 1_000_000; // deepseek-api 官方 1M 窗口（用户口径，2026-11）
  if (m.includes("glm") || m.includes("chatglm")) return 120_000;
  if (m.includes("gpt")) return 120_000;
  if (m.includes("qwen")) return 128_000; // qwen3-8b 等现役 8B 档（用户确认 128k）
  if (m.includes("hunyuan")) return 100_000;
  if (m.includes("ernie") || m.includes("文心")) return 100_000;
  if (m.includes("minimax") || m.includes("abab")) return 200_000;
  return 32_000; // 未知/本地小模型：保守
}

/** 给定模型 → 转写字符预算（buildTranscript 的 charBudget）。 */
export function transcriptCharBudget(
  model: string,
  contextTokensOverride?: number,
): number {
  const tokens =
    (contextTokensOverride && contextTokensOverride > RESERVE_TOKENS
      ? contextTokensOverride
      : contextTokensForModel(model)) - RESERVE_TOKENS;
  const chars = Math.round(tokens * CHARS_PER_TOKEN);
  return Math.min(MAX_CHARS, Math.max(MIN_CHARS, chars));
}

/** 从 LlmConfig 取预算（contextTokens 显式优先）。 */
export function transcriptCharBudgetForConfig(config: LlmConfig): number {
  return transcriptCharBudget(config.model, config.contextTokens);
}

/**
 * 判官侧转写字符预算（checkDraft 等直接给判官喂长转写的场景）。
 * 与顾问侧的区别：①无 20k 字符下限——16k 的本地判官喂 2 万字符就是直接溢出；
 * ②无显式 contextTokens 时钳到 16k（本地 8B/9B 判官的常见 num_ctx，宁小勿大）；
 * ③预留 10k tokens（8k 输出 + 2k 系统提示与题目），其余换算成字符给转写。
 */
export function judgeTranscriptChars(
  model: string,
  contextTokensOverride?: number,
): number {
  const tokens =
    contextTokensOverride && contextTokensOverride > RESERVE_TOKENS
      ? contextTokensOverride
      : Math.min(contextTokensForModel(model), 16_384);
  return Math.max(2_000, Math.round((tokens - 10_000) * CHARS_PER_TOKEN));
}

/**
 * 判官 analyze 主链路 state.messages 的字符预算（keep-recent 压缩器阈值）。
 * 纯 API 口径：窗口按模型名启发式 / 显式 contextTokens（不钳 16k——那是本地
 * 判官时代的宁小勿大，云判官 128k+ 会被误伤）。未知模型保守 32k → 预算 28.8k 字
 * > 请求级总闸 12000 字 → 对云判官实际 no-op；钳制只对小窗口 API 模型
 * （如 moonshot-v1-8k → 触 2000 下限）或显式配小 contextTokens 生效。
 * 若回归本地 Ollama 判官，请在设置里显式填 contextTokens=16384（Modelfile 口径）。
 * 见 docs/agent上下文设计.md §3.1。
 */
export function stateMessagesBudget(
  model: string,
  contextTokensOverride?: number,
): number {
  const tokens =
    contextTokensOverride && contextTokensOverride > RESERVE_TOKENS
      ? contextTokensOverride
      : contextTokensForModel(model);
  return Math.max(2_000, Math.round((tokens - RESERVE_TOKENS) * CHARS_PER_TOKEN));
}

/**
 * keep-recent 压缩器（OpenHands RecentEventsCondenser 同款形态，纯确定性、
 * 零模型调用）：从尾部往前保留 ≤budgetChars 的最近消息，keepIds 里的消息
 * （被判目标）无条件保留，永远保留最后一条作锚点。字符按码点数（与 zod 口径一致）。
 * 返回保留消息（保持原顺序）与被丢弃数。
 */
export function condenseMessages<T extends { id: string; text: string }>(
  messages: T[],
  budgetChars: number,
  keepIds?: ReadonlySet<string>,
): { messages: T[]; omitted: number } {
  if (!messages.length) return { messages, omitted: 0 };
  const kept = new Set<T>();
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const len = Array.from(m.text).length;
    if (i === messages.length - 1 || keepIds?.has(m.id) || total + len <= budgetChars) {
      kept.add(m);
      total += len;
    }
  }
  if (kept.size === messages.length) return { messages, omitted: 0 };
  return {
    messages: messages.filter((m) => kept.has(m)),
    omitted: messages.length - kept.size,
  };
}
