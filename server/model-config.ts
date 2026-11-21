import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { MODEL_PRESETS, type ModelSettings } from "../shared/model-presets";
import {
  getProviderConfig,
  ConfigurationError,
  type ProviderConfig,
} from "./provider-config";
export type LlmConfig = {
  engine: "llm";
  provider: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  protocol: "openai" | "anthropic";
  jsonMode: boolean;
  timeoutMs?: number;
  /** 单批题目数上限：慢速本地模型调小以缩短单次生成，避免超时 */
  maxQuestionsPerBatch?: number;
  /** 上下文窗口（tokens）：转写字符预算按它换算；不填按模型名启发式推断 */
  contextTokens?: number;
};
export type ActiveConfig = ProviderConfig | LlmConfig;
export const modelConfigPath = resolve(
  process.env.CRUSH_CONFIG_PATH || ".runtime/model.json",
);
const schema = z
  .object({
    preset: z.string().max(80),
    protocol: z.enum(["openai", "anthropic", "jev"]),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
    apiKey: z.string().trim().max(4096),
    jsonMode: z.boolean().default(true),
    contextTokens: z.number().int().positive().max(10_000_000).optional(),
    judge: z
      .object({
        enabled: z.boolean(),
        baseUrl: z.string().trim().max(500),
        model: z.string().trim().max(200),
        apiKey: z.string().trim().max(4096),
        protocol: z.enum(["openai", "jev"]).default("openai"),
        contextTokens: z.number().int().positive().max(10_000_000).optional(),
      })
      .strict()
      .optional(),
    // 配置过的供应商登记簿:baseUrl → 预设/协议/模型列表/Key。页头与顾问面板下拉的选项来源。
    providers: z
      .record(
        z.string().max(500),
        z.object({
          preset: z.string().max(80),
          protocol: z.enum(["openai", "anthropic", "jev"]),
          // 上限 200 与 mergeProviderModels/saveSettings 对齐：登记的是供应商
          // /models 全量列表（硅基流动 99 个，50 会截断丢弃字母序后半）
          models: z.array(z.string().trim().max(200)).max(200).optional(),
          model: z.string().trim().max(200).optional(), // 旧版单模型字段,读取时并入 models
          apiKey: z.string().trim().max(4096).optional(),
          enabled: z.boolean().optional(),
          disabledModels: z.array(z.string().trim().max(200)).max(200).optional(),
        }),
      )
      .optional(),
  })
  .strict();
export function parseSettings(input: unknown): ModelSettings {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ConfigurationError("配置格式不正确，请检查后重试。");
  const s = result.data;
  const preset = MODEL_PRESETS.find((p) => p.id === s.preset);
  if (!preset || (s.preset !== "custom" && s.protocol !== preset.protocol))
    throw new ConfigurationError("服务商与接口类型不匹配。");
  // 旧版登记簿只有单个 model 字段:读取时并入 models 列表
  if (s.providers) {
    const normalized: NonNullable<
      z.infer<typeof schema>["providers"]
    > = {};
    for (const [baseUrl, entry] of Object.entries(s.providers)) {
      normalized[baseUrl] = {
        preset: entry.preset,
        protocol: entry.protocol,
        models: entry.models?.length
          ? entry.models
          : entry.model
            ? [entry.model]
            : [],
        apiKey: entry.apiKey,
        // undefined 不落键：deep-equal 断言与旧配置文件不受新字段污染
        ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
        ...(entry.disabledModels === undefined
          ? {}
          : { disabledModels: entry.disabledModels }),
      };
    }
    s.providers = normalized;
  }
  if (
    !s.apiKey ||
    /[\s\x00-\x1f\x7f"'`=]/.test(s.apiKey) ||
    /^(your[_-].*|replace[_-].*|xxx+|<.*>)$/i.test(s.apiKey)
  )
    throw new ConfigurationError(
      "请粘贴 API Key 本身，不要带 Bearer、变量名或引号。",
    );
  if (s.protocol === "jev") {
    const config = getProviderConfig({
      JEV_PROVIDER: s.preset,
      JEV_API_KEY: s.apiKey,
    });
    return { ...s, baseUrl: "", model: config.model };
  }
  if (!s.model || /[\s\x00-\x1f]/.test(s.model))
    throw new ConfigurationError("请填写平台提供的模型 ID，不是模型昵称。");
  let u: URL;
  try {
    u = new URL(s.baseUrl);
  } catch {
    throw new ConfigurationError("API 地址不正确，请填写完整的 Base URL。");
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ))
  )
    throw new ConfigurationError(
      "API 地址须使用 HTTPS；本机服务可使用 HTTP。请勿在地址中携带 Key。",
    );
  s.baseUrl = u.href
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|messages)$/, "");
  if (s.judge?.enabled) {
    if (!s.judge.model) throw new ConfigurationError("评估模型 ID 不能为空。");
    try {
      s.judge.baseUrl = new URL(s.judge.baseUrl).href
        .replace(/\/+$/, "")
        .replace(/\/(chat\/completions|messages)$/, "");
    } catch {
      throw new ConfigurationError("评估模型地址不正确，请填写完整 Base URL。");
    }
  }
  if (s.preset !== "custom" && s.baseUrl !== preset.baseUrl)
    throw new ConfigurationError(
      "此平台的地址固定；其他区域或代理地址请选择“其他兼容服务”。",
    );
  return s;
}
export function settingsConfig(s: ModelSettings): ActiveConfig {
  s = parseSettings(s);
  if (s.protocol === "jev")
    return getProviderConfig({ JEV_PROVIDER: s.preset, JEV_API_KEY: s.apiKey });
  return {
    engine: "llm",
    provider: s.preset,
    name: MODEL_PRESETS.find((p) => p.id === s.preset)!.name,
    endpoint:
      s.baseUrl +
      (s.protocol === "anthropic" ? "/messages" : "/chat/completions"),
    model: s.model,
    apiKey: s.apiKey,
    protocol: s.protocol,
    jsonMode: s.jsonMode,
    contextTokens: s.contextTokens,
  };
}
export function readSettings(file = modelConfigPath): ModelSettings | null {
  if (!existsSync(file)) return null;
  try {
    return parseSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new ConfigurationError(
      "本机模型配置无法读取，请在网页中重新填写并保存。",
    );
  }
}
export function activeConfig(): ActiveConfig {
  const saved = readSettings();
  return saved ? settingsConfig(saved) : getProviderConfig();
}
// 评估（judge）路由：启用本地模型时 /api/analyze 走它，否则回落主模型。
// protocol=jev → Jev 原生 systemone 概率读出（StartLux 等决策读出服务），
// evaluate() 按"无 engine 字段"分流到原生协议路径，endpoint 即服务根地址。
export type JevJudgeConfig = {
  provider: "startlux";
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  protocol: "jev";
};
export type JudgeConfig = LlmConfig | JevJudgeConfig;

