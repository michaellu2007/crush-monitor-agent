// 顾问 D1 摘要冻结协议（2026-11-11）：压缩从"每请求重摘"改为"低频压缩事件"，
// 事件间消息数组 append-only，云 API 隐式前缀缓存才可命中。
// 依据 docs/agent对话上下文管理调研.md §6.2；mock fetch 模式沿用 advisor-status.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactDialog,
  dialogHash,
  ADVISOR_SYSTEM,
} from "../server/advise";
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

const turn = (role: "user" | "assistant", content: string, ts?: number) =>
  ts == null ? { role, content } : { role, content, ts };

/** mock fetch：记录请求体，返回固定摘要回复 */
function withSummaryFetch(text = "冻结测试摘要") {
  const bodies: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: any, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    bodies,
    count: () => bodies.length,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

test("dialogHash：确定性；内容或 ts 变一位指纹就变", () => {
  const a = [turn("user", "你好"), turn("assistant", "好啊", 123)];
  assert.equal(dialogHash(a), dialogHash([turn("user", "你好"), turn("assistant", "好啊", 123)]));
  assert.notEqual(dialogHash(a), dialogHash([turn("user", "你好"), turn("assistant", "好啊", 456)]));
  assert.notEqual(dialogHash(a), dialogHash([turn("user", "你好"), turn("assistant", "好啊呀", 123)]));
});

test("≤8 轮：不触发压缩、不打摘要调用、无 summary", async () => {
  const m = withSummaryFetch();
  try {
    const d = Array.from({ length: 8 }, (_, i) => turn(i % 2 ? "assistant" : "user", `t${i}`));
    const out = await compactDialog(config, d);
    assert.equal(m.count(), 0, "短对话不花摘要调用");
    assert.equal(out.summary, undefined);
    assert.equal(out.dialog.length, 8);
  } finally {
    m.restore();
  }
});

test(">8 轮无缓存：新压缩事件——打一次摘要调用（temp 0），摘要覆盖除最近 8 轮外的全部", async () => {
  const m = withSummaryFetch();
  try {
    const d = Array.from({ length: 12 }, (_, i) => turn(i % 2 ? "assistant" : "user", `旧轮${i}`));
    const out = await compactDialog(config, d);
    assert.equal(m.count(), 1, "恰好一次摘要调用");
    assert.equal(m.bodies[0].temperature, 0, "D4：摘要调用 temp 0");
    assert.equal(out.summary?.throughCount, 4, "12 轮 - 最近 8 轮");
    assert.equal(out.summary?.throughHash, dialogHash(d.slice(0, 4)));
    assert.equal(out.dialog.length, 9, "摘要轮 + 最近 8 轮");
    assert.ok(out.dialog[0].content.includes("背景摘要"));
    assert.ok(out.dialog[0].content.includes("冻结测试摘要"));
    assert.equal(out.dialog[out.dialog.length - 1].content, "旧轮11", "末尾原话保留");
  } finally {
    m.restore();
  }
});

test("D1 命中：带回的冻结摘要指纹匹配 → 零调用复用，数组 = [摘要轮, ...覆盖段之后原话]", async () => {
  const m = withSummaryFetch();
  try {
    const d = Array.from({ length: 10 }, (_, i) => turn(i % 2 ? "assistant" : "user", `c${i}`));
    const cached = { throughCount: 4, throughHash: dialogHash(d.slice(0, 4)), text: "旧摘要" };
    const out = await compactDialog(config, d, 0, cached);
    assert.equal(m.count(), 0, "命中不重摘");
    assert.deepEqual(out.summary, cached, "原样透传给前端继续缓存");
    assert.equal(out.dialog.length, 7, "摘要轮 + 覆盖段之后 6 轮");
    assert.ok(out.dialog[0].content.includes("旧摘要"));
    assert.equal(out.dialog[1].content, "c4", "覆盖段之后原话逐字保留（append-only 基线）");
  } finally {
    m.restore();
  }
});

test("D1 失效：指纹不匹配（对话被改/换人）→ 退回新压缩事件重摘", async () => {
  const m = withSummaryFetch();
  try {
    const d = Array.from({ length: 10 }, (_, i) => turn(i % 2 ? "assistant" : "user", `x${i}`));
    const cached = { throughCount: 4, throughHash: "deadbeefdeadbeefdeadbeefdeadbeef", text: "串话摘要" };
    const out = await compactDialog(config, d, 0, cached);
    assert.equal(m.count(), 1, "重摘一次");
    assert.equal(out.summary?.throughCount, 2, "新摘要覆盖除最近 8 轮外的全部");
    assert.ok(!out.dialog[0].content.includes("串话摘要"), "不复用失效摘要");
  } finally {
    m.restore();
  }
});

test("D1 尾巴攒多（>16 轮）→ 发起下一次压缩事件（覆盖除最近 8 轮外的全部）", async () => {
  const m = withSummaryFetch();
  try {
    const d = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? "assistant" : "user", `y${i}`));
    const cached = { throughCount: 2, throughHash: dialogHash(d.slice(0, 2)), text: "旧摘要" };
    const out = await compactDialog(config, d, 0, cached);
    assert.equal(m.count(), 1, "尾巴 18 > 16 → 重摘");
    assert.equal(out.summary?.throughCount, 12, "20 - 8");
    assert.ok(out.dialog[0].content.includes("冻结测试摘要"));
  } finally {
    m.restore();
  }
});

