import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeLlm,
  evaluateLlm,
  compileLlmInput,
  planLlmBatches,
  fastInferenceOptions,
} from "../server/llm";
import {
  parseSettings,
  settingsConfig,
  saveSettings,
  readSettings,
  configFingerprint,
  type LlmConfig,
} from "../server/model-config";
import { buildRequest, analyze } from "../server/analysis";
import { MODEL_PRESETS } from "../shared/model-presets";
const settings = {
  preset: "deepseek",
  protocol: "openai" as const,
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  apiKey: "test-only-key",
  jsonMode: true,
};
const qs = {
  mood: {
    type: "choice" as const,
    instructions: "情绪",
    criteria: { happy: null, sad: null },
  },
  quality: {
    type: "score" as const,
    instructions: "回复评级",
    criteria: ["low", "mid", "high"] as const,
  },
  enough: { type: "noul" as const, instructions: "足够吗" },
};
const usage = { input_tokens: 10, output_tokens: 20 };
const compact = {
  answers: { mood: [0.8, 0.2], quality: [0, 0.2, 0.8], enough: 0.9 },
};
test("LLM uses complete distributions, deterministic score/confidence, and preserves unknowns", () => {
  const r = decodeLlm(JSON.stringify(compact), qs, "test", usage);
  assert.equal((r.answers.mood as any).choice, "happy");
  // ε=0.1 平滑后：[0.77,0.23]，confidence=(0.77-0.5)/0.5
  assert.ok(Math.abs((r.answers.mood as any).confidence - 0.54) < 1e-9);
  // [0,0.2,0.8] → [1/30,0.2133,0.7533]，score=1×0.2133+2×0.7533
  assert.ok(Math.abs((r.answers.quality as any).score - 1.72) < 1e-9);
  assert.ok(Math.abs((r.answers.quality as any).confidence - 0.58) < 1e-9);
  for (const answers of [
    { ...compact.answers, mood: [80, 20] },
    { ...compact.answers, mood: [0.8] },
    { ...compact.answers, mood: [0, 0] },
    { ...compact.answers, mood: [0.2, 0.3] },
    { ...compact.answers, enough: null },
    { mood: [0.8, 0.2] },
    { ...compact.answers, extra: 1 },
  ])
    assert.throws(() =>
      decodeLlm(JSON.stringify({ answers }), qs, "test", usage),
    );
  assert.deepEqual(
    decodeLlm(
      "```json\n" + JSON.stringify(compact) + "\n```",
      qs,
      "test",
      usage,
    ),
    r,
  );
  assert.throws(() =>
    decodeLlm("explanation " + JSON.stringify(compact), qs, "test", usage),
  );
});
test("configuration validates destination, protects secrets, normalizes endpoints, persists across reads", () => {
  for (const baseUrl of [
    "https://user:secret@example.com/v1",
    "http://example.com/v1",
    "https://example.com/v1?key=secret",
    "file:///etc/passwd",
  ])
    assert.throws(() =>
      parseSettings({ ...settings, preset: "custom", baseUrl }),
    );
  assert.throws(() =>
    parseSettings({ ...settings, baseUrl: "https://evil.example/v1" }),
  );
  assert.throws(() => parseSettings({ ...settings, apiKey: "Bearer secret" }));
  assert.equal(
    parseSettings({
      ...settings,
      preset: "custom",
      baseUrl: "http://127.0.0.1:9999/v1/chat/completions/",
    }).baseUrl,
    "http://127.0.0.1:9999/v1",
  );
  const dir = mkdtempSync(join(tmpdir(), "crush-model-test-")),
    file = join(dir, "private", "model.json");
  try {
    saveSettings(settings, file);
    // 保存会把当前配置登记进供应商登记簿(baseUrl → 预设/协议/模型列表/Key),供顾问与评估下拉切换
    assert.deepEqual(readSettings(file), {
      ...settings,
      providers: {
        [settings.baseUrl]: {
          preset: settings.preset,
          protocol: settings.protocol,
          models: [settings.model],
          apiKey: settings.apiKey,
        },
      },
    });
    if (process.platform !== "win32")
      assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readFileSync(file, "utf8").includes("test-only-key"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(
    configFingerprint(settingsConfig(settings)),
    configFingerprint(settingsConfig({ ...settings, apiKey: "other-key" })),
  );
  assert.notEqual(
    configFingerprint(settingsConfig(settings)),
    configFingerprint(settingsConfig({ ...settings, model: "another-model" })),
  );
});
for (const protocol of ["openai", "anthropic"] as const)
  test(
    protocol +
      " transport, bounded batches, truncation, refusal and cancellation",
    async () => {
      const config = settingsConfig({
        ...settings,
        preset: "custom",
        protocol,
      }) as LlmConfig;
      let calls = 0;
      const mock: typeof fetch = async (url, options) => {
        calls++;
        assert.equal(url, config.endpoint);
        assert.equal(options?.redirect, "error");
        const body = JSON.parse(String(options?.body)),
          headers = new Headers(options?.headers);
        assert.equal(
          headers.get(protocol === "anthropic" ? "x-api-key" : "authorization"),
          protocol === "anthropic" ? "test-only-key" : "Bearer test-only-key",
        );
        const content = JSON.parse(body.messages.at(-1).content);
        assert.ok(Object.keys(content.questions).length <= 48);
        const answers = Object.fromEntries(
          Object.entries(content.questions).map(([id, q]: [string, any]) => [
            id,
            q.type === "noul"
              ? 0.5
              : Object.keys(content.definitions[q.criteria]).map((_, i) =>
                  i === 0 ? 1 : 0,
                ),
          ]),
        );
        return Response.json(
          protocol === "anthropic"
            ? {
                content: [{ type: "text", text: JSON.stringify({ answers }) }],
                usage,
              }
            : {
                choices: [
                  {
                    message: { content: JSON.stringify({ answers }) },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 20 },
              },
        );
      };
      const questions = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => ["q" + i, qs.mood]),
      );
      const r = await evaluateLlm(
        { state: "untrusted chat", questions },
        config,
        undefined,
        mock,
      );
      assert.equal(calls, 1);
      assert.equal(Object.keys(r.answers).length, 25);
      assert.equal(r.usage.input_tokens, 10);
      await assert.rejects(
        evaluateLlm(
          { state: "x", questions: qs },
          config,
          undefined,
          async () =>
            Response.json(
              protocol === "anthropic"
                ? { stop_reason: "max_tokens" }
                : { choices: [{ finish_reason: "length" }] },
            ),
        ),
        /未完整返回/,
      );
      await assert.rejects(
        evaluateLlm(
          { state: "x", questions: qs },
          config,
          undefined,
          async () => new Response("secret-echo", { status: 401 }),
        ),
        (e) => !String(e).includes("secret-echo"),
      );
      const ctrl = new AbortController();
      ctrl.abort();
      await assert.rejects(
        evaluateLlm(
          { state: "x", questions: qs },
          config,
          undefined,
          async () => {
            assert.fail("no fetch");
          },
        ),
      );
    },
  );
test("判官请求固定温度与种子保证可复现；供应商不认时降级重试", async () => {
  const config = settingsConfig({
    ...settings,
    preset: "custom",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-8B",
  }) as LlmConfig;
  // 按请求里的 wire 题目构造合法答案（choice/score 返回首位权重向量，noul 返回数值）
  const wireAnswers = (requestBody: any) => {
    const content = JSON.parse(requestBody.messages.at(-1).content);
    return Object.fromEntries(
      Object.entries(content.questions).map(([id, q]: [string, any]) => [
        id,
        q.type === "noul"
          ? 0.5
          : Object.keys(content.definitions[q.criteria]).map((_, i) =>
              i === 0 ? 1 : 0,
            ),
      ]),
    );
  };
  const okBody = (requestBody: any) =>
    Response.json({
      choices: [
        {
          message: { content: JSON.stringify({ answers: wireAnswers(requestBody) }) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  const bodies: any[] = [];
  await evaluateLlm({ state: "x", questions: qs }, config, undefined, async (
    _url,
    options,
  ) => {
    bodies.push(JSON.parse(String(options?.body)));
    return okBody(bodies[0]);
  });
  assert.equal(bodies[0].temperature, 0);
  assert.equal(typeof bodies[0].seed, "number");

  // 供应商拒绝 sampling 参数：一次 400，剥掉后重试成功，业务结果不受影响
  let calls = 0;
  const r = await evaluateLlm(
    { state: "x", questions: qs },
    config,
    undefined,
    async (_url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      if (calls === 1) {
        assert.equal(body.temperature, 0);
        return Response.json(
          { error: { message: "seed is not supported by this model" } },
          { status: 400 },
        );
      }
      assert.equal(body.temperature, undefined);
      assert.equal(body.seed, undefined);
      return okBody(body);
    },
  );
  assert.equal(calls, 2);
  assert.equal(Object.keys(r.answers).length, 3);

  // anthropic 路径：温度 0、无 seed（协议不支持）
  const anthropicConfig = settingsConfig({
    ...settings,
    preset: "custom",
    protocol: "anthropic",
  }) as LlmConfig;
  let ab: any;
  await evaluateLlm(
    { state: "x", questions: qs },
    anthropicConfig,
    undefined,
    async (_url, options) => {
      ab = JSON.parse(String(options?.body));
      return Response.json({
        content: [
          { type: "text", text: JSON.stringify({ answers: wireAnswers(ab) }) },
        ],
        usage,
      });
    },
  );
  assert.equal(ab.temperature, 0);
  assert.equal(ab.seed, undefined);
});
test("思考型 qwen3 判官套用专属提示词并解除格式约束；其他模型保持原样", async () => {
  const sf = settingsConfig({
    ...settings,
    preset: "custom",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-8B",
  }) as LlmConfig;
  // 开思考：不注入限思参数；非思考的 qwen2.5 仍按原策略压制
  assert.deepEqual(fastInferenceOptions(sf), {});
  assert.deepEqual(fastInferenceOptions({ ...sf, model: "Qwen/Qwen2.5-7B" }), {
    enable_thinking: false,
  });
  const bodies: any[] = [];
  await evaluateLlm({ state: "x", questions: qs }, sf, undefined, async (
    _url,
    options,
  ) => {
    const body = JSON.parse(String(options?.body));
    bodies.push(body);
    const content = JSON.parse(body.messages.at(-1).content);
    const answers = Object.fromEntries(
      Object.entries(content.questions).map(([id, q]: [string, any]) => [
        id,
        q.type === "noul"
          ? 0.5
          : Object.keys(content.definitions[q.criteria]).map((_, i) =>
              i === 0 ? 1 : 0,
            ),
      ]),
    );
    return Response.json({
      choices: [
        {
          message: { content: JSON.stringify({ answers }) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  });
  // jsonMode 配置开着，但思考判官解除格式约束；提示词换成思考版；温度 0 保持
  assert.equal(bodies[0].response_format, undefined);
  assert.match(bodies[0].messages[0].content, /权重刻度/);
  assert.match(bodies[0].messages[0].content, /反塌缩/);
  assert.equal(bodies[0].temperature, 0);
  // 非 qwen3 模型（deepseek 预设）：原提示词、response_format 照发
  const bodies2: any[] = [];
  await evaluateLlm(
    { state: "x", questions: qs },
    settingsConfig(settings) as LlmConfig,
    undefined,
    async (_url, options) => {
      bodies2.push(JSON.parse(String(options?.body)));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answers: { q0: [1, 0], q1: [1, 0, 0], q2: 0.5 },
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    },
  );
  assert.equal(bodies2[0].response_format.type, "json_object");
  assert.doesNotMatch(bodies2[0].messages[0].content, /权重刻度/);
});
test("all provider presets map to the intended protocol and never borrow Jev keys", () => {
  for (const preset of MODEL_PRESETS.filter((p) => p.id !== "custom")) {
    const config = settingsConfig({
      preset: preset.id,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.model || "test-model",
      apiKey: "test-only-key",
      jsonMode: true,
    });
    assert.equal(config.provider, preset.id);
    if (preset.protocol !== "jev") assert.ok("engine" in config);
  }
});
test("LLM flows through existing overview/emotion/intent/self rating rules", async (t) => {
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)),
      { questions, definitions } = JSON.parse(body.messages.at(-1).content);
    const answers = Object.fromEntries(
      Object.entries(questions).map(([id, q]: [string, any]) => [
        id,
        q.type === "noul"
          ? 0.8
          : Object.keys(definitions[q.criteria]).map((_, i) =>
              i === 0 ? 1 : 0,
            ),
      ]),
    );
    return Response.json({
      choices: [
        {
          message: { content: JSON.stringify({ answers }) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  };
  for (const task of ["overview", "other_messages", "self_message"] as const) {
    const input = {
      revision: 1,
      relation: "crush" as const,
      task,
      targetIds:
        task === "overview" ? [] : [task === "other_messages" ? "m1" : "m2"],
      messages: [
        {
          id: "m1",
          sender: "other" as const,
          text: "周末一起吃饭吗？",
          timestamp: null,
          kind: "text" as const,
        },
        {
          id: "m2",
          sender: "self" as const,
          text: "好啊，你想吃什么？",
          timestamp: null,
          kind: "text" as const,
        },
      ],
    };
    assert.ok(Object.keys(buildRequest(input).questions).length);
    const r = await analyze(input, undefined, settingsConfig(settings));
    assert.equal(r.model, settings.model);
    assert.equal(r.revision, 1);
    if (task === "overview") assert.ok(r.overview);
    else assert.ok(r.lines?.length);
  }
});

test("LLM weighted candidate IDs preserve distributions without inventing labels or remainder", () => {
  const r = decodeLlm(
    JSON.stringify({
      answers: { mood: { c0: 80, c1: 15 }, quality: [0, 20, 80], enough: 0.7 },
    }),
    qs,
    "test",
    usage,
    true,
  );
  assert.ok(
    Math.abs(
      (r.answers.mood as any).probabilities.happy - ((80 / 95) * 0.9 + 0.05),
    ) < 1e-9,
  );
  assert.ok(Math.abs((r.answers.quality as any).score - 1.72) < 1e-9);
  for (const mood of [
    { happy: 80 },
    { c7: 50 },
    { c0: 0 },
    { c0: 101 },
    { c0: -1 },
  ])
    assert.throws(() =>
      decodeLlm(
        JSON.stringify({
          answers: { mood, quality: [0, 20, 80], enough: 0.7 },
        }),
        qs,
        "test",
        usage,
        true,
      ),
    );
});
test("LLM shares criteria but physically separates self replies from future continuations", () => {
  const messages = [
    {
      id: "m0",
      sender: "other",
      text: "周末一起吃饭吗？",
      timestamp: null,
      kind: "text",
    },
    { id: "m1", sender: "self", text: "好啊", timestamp: null, kind: "text" },
    {
      id: "m2",
      sender: "other",
      text: "我其实不想见面",
      timestamp: null,
      kind: "text",
    },
    { id: "m3", sender: "self", text: "知道了", timestamp: null, kind: "text" },
  ] as const;
  const input = buildRequest({
    revision: 1,
    relation: "crush",
    task: "self_message",
    targetIds: ["m1", "m3"],
    messages: [...messages],
  });
  const batches = planLlmBatches(input.questions);
  assert.equal(batches.length, 2);
  const early = compileLlmInput(input.state, batches[0]);
  assert.ok(!JSON.stringify(early).includes("我其实不想见面"));
  assert.ok(!JSON.stringify(early).includes("知道了"));
  assert.ok(
    JSON.stringify(compileLlmInput(input.state, batches[1])).includes("知道了"),
  );
  const other = buildRequest({
    revision: 1,
    relation: "crush",
    task: "other_messages",
    targetIds: ["m0", "m2"],
    messages: [...messages],
  });
  assert.equal(planLlmBatches(other.questions).length, 1);
  assert.equal(
    Object.keys(compileLlmInput(other.state, other.questions).definitions)
      .length,
    4,
  );
});
test("thinking switches apply only to supported native providers and models", () => {
  const c = settingsConfig(settings) as LlmConfig;
  assert.deepEqual(fastInferenceOptions(c), { thinking: { type: "disabled" } });
  assert.deepEqual(
    fastInferenceOptions({
      ...c,
      endpoint: "https://custom.example/v1/chat/completions",
    }),
    {},
  );
  assert.deepEqual(
    fastInferenceOptions({
      ...c,
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: "glm-5.3",
    }),
    { thinking: { type: "disabled" } },
  );
  assert.deepEqual(
    fastInferenceOptions({
      ...c,
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
      model: "kimi-k2-thinking",
    }),
    {},
  );
});
test("a truncated batch splits once, retries with more budget, and restores original IDs", async () => {
  let calls = 0;
  const result = await evaluateLlm(
    { state: "synthetic", questions: qs },
    settingsConfig(settings) as LlmConfig,
    undefined,
    async (_u, o) => {
      const body = JSON.parse(String(o?.body));
      calls++;
      if (calls === 1)
        return Response.json({
          choices: [{ finish_reason: "length" }],
          usage: { completion_tokens: 8192 },
        });
      assert.equal(body.max_tokens, 16384);
      const input = JSON.parse(body.messages.at(-1).content);
      const answers = Object.fromEntries(
        Object.entries(input.questions).map(([id, q]: [string, any]) => [
          id,
          q.type === "noul"
            ? 0.9
            : q.type === "choice"
              ? { c0: 100 }
              : Object.keys(input.definitions[q.criteria]).map((_, i) =>
                  i === 0 ? 100 : 0,
                ),
        ]),
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ answers }) },
          },
        ],
      });
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(Object.keys(result.answers).sort(), Object.keys(qs).sort());
  assert.equal(result.usage.output_tokens, 8192);
});

test("one malformed judgment retries alone and retains valid siblings", async () => {
  let calls = 0;
  const result = await evaluateLlm(
    { state: "synthetic", questions: qs },
    settingsConfig(settings) as LlmConfig,
    undefined,
    async (_u, o) => {
      const body = JSON.parse(String(o?.body)),
        input = JSON.parse(body.messages.at(-1).content);
      calls++;
      if (calls === 1)
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  answers: { q0: { c99: 100 }, q1: [0, 20, 80], q2: 0.6 },
                }),
              },
            },
          ],
        });
      assert.equal(Object.keys(input.questions).length, 1);
      assert.equal(input.questions.q0.type, "choice");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ answers: { q0: { c0: 80, c1: 20 } } }),
            },
          },
        ],
      });
    },
  );
  assert.equal(calls, 2);
  assert.ok(Math.abs((result.answers.quality as any).score - 1.72) < 1e-9);
  assert.equal((result.answers.enough as any).noul, 0.6);
});