/** judge 节点 → 运行时配置（纯函数可测）。 */
export function buildJudgeConfig(
  j: NonNullable<ModelSettings["judge"]>,
): JudgeConfig | null {
  if (!j.enabled || !j.baseUrl || !j.model) return null;
  try {
    const base = new URL(j.baseUrl).href
      .replace(/\/+$/, "")
      .replace(/\/(chat\/completions|messages)$/, "");
    if (j.protocol === "jev")
      return {
        provider: "startlux",
        name: "StartLux 原生判官",
        endpoint: base,
        model: j.model,
        apiKey: j.apiKey || "local",
        protocol: "jev",
      };
    return {
      engine: "llm",
      provider: "judge",
      name: "本地评估模型",
      endpoint: base + "/chat/completions",
      model: j.model,
      apiKey: j.apiKey || "local",
      protocol: "openai",
      jsonMode: true,
      contextTokens: j.contextTokens,
      timeoutMs: 600000,
      // 本地模型逐 token 生成大批次 JSON 慢，小批次降低单次超时概率
      maxQuestionsPerBatch: 12,
    };
  } catch {
    return null;
  }
}

export function judgeConfig(): JudgeConfig | null {
  const saved = readSettings();
  const j = saved?.judge;
  if (!j) return null;
  return buildJudgeConfig(j);
}
export function configFingerprint(config: ActiveConfig | JevJudgeConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.provider,
        config.endpoint,
        config.model,
        "protocol" in config ? config.protocol : "jev",
        "engine" in config ? "llm-adapter-v2" : "llm-adapter-v1",
      ]),
    )
    .digest("hex")
    .slice(0, 20);
}
export function saveSettings(s: ModelSettings, file = modelConfigPath) {
  const value = parseSettings(s);
  // 供应商登记簿:登记当前供应商的模型列表与 Key;顾问当前模型并入列表,供下拉随时切换
  const prior = readSettings(file)?.providers ?? {};
  const registry = { ...(value.providers ?? prior) };
  // 客户端回传的条目拿不到别家 Key(Key 不出服务端):没带就沿用登记簿已存的,别把别家 Key 抹掉
  for (const [url, e] of Object.entries(registry))
    if (!e.apiKey && prior[url]?.apiKey) e.apiKey = prior[url].apiKey;
  const known = registry[value.baseUrl] ?? {
    preset: value.preset,
    protocol: value.protocol,
    models: [] as string[],
  };
  const models = new Set([...(known.models ?? []), value.model]);
  registry[value.baseUrl] = {
    preset: value.preset,
    protocol: value.protocol,
    models: [...models].slice(0, 200),
    apiKey: value.apiKey || known?.apiKey,
  };
  value.providers = registry;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

/**
 * 拉取的模型列表并入登记簿（advisor/判官下拉的数据源），不覆盖已有条目的
 * preset/protocol/apiKey，去重合并（上限 200）。纯函数可测——设置页"拉取模型"
 * 成功后由 settings-api 落盘，用户不点保存下拉也有数据（2026-11-05 实踩：
 * 拉完不落盘，登记簿 0 个模型，下拉一直"未配置模型"）。
 */
export function mergeProviderModels(
  saved: ModelSettings,
  baseUrl: string,
  models: string[],
  preset: string,
  protocol: "openai" | "anthropic" | "jev",
): ModelSettings {
  const registry = { ...(saved.providers ?? {}) };
  const known = registry[baseUrl] ?? { preset, protocol, models: [] as string[] };
  registry[baseUrl] = {
    ...known,
    models: [...new Set([...(known.models ?? []), ...models])].slice(0, 200),
  };
  return { ...saved, providers: registry };
}
export function publicSettings() {
  try {
    const config = activeConfig(),
      saved = readSettings();
    return {
      ...(saved
        ? {
            preset: saved.preset,
            protocol: saved.protocol,
            baseUrl: saved.baseUrl,
            model: saved.model,
            jsonMode: saved.jsonMode,
            judge: saved.judge
              ? {
                  enabled: saved.judge.enabled,
                  baseUrl: saved.judge.baseUrl,
                  model: saved.judge.model,
                }
              : { enabled: false, baseUrl: "", model: "" },
            providers: [
              // 当前主模型所在的供应商永远是登记簿的一员(下拉选项来源,不含 Key 本体;能走到这里=activeConfig 构建成功=主 Key 在位)
              {
                baseUrl: saved.baseUrl,
                preset: saved.preset,
                protocol: saved.protocol,
                models:
                  saved.providers?.[saved.baseUrl]?.models ?? [saved.model],
                hasKey: true,
                enabled: saved.providers?.[saved.baseUrl]?.enabled ?? true,
                disabledModels: saved.providers?.[saved.baseUrl]?.disabledModels ?? [],
              },
              ...Object.entries(saved.providers ?? {})
                .filter(([baseUrl]) => baseUrl !== saved.baseUrl)
                .map(([baseUrl, v]) => ({
                  baseUrl,
                  preset: v.preset,
                  protocol: v.protocol,
                  models: v.models ?? [],
                  hasKey: !!v.apiKey,
                  enabled: v.enabled ?? true,
                  disabledModels: v.disabledModels ?? [],
                })),
            ],
          }
        : {
            preset: config.provider,
            protocol: "jev" as const,
            baseUrl: "",
            model: config.model,
            jsonMode: true,
          }),
      configured: true,
      hasKey: true,
      fingerprint: configFingerprint(config),
      source: saved ? ("web" as const) : ("environment" as const),
    };
  } catch {
    return {
      preset: "deepseek",
      protocol: "openai" as const,
      baseUrl: MODEL_PRESETS[0].baseUrl,
      model: MODEL_PRESETS[0].model,
      jsonMode: true,
      configured: false,
      hasKey: false,
      fingerprint: "",
      source: "none" as const,
      judge: { enabled: false, baseUrl: "", model: "" },
    };
  }
}
export function submittedSettings(body: unknown): ModelSettings {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ConfigurationError("配置格式不正确。");
  const s = parsed.data;
  // 主模型 Key 不回传:登记簿里有就直接用;否则必须与已存配置完全一致才沿用旧 Key
  if (!s.apiKey) {
    const saved = readSettings();
    const fromRegistry = saved?.providers?.[s.baseUrl]?.apiKey;
    const old = activeConfig(),
      view = publicSettings();
    const sameMain =
      view.preset === s.preset &&
      view.protocol === s.protocol &&
      view.baseUrl === s.baseUrl;
    if (fromRegistry) s.apiKey = fromRegistry;
    else if (sameMain) s.apiKey = old.apiKey;
    else
      throw new ConfigurationError(
        "更换服务商或地址后，请重新填写对应的 Key。",
      );
  }
  // 判官 Key 不回传:同地址沿用旧 Key;登记簿里的供应商自动继承其 Key;
  // 与主模型同源时继承主 Key;本地无需 Key。
  if (s.judge?.enabled && !s.judge.apiKey) {
    const saved = readSettings();
    const old = saved?.judge;
    if (old?.enabled && old.baseUrl === s.judge.baseUrl && old.apiKey)
      s.judge.apiKey = old.apiKey;
    else {
      const fromRegistry = saved?.providers?.[s.judge.baseUrl]?.apiKey;
      if (fromRegistry) s.judge.apiKey = fromRegistry;
      else {
        let sameOrigin = false;
        try {
          sameOrigin =
            !!s.apiKey &&
            !!s.baseUrl &&
            new URL(s.judge.baseUrl).origin === new URL(s.baseUrl).origin;
        } catch {
          sameOrigin = false;
        }
        if (sameOrigin) s.judge.apiKey = s.apiKey;
        else if (
          !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(s.judge.baseUrl)
        )
          throw new ConfigurationError(
            "更换评估服务后，请重新填写对应的 Key。",
          );
      }
    }
  }
  return parseSettings(s);
}
