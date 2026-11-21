// 工具能力自适应缓存（server/tool-support.ts）：按 (供应商,模型) 学习是否支持
// function calling——不支持的工具循环首轮 4xx 且去 tools 重试成功才记负样本，
// 之后对该模型直接单发。配合 tests/advisor-status.test.ts（4xx 保留）食用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capKey,
  markToolsUnsupported,
  resetToolSupportForTest,
  toolsKnownUnsupported,
} from "../server/tool-support";
import { advisorToolLoop } from "../server/advise";
import type { LlmConfig } from "../server/model-config";

const ENDPOINT = "https://api.example.com/v1/chat/completions";
const config: LlmConfig = {
  engine: "llm",
  provider: "p",
  name: "n",
  endpoint: ENDPOINT,
  model: "vendor/model-a",
  apiKey: "k",
  protocol: "openai",
  jsonMode: false,
};

function tempFile() {
  return join(
    mkdtempSync(join(tmpdir(), "tool-support-")),
    "tool-support.json",
  );
}

function scriptFetch(
  script: { status: number; body: unknown }[],
  seen: { url: string; body: any }[],
) {
  const orig = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const step = script[Math.min(i++, script.length - 1)];
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

const okText = { choices: [{ message: { content: "好的" } }] };

test("学习缓存：记负样本后 toolsKnownUnsupported 命中，且落盘可查", () => {
  const file = tempFile();
  resetToolSupportForTest(file);
  assert.equal(toolsKnownUnsupported(ENDPOINT, "vendor/model-a"), false);
  markToolsUnsupported(ENDPOINT, "vendor/model-a");
  assert.equal(toolsKnownUnsupported(ENDPOINT, "vendor/model-a"), true);
  assert.equal(toolsKnownUnsupported(ENDPOINT, "vendor/other"), false, "按模型隔离");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
  assert.equal(raw[capKey(ENDPOINT, "vendor/model-a")], false, "落盘内容可读");
});

test("advisorToolLoop：已学不支持 → 单发一枪且不带 tools", async () => {
  resetToolSupportForTest(tempFile());
  markToolsUnsupported(ENDPOINT, "vendor/model-a");
  const seen: { url: string; body: any }[] = [];
  const restore = scriptFetch([{ status: 200, body: okText }], seen);
  try {
    const text = await advisorToolLoop(config, [{ role: "user", content: "q" }], {
      contactId: "c1",
    });
    assert.equal(text, "好的");
    assert.equal(seen.length, 1, "只打一发");
    assert.equal(seen[0].body.tools, undefined, "不带 tools");
  } finally {
    restore();
  }
});

test("advisorToolLoop：未知模型 400 → 去 tools 重试成功并记负样本", async () => {
  // 唯一临时文件：固定路径会被上次运行的落盘负样本污染（load() 读回旧状态，
  // toolsKnownUnsupported 误判 true → 单发路径吃掉脚本里的 400）
  const file = tempFile();
  resetToolSupportForTest(file);
  const seen: { url: string; body: any }[] = [];
  const restore = scriptFetch(
    [
      { status: 400, body: { error: { message: "Tools is not supported" } } },
      { status: 200, body: okText },
    ],
    seen,
  );
  try {
    const text = await advisorToolLoop(config, [{ role: "user", content: "q" }], {
      contactId: "c1",
    });
    assert.equal(text, "好的");
    assert.equal(seen.length, 2);
    assert.ok(seen[0].body.tools, "首发带 tools");
    assert.equal(seen[1].body.tools, undefined, "重试去 tools");
    assert.equal(toolsKnownUnsupported(ENDPOINT, "vendor/model-a"), true, "已记负样本");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
    assert.equal(raw[capKey(ENDPOINT, "vendor/model-a")], false, "负样本已落盘");
  } finally {
    restore();
  }
});

test("advisorToolLoop：重试也失败 → 不记负样本（拒因不是 tools）", async () => {
  resetToolSupportForTest(tempFile());
  const seen: { url: string; body: any }[] = [];
  const restore = scriptFetch(
    [
      { status: 400, body: { error: { message: "context too long" } } },
      { status: 400, body: { error: { message: "context too long" } } },
    ],
    seen,
  );
  try {
    await assert.rejects(
      advisorToolLoop(config, [{ role: "user", content: "q" }], {
        contactId: "c1",
      }),
    );
    assert.equal(toolsKnownUnsupported(ENDPOINT, "vendor/model-a"), false, "不误记");
  } finally {
    restore();
  }
});
