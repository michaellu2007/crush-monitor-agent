import type { LlmConfig } from "./model-config";
export function isBailian(endpoint: string) {
  const host = new URL(endpoint).hostname;
  return (
    [
      "dashscope.aliyuncs.com",
      "dashscope-intl.aliyuncs.com",
      "dashscope-us.aliyuncs.com",
    ].includes(host) || /\.maas\.aliyuncs\.com$/.test(host)
  );
}
// Policies belong to the serving platform, not just the upstream model name.
// Reference: Alibaba Model Studio OpenAI Chat API, 2026-10-04.
/** 思考型判官：开源权重命名的 Qwen3 系列（尺寸后缀带数字，如 Qwen/Qwen3-8B、
 * qwen3:4b、qwen3.5-4b；非 instruct 为混合思考模型）。仅限非百炼端点——百炼的
 * qwen3.x API 家族有自己的思考开关策略（见下方分支），不劫持。
 * 与 llm.ts 的 thinkingInstruction / 无 response_format / 300s 超时下限捆绑生效，
 * 实测依据见开发主计划"档位 C 判官验收协议"。 */
export function isThinkingJudge(config: LlmConfig): boolean {
  if (isBailian(config.endpoint)) return false;
  const m = config.model.toLowerCase();
  if (/(?:^|\/)deepseek-r1/.test(m) || /reasoner/.test(m)) return true;
  // Xiaomi MiMo（mimo-v2.6:9b / MiMo-V2.6-Distill 系）：ollama capabilities 自报
  // thinking，思维链走独立 reasoning 字段——json_mode 约束会把受约束正文挤空，
  // 与 R1 同坑（2026-11-22 实测 ollama /v1 冒烟确认）。
  if (/mimo/.test(m)) return true;
  return (
    !/instruct/.test(m) &&
    /^(?:[a-z0-9_-]+\/)?qwen3(?:\.\d+)?[:.-]\d/.test(m)
  );
}
export function fastInferenceOptions(
  config: LlmConfig,
): Record<string, unknown> {
  // 思考型判官：跳过所有限思参数，让平台默认开思考（关思考的 8B 实测只有
  // 截肢版水平：对比集 11/36、翻转 0/10）。
  if (isThinkingJudge(config)) return {};
  const host = new URL(config.endpoint).hostname,
    m = config.model.toLowerCase();
  if (isBailian(config.endpoint)) {
    if (m === "minimax/minimax-m3") return { thinking: { type: "disabled" } };
    if (/^(?:zhipu\/)?glm-5\.3/.test(m)) return { reasoning_effort: "low" };
    if (m === "qwen3.7-max-2026-05-17") return { thinking_budget: 1024 };
    if (/^qwen3\.8-2\.4t/.test(m)) return { reasoning_effort: "low" };
    if (/thinking|^qwq|^deepseek-r1|\/deepseek-r1/.test(m)) return {};
    if (
      /^qwen3(?:\.[5-8])?-/.test(m) &&
      !/instruct|coder/.test(m) &&
      m !== "qwen3.7-max-preview"
    )
      return { enable_thinking: false };
    if (/^qwen-(plus|flash|turbo)(?:-|$)/.test(m))
      return { enable_thinking: false };
    if (/^(?:(?:siliconflow|vanchin)\/)?deepseek-v(?:3\.[12]|4)/.test(m))
      return { enable_thinking: false };
    if (/^(?:kimi\/)?kimi-k2\.[56](?:-|$)/.test(m) || m === "kimi-k3")
      return { enable_thinking: false };
    if (/^(?:zhipu\/)?glm-(4\.[567]|5(?:[.-]|$))/.test(m))
      return { enable_thinking: false };
    return {};
  }
  if (
    host === "api.deepseek.com" ||
    (host === "open.bigmodel.cn" && /^glm-(4\.[567]|5(?:\.|-|$))/.test(m)) ||
    (["api.moonshot.cn", "api.moonshot.ai"].includes(host) &&
      /^kimi-k2\.[56](?:-|$)/.test(m))
  )
    return { thinking: { type: "disabled" } };
  // 硅基流动:Qwen3.5 系列默认开思考,不显式关闭时调用会挂上百秒(实测默认 110s 无响应,关闭后 515ms)
  if (host === "api.siliconflow.cn") {
    // 推理模型(R1 系/思考变体/QwQ)思考必须保持开启——关了反而变笨
    if (/r1|thinking|^qwq/.test(m)) return {};
    // 模型 ID 带厂商前缀(如 Qwen/Qwen3.5-4B),不锚定开头;instruct 版不思考无需参数
    if (/qwen\d/.test(m) && !/instruct/.test(m)) return { enable_thinking: false };
    return {};
  }
  return {};
}