test("单选塌缩的数学下界：任何选项都不可能是 100% 或 0%，且 argmax 保序", () => {
  const r = decodeLlm(
    JSON.stringify({ answers: { mood: { c0: 100 } } }),
    { mood: qs.mood },
    "test",
    usage,
    true,
  );
  const p = (r.answers.mood as any).probabilities as Record<string, number>;
  for (const v of Object.values(p)) {
    assert.ok(v > 0 && v < 1, `概率必须开区间: ${v}`);
  }
  assert.equal((r.answers.mood as any).choice, "happy");
  // 全押一项 → 平滑后峰值 0.9+1/2 份额的一半：0.95
  assert.ok(Math.abs(p.happy - 0.95) < 1e-9);
});

test("批次上限可配置：慢速本地模型可以调小单批题目数", () => {
  const questions = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => ["q" + i, qs.mood]),
  );
  const small = planLlmBatches(questions, 10);
  assert.equal(small.length, 3);
  for (const b of small) assert.ok(Object.keys(b).length <= 10);
  assert.ok(planLlmBatches(questions).length < small.length);
});

test("本地模型响应超时翻译成人话，不显示网络错误", async () => {
  const judge: LlmConfig = {
    engine: "llm",
    provider: "judge",
    name: "本地评估模型",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    model: "jevk5",
    apiKey: "local",
    protocol: "openai",
    jsonMode: true,
    timeoutMs: 600000,
    maxQuestionsPerBatch: 12,
  };
  const headersTimeout = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
  });
  await assert.rejects(
    evaluateLlm(
      { state: "x", questions: { mood: qs.mood } },
      judge,
      undefined,
      async () => {
        throw headersTimeout;
      },
    ),
    (e: unknown) => {
      const msg = String((e as { message?: string })?.message || e);
      return /模型生成超时/.test(msg) && /600 秒/.test(msg);
    },
  );
  // 应用层超时（AbortSignal.timeout 的 TimeoutError）同样翻译
  const appTimeout = Object.assign(new Error("The operation was aborted"), {
    name: "TimeoutError",
  });
  await assert.rejects(
    evaluateLlm(
      { state: "x", questions: { mood: qs.mood } },
      { ...judge, timeoutMs: 50 },
      undefined,
      async () => {
        await new Promise((r) => setTimeout(r, 120));
        throw appTimeout;
      },
    ),
    /模型生成超时/,
  );
});
test("saveSettings：弹窗回传的供应商条目不带 Key 时沿用登记簿已存的（别家 Key 不被抹掉）", () => {
  const dir = mkdtempSync(join(tmpdir(), "crush-key-test-")),
    file = join(dir, "model.json");
  try {
    // 第一次保存：硅基流动存过 Key（Key 不出服务端，此后客户端回传的条目永远不含它）
    saveSettings(
      {
        ...settings,
        providers: {
          "https://api.siliconflow.cn/v1": {
            preset: "siliconflow",
            protocol: "openai",
            models: ["Qwen/Qwen3-8B"],
            apiKey: "silicon-key",
          },
        },
      },
      file,
    );
    // 第二次保存：模拟模型设置弹窗回传形态——providers 条目一律不带 apiKey
    saveSettings(
      {
        ...settings,
        providers: {
          [settings.baseUrl]: {
            preset: settings.preset,
            protocol: settings.protocol,
            models: [settings.model],
          },
          "https://api.siliconflow.cn/v1": {
            preset: "siliconflow",
            protocol: "openai",
            models: ["Qwen/Qwen3-8B"],
          },
        },
      },
      file,
    );
    const after = readSettings(file)!;
    assert.equal(
      after.providers!["https://api.siliconflow.cn/v1"]!.apiKey,
      "silicon-key",
    );
    assert.equal(after.providers![settings.baseUrl]!.apiKey, "test-only-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
