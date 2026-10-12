import { z } from "zod";
import { activeConfig } from "./model-config";
import { ProviderError, providerErrorMessage } from "./provider";
import { RELATIONS } from "../shared/types";

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
      }),
    )
    .max(16)
    .optional(),
});

const system = `你是聊天顾问。用户会给你一段与对方的聊天记录摘选和一个问题。基于摘选内容给出具体、可执行的下一步建议；语气自然，不要空洞鼓励；引用摘选原话时保持简短。直接回答，不输出 JSON。`;

export async function advise(body: unknown): Promise<string> {
  const input = schema.parse(body);
  const config = activeConfig();
  if (!("engine" in config) || config.engine !== "llm")
    throw new ProviderError(
      400,
      "顾问对话需要 OpenAI 兼容模型，请在模型设置中选择非 Jev 协议的配置。",
    );
  const transcript = input.messages
    .map((m) => {
      const who = m.sender === "self" ? input.self : input.other;
      return `${who}${m.timestamp ? `（${m.timestamp}）` : ""}：${m.text}`;
    })
    .join("\n");
  const prompt = `关系状态：${RELATIONS[input.relation]}
聊天记录摘选（发送者：内容）：
${transcript}

用户的问题：${input.question}`;
  const anthropic = config.protocol === "anthropic";
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
            max_tokens: 4096,
            system,
            messages: [
              ...(input.dialog ?? []).map((d) => d),
              { role: "user", content: prompt },
            ],
          }
        : {
            model: config.model,
            messages: [
              { role: "system", content: system },
              ...(input.dialog ?? []),
              { role: "user", content: prompt },
            ],
          },
    ),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ProviderError(
      response.status === 401 ? 401 : 502,
      `顾问调用失败（HTTP ${response.status}）${(error as any)?.error?.message ? `：${(error as any).error.message}` : ""}`,
    );
  }
  const data = await response.json();
  const text = anthropic
    ? (data?.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
    : data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new ProviderError(502, "模型没有返回内容，请重试。");
  return text.trim();
}

export function adviseErrorMessage(error: unknown) {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof z.ZodError) return "顾问请求格式不正确。";
  return providerErrorMessage(error);
}
