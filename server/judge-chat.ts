// 本地判官的 OpenAI 兼容 chat 调用（temperature=0）。判官通道统一入口：
// advise.ts 的候选自审/发前体检与 advisor-tools.ts 的 score_draft 共用。
// seed 逻辑在 llm.ts（带 400 降级），此处从简。
import type { LlmConfig } from "./model-config";
import { ProviderError } from "./provider";
import { stripThink, extractBalancedObject } from "./json-coerce";

export async function judgeChat(
  judge: LlmConfig,
  systemText: string,
  userText: string,
  timeoutMs = 60_000,
): Promise<string> {
  const response = await fetch(judge.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${judge.apiKey}`,
    },
    body: JSON.stringify({
      model: judge.model,
      temperature: 0,
      max_tokens: 8192, // 推理判官的思考链需要输出预算
      messages: [
        { role: "system", content: systemText },
        { role: "user", content: userText },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ProviderError(
      response.status === 401 ? 401 : 502,
      `判官调用失败（HTTP ${response.status}）${(error as any)?.error?.message ? `：${(error as any).error.message}` : ""}`,
    );
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new ProviderError(502, "判官没有返回内容。");
  return text.trim();
}

/** 剥思考块/围栏 + 配平扫描取最外层 JSON 对象（判官输出容错，供各解析器复用）。 */
export function extractJsonObject(raw: string): unknown {
  return extractBalancedObject(raw);
}

export { stripThink };
