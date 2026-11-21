import { upstreamError } from "./upstream-error";
import { ProviderError } from "./provider";
// Normalize SSE to the same envelope as non-streaming Chat Completions.
// reasoning_content（思考型模型的思维链）保留在 envelope 里供开发者模式落盘；
// 只有 content 会成为判分结果，思考过程永不进入答案。
export async function readLlmResponse(response: Response, name = "模型服务") {
  // 非流式收口（2026-11-20 冗余收缩）：与非流式 SSE 解析共用同一实现——
  // 旧副本 80% 重复（同一循环两份），委托流式版（空回调）行为完全一致。
  return streamLlmResponse(response, {}, name);
}

/** 顾问流式变体（2026-11-18）：边读边回调增量（reasoning=思维链、content=正文），
 * 支持 tool_calls 分片累积；返回与非流式同构的 envelope——调用方（advisorText/
 * 工具循环）无需感知差异。onContent 收到的就是正文增量；工具调用轮正文通常为空。 */
export async function streamLlmResponse(
  response: Response,
  on: { onReasoning?: (chunk: string) => void; onContent?: (chunk: string) => void } = {},
  name = "模型服务",
) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = await response.json();
    if (data.error) throw upstreamError(502, name, data);
    return data;
  }
  if (!response.body)
    throw new ProviderError(502, "模型没有返回内容，请重试。");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    content = "",
    reasoning = "",
    finish: string | null = null,
    usage: unknown = {},
    ended = false,
    bytes = 0;
  const toolCalls: Record<
    number,
    { id: string; function: { name: string; arguments: string } }
  > = {};
  function event(block: string) {
    const text = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!text) return;
    if (text.trim() === "[DONE]") {
      ended = true;
      return;
    }
    const data = JSON.parse(text);
    if (data.error) throw upstreamError(502, name, data);
    if (data.usage) usage = data.usage;
    const c = data.choices?.find(
      (c: { index?: number }) => c.index === 0 || c.index === undefined,
    );
    if (typeof c?.delta?.content === "string") {
      content += c.delta.content;
      on.onContent?.(c.delta.content);
    }
    if (typeof c?.delta?.reasoning_content === "string") {
      reasoning += c.delta.reasoning_content;
      on.onReasoning?.(c.delta.reasoning_content);
    }
    for (const tc of c?.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const acc = (toolCalls[idx] ??= { id: "", function: { name: "", arguments: "" } });
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.function.name += tc.function.name;
      if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
    }
    if (c?.finish_reason) finish = c.finish_reason;
  }
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024)
        throw new ProviderError(502, "模型输出过长，请换用快速文本模型。");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        event(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    if (!finish)
      throw new ProviderError(502, "模型连接中断，未收到完整结果，请重试。");
    const calls = Object.entries(toolCalls)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => v);
    return {
      choices: [
        {
          message: {
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(calls.length
              ? {
                  tool_calls: calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.function.name, arguments: c.function.arguments },
                  })),
                }
              : {}),
          },
          finish_reason: finish,
        },
      ],
      usage,
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
