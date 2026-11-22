// 顾问 4xx 状态码保留（2026-11-05 实踩）：硅基流动 R1/Xing 等不支持 function
// calling 的模型带 tools 请求返回 400，旧代码把 400 映射成 502，导致
// advisorToolLoop 首轮"4xx → 去 tools 重试"的兜底条件（status∈[400,500)）永不
// 命中，错误直达 UI（用户看到的"顾问调用失败 HTTP 400"）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { advisorOpenAICall } from "../server/advise";
import { mergeProviderModels, parseSettings } from "../server/model-config";
import type { ModelSettings } from "../shared/model-presets";
import type { LlmConfig } from "../server/model-config";

const config: LlmConfig = {
  engine: "llm",
  provider: "p",
  name: "n",
  endpoint: "http://127.0.0.1:9/v1/chat/completions",
  model: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
  apiKey: "k",
  protocol: "openai",
  jsonMode: false,
};

function withFetch(status: number, body: unknown) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("advisorOpenAICall：上游 400 原样保留 status（工具循环兜底依赖）", async () => {
  const restore = withFetch(400, {
    error: { message: "Tools is not supported" },
  });
  try {
    await assert.rejects(
      advisorOpenAICall(config, [{ role: "user", content: "hi" }]),
      (e: unknown) => {
        const err = e as { status?: number; message?: string };
        assert.equal(err.status, 400, "4xx 不被改写成 502");
        assert.match(err.message ?? "", /HTTP 400/);
        assert.match(err.message ?? "", /Tools is not supported/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("advisorOpenAICall：5xx 仍统一 502", async () => {
  const restore = withFetch(503, { error: { message: "overloaded" } });
  try {
    await assert.rejects(
      advisorOpenAICall(config, [{ role: "user", content: "hi" }]),
      (e: unknown) => (e as { status?: number }).status === 502,
    );
  } finally {
    restore();
  }
});

test("mergeProviderModels：拉取列表并入登记簿，保留已有条目与 Key", () => {
  const saved = {
    preset: "siliconflow",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
    apiKey: "k1",
    jsonMode: false,
    providers: {
      "https://api.siliconflow.cn/v1": {
        preset: "siliconflow",
        protocol: "openai" as const,
        models: ["Qwen/Qwen3-8B"],
        apiKey: "stored-key",
      },
      "https://api.deepseek.com/v1": {
        preset: "deepseek",
        protocol: "openai" as const,
        models: ["deepseek-chat"],
      },
    },
  } as ModelSettings;
  const merged = mergeProviderModels(
    saved,
    "https://api.siliconflow.cn/v1",
    ["Qwen/Qwen3-8B", "XingChenAGI/Xing4.0-29B"],
    "siliconflow",
    "openai",
  );
  const entry = merged.providers!["https://api.siliconflow.cn/v1"];
  assert.ok(entry, "条目存在");
  assert.deepEqual(entry.models, ["Qwen/Qwen3-8B", "XingChenAGI/Xing4.0-29B"]);
  assert.equal(entry.apiKey, "stored-key", "不覆盖已存 Key");
  assert.equal(
    merged.providers!["https://api.deepseek.com/v1"]!.models![0],
    "deepseek-chat",
    "其他供应商条目原样",
  );
  assert.equal(merged.model, saved.model, "当前模型不动");
});

test("mergeProviderModels：无已有条目时新建（不含 Key），去重封顶 200", () => {
  const saved = {
    preset: "siliconflow",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "m",
    apiKey: "k",
    jsonMode: false,
  } as ModelSettings;
  const hundred = Array.from({ length: 300 }, (_, i) => `m${i}`);
  const merged = mergeProviderModels(
    saved,
    "https://x/v1",
    ["a", "a", ...hundred],
    "custom",
    "openai",
  );
  const entry = merged.providers!["https://x/v1"];
  assert.ok(entry, "条目存在");
  assert.ok(entry.models, "models 数组存在");
  assert.equal(entry.models.length, 200, "封顶 200");
  assert.equal(entry.models[0], "a", "去重");
  assert.equal(entry.apiKey, undefined, "新建条目不带 Key");
});

test("防回归：登记簿存 200 个模型能过 parseSettings（schema 曾钳 50 致落盘静默失败）", () => {
  const saved = {
    preset: "siliconflow",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
    apiKey: "k",
    jsonMode: false,
    providers: {
      "https://api.siliconflow.cn/v1": {
        preset: "siliconflow",
        protocol: "openai" as const,
        models: Array.from({ length: 200 }, (_, i) => `vendor/model-${i}`),
      },
    },
  } as ModelSettings;
  assert.doesNotThrow(() => parseSettings(saved));
});
