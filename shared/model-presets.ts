// Presets are conveniences, not a claim that every account/model has been tested.
export const MODEL_PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "qwen",
    name: "通义千问 · 百炼（北京）",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-flash",
    keyUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7-flash",
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "bigmodel-coding",
    name: "BigModel · GLM Coding",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    model: "glm-5.3-flash",
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "kimi",
    name: "Kimi",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "",
    keyUrl: "https://platform.kimi.com/",
  },
  {
    id: "doubao",
    name: "豆包 · 火山方舟",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "",
    keyUrl: "https://console.volcengine.com/ark/",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "",
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  {
    id: "openrouter-llm",
    name: "OpenRouter · LLM",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "vercel-llm",
    name: "Vercel AI Gateway · LLM",
    protocol: "openai",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    model: "",
    keyUrl: "https://vercel.com/ai-gateway",
  },
  {
    id: "custom",
    name: "其他 OpenAI / Claude 兼容服务",
    protocol: "openai",
    baseUrl: "",
    model: "",
    keyUrl: "",
  },
  {
    id: "typesafe",
    name: "Jev · TypeSafe",
    protocol: "jev",
    baseUrl: "",
    model: "jev-1.13.0",
    keyUrl: "https://console.typesafe.ai/",
  },
  {
    id: "vercel",
    name: "Jev · Vercel AI Gateway",
    protocol: "jev",
    baseUrl: "",
    model: "typesafe-ai/jev",
    keyUrl: "https://vercel.com/ai-gateway",
  },
  {
    id: "openrouter",
    name: "Jev · OpenRouter",
    protocol: "jev",
    baseUrl: "",
    model: "typesafe/jev-1.13",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
] as const;
export type JudgeSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** openai=本地生成式 chat 判官；jev=Jev 原生 systemone 概率读出（StartLux 等），缺省 openai */
  protocol?: "openai" | "jev";
  /** 上下文窗口（tokens）：判官侧转写预算按它换算；不填按模型名启发式并钳到 16k */
  contextTokens?: number;
};
// 配置过的供应商登记簿:baseUrl → 记住的预设/协议/模型列表/Key(供顾问与评估下拉随时切换,Key 永不回传)
export type ProviderEntry = {
  preset: string;
  protocol: "openai" | "anthropic" | "jev";
  models?: string[];
  apiKey?: string;
  model?: string; // 旧版单模型字段
  /** 通道开关（2026-11-20）：false=暂时停用，从所有下拉隐藏；Key 与模型列表保留，随时可再启用 */
  enabled?: boolean;
  /** 手动停用的模型 ID：不从列表删除（调参/试用常用），只在下拉隐藏 */
  disabledModels?: string[];
};
export type ModelSettings = {
  preset: string;
  protocol: "openai" | "anthropic" | "jev";
  baseUrl: string;
  model: string;
  apiKey: string;
  jsonMode: boolean;
  /** 上下文窗口（tokens）：转写字符预算按它换算；不填按模型名启发式推断 */
  contextTokens?: number;
  judge?: JudgeSettings;
  providers?: Record<string, ProviderEntry>;
};
export type PublicProvider = {
  baseUrl: string;
  preset: string;
  protocol: "openai" | "anthropic" | "jev";
  models: string[];
  /** 登记簿里存了 Key 才为 true（Key 本体永不回传）——消息框下拉据此隐藏没配 Key 的供应商 */
  hasKey: boolean;
  /** 通道开关：false=暂时停用（下拉隐藏，当前正在用的不受影响） */
  enabled?: boolean;
  /** 手动停用的模型 ID */
  disabledModels?: string[];
};
export type PublicSettings = Omit<
  ModelSettings,
  "apiKey" | "judge" | "providers"
> & {
  configured: boolean;
  hasKey: boolean;
  fingerprint: string;
  source: "web" | "environment" | "none";
  token: string;
  judge?: Omit<JudgeSettings, "apiKey">;
  providers?: PublicProvider[];
};