test("增量压缩：旧摘要指纹仍匹配 → 压缩器只喂'既有摘要+新增轮次'，不重读全史", async () => {
  const m = withSummaryFetch("增量更新摘要");
  try {
    const d = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? "assistant" : "user", `n${i}`));
    // 旧摘要覆盖前 2 轮（逐字未变），尾巴 18 轮 > 16 → 触发新压缩事件
    const cached = { throughCount: 2, throughHash: dialogHash(d.slice(0, 2)), text: "旧摘要正文" };
    const out = await compactDialog(config, d, 0, cached);
    assert.equal(m.count(), 1, "恰一次压缩调用");
    const body = m.bodies[0];
    const raw = body.messages.at(-1).content;
    assert.ok(raw.includes("旧摘要正文"), "压缩器输入含既有摘要");
    assert.ok(raw.includes("n2") && raw.includes("n11"), "输入含新增轮次（2..older_end）");
    assert.ok(!raw.includes("n0：") && !raw.includes("\nn0\n") && !/\bn0\b/.test(raw), "不重复喂已摘要轮次原文");
    assert.equal(out.summary?.throughCount, 12, "新摘要覆盖 20-8=12 轮");
    assert.equal(out.summary?.text, "增量更新摘要");
  } finally {
    m.restore();
  }
});

test("B4 回归：模型不听嘱咐返回超长摘要 → 服务端硬裁 ≤1500 字（防下轮 400 死循环）", async () => {
  const m = withSummaryFetch("长".repeat(3000));
  try {
    const d = Array.from({ length: 12 }, (_, i) => turn(i % 2 ? "assistant" : "user", `t${i}`));
    const out = await compactDialog(config, d);
    assert.ok(out.summary, "有摘要");
    assert.ok(out.summary.text.length <= 1500, `实际 ${out.summary.text.length}`);
    assert.equal(out.summary.text.length, 1500);
  } finally {
    m.restore();
  }
});

test("摘要调用失败：退回全量封顶、不抛错、无 summary（主流程不阻断）", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "boom" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const d = Array.from({ length: 10 }, (_, i) => turn(i % 2 ? "assistant" : "user", `z${i}`));
    const out = await compactDialog(config, d);
    assert.equal(out.summary, undefined);
    assert.equal(out.dialog.length, 10, "全量退回（未超预算不丢轮）");
  } finally {
    globalThis.fetch = orig;
  }
});

test("D2：系统提示逐字稳定——不含按题变化的战术参考标记", () => {
  assert.ok(!ADVISOR_SYSTEM.includes("策略参考"), "战术参考（按题选取）已移出 system");
  assert.ok(!ADVISOR_SYSTEM.includes("互惠披露阶梯"), "具体战术条目不在 system 里");
  assert.ok(ADVISOR_SYSTEM.includes("关系策略师"), "人设仍在");
  assert.ok(
    ADVISOR_SYSTEM.includes("多轮对话（消息历史里有此前问答时）"),
    "多轮连续性规则在 system 里（2026-11-13 续问像新会话修复）",
  );
});
