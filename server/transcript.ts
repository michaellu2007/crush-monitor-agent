// 聊天转写生成器（服务端各模型调用的输入预算器）：
// 从最新往前累计字符，超出预算即停——保证喂给任何模型的上下文都在安全范围
// （8B 档 128k、免费云档 32k 都不会因为长会话爆掉），同时永远优先保留最近的对话。
export type TranscriptMessage = { sender: string; text: string; timestamp?: string | null };

const DEFAULT_CHAR_BUDGET = 60_000;
const HARD_MESSAGE_CAP = 500;

/**
 * 从消息数组生成"我：/对方："转写文本。
 * charBudget：转写总字符预算（含标点与换行），默认 6 万字符——对 128k 上下文模型
 * 留足输出与系统提示余量，对 32k 模型也基本安全。
 */
export function buildTranscript(
  messages: TranscriptMessage[],
  charBudget = DEFAULT_CHAR_BUDGET,
  names?: { self?: string; other?: string },
): string {
  const who = (sender: string) =>
    sender === "self" ? names?.self || "我" : names?.other || "对方";
  const slice = messages.slice(-HARD_MESSAGE_CAP);
  const lines: string[] = [];
  let used = 0;
  let skipped = 0;
  for (let i = slice.length - 1; i >= 0; i--) {
    const m = slice[i];
    const line = `${who(m.sender)}${m.timestamp ? `（${m.timestamp}）` : ""}：${String(m.text ?? "")}`;
    const cost = line.length + 1;
    if (used + cost > charBudget) {
      skipped = i + 1;
      break;
    }
    lines.unshift(line);
    used += cost;
  }
  const head =
    skipped > 0 ? `（更早的 ${skipped} 条已省略，以下仅保留最近的对话）\n` : "";
  return head + lines.join("\n");
}
