import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJudgeConfig } from "../server/model-config";

test("判官协议：jev → JevJudgeConfig（endpoint 为服务根，不补 /chat/completions）", () => {
  const c = buildJudgeConfig({
    enabled: true,
    baseUrl: "http://127.0.0.1:8090/",
    model: "startlux-9b",
    apiKey: "",
    protocol: "jev",
  });
  assert.ok(c);
  assert.equal(c.protocol, "jev");
  assert.equal(c.endpoint, "http://127.0.0.1:8090");
  assert.equal((c as { provider: string }).provider, "startlux");
  assert.equal("engine" in c, false, "JevJudgeConfig 不得带 engine（evaluate 按 engine 分流）");
});

test("判官协议：openai（缺省）→ LlmConfig，自动补 /chat/completions 且幂等", () => {
  const a = buildJudgeConfig({
    enabled: true,
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:4b",
    apiKey: "",
  });
  assert.ok(a);
  assert.equal(a.protocol, "openai");
  assert.equal(a.endpoint, "http://127.0.0.1:11434/v1/chat/completions");
  const b = buildJudgeConfig({
    enabled: true,
    baseUrl: "http://127.0.0.1:11434/v1/chat/completions",
    model: "qwen3:4b",
    apiKey: "",
    protocol: "openai",
  });
  assert.ok(b);
  assert.equal(b.endpoint, "http://127.0.0.1:11434/v1/chat/completions");
});

test("判官协议：未启用/缺字段返回 null", () => {
  assert.equal(
    buildJudgeConfig({ enabled: false, baseUrl: "http://x", model: "m", apiKey: "" }),
    null,
  );
  assert.equal(
    buildJudgeConfig({ enabled: true, baseUrl: "", model: "m", apiKey: "" }),
    null,
  );
  assert.equal(
    buildJudgeConfig({ enabled: true, baseUrl: "http://x", model: "", apiKey: "" }),
    null,
  );
});
