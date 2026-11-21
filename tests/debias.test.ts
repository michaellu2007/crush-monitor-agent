import { test } from "node:test";
import assert from "node:assert/strict";
import { choice, score, noul, type Questions } from "@typesafe-ai/sdk";
import { debiasChoiceOrders } from "../server/debias";
import { buildRequest } from "../server/analysis";
import { decodeLlm } from "../server/llm";
import { TARGETS } from "../shared/labels";

const targetsQuestion = choice(
  "测试题",
  Object.fromEntries(
    Object.entries(TARGETS).map(([k, v]) => [k, v.criteria]),
  ),
);
const keysOf = (q: { criteria: Record<string, unknown> }) =>
  Object.keys(q.criteria);

test("确定性：同盐同候选集排列完全一致", () => {
  const qs: Questions = { t: targetsQuestion };
  const a = debiasChoiceOrders(qs, "salt-a");
  const b = debiasChoiceOrders(qs, "salt-a");
  assert.deepEqual(keysOf(a.t as never), keysOf(b.t as never));
});

test("候选集合与取值不变，仅顺序重排", () => {
  const out = debiasChoiceOrders({ t: targetsQuestion }, "salt-a");
  const before = Object.keys(targetsQuestion.criteria);
  const after = keysOf(out.t as never);
  assert.deepEqual([...after].sort(), [...before].sort());
  for (const k of before)
    assert.equal(
      (out.t as { criteria: Record<string, string> }).criteria[k],
      targetsQuestion.criteria[k],
    );
});

test("不同盐给出不同排列；me 不再恒占首位", () => {
  const positions: number[] = [];
  for (let i = 0; i < 50; i++) {
    const out = debiasChoiceOrders({ t: targetsQuestion }, "conv-" + i);
    positions.push(keysOf(out.t as never).indexOf("me"));
  }
  // 恒等顺序下 me 恒在 0；均匀乱序下 4 选 1 期望约 25%
  const atZero = positions.filter((p) => p === 0).length;
  assert.ok(atZero < 25, `me 停在首位的盐值过多：${atZero}/50`);
  assert.ok(new Set(positions).size > 1, "50 个盐值排列全部相同");
});

test("同请求内同候选集排列一致（保住 definitions 去重）", () => {
  const out = debiasChoiceOrders(
    { a: targetsQuestion, b: targetsQuestion },
    "conv-x",
  );
  assert.deepEqual(keysOf(out.a as never), keysOf(out.b as never));
});

test("score 题的等级数组与 noul 保持原样", () => {
  const qs: Questions = {
    s: score("等级", ["低", "中", "高"]),
    n: noul("是否"),
    t: targetsQuestion,
  };
  const out = debiasChoiceOrders(qs, "salt");
  assert.equal(out.s, qs.s);
  assert.equal(out.n, qs.n);
});

test("乱序后 c0..cn 仍解码回正确语义键", () => {
  const out = debiasChoiceOrders({ t: targetsQuestion }, "conv-x");
  const order = keysOf(out.t as never);
  const raw = JSON.stringify({
    answers: Object.fromEntries([
      [
        "q0",
        Object.fromEntries(
          order.map((k, i) => ["c" + i, k === "external" ? 90 : 3]),
        ),
      ],
    ]),
  });
  const result = decodeLlm(
    raw,
    { q0: out.t },
    "test-model",
    { input_tokens: 1, output_tokens: 1 },
    true,
  );
  const answer = result.answers.q0 as { choice: string; probabilities: Record<string, number> };
  assert.equal(answer.choice, "external");
  // ε=0.1 平滑后 90/99 峰值 ≈ 0.84（单选塌缩下界保证），仍显著高于其余项
  assert.ok(answer.probabilities.external > 0.8);
  for (const [k, v] of Object.entries(answer.probabilities))
    if (k !== "external") assert.ok(answer.probabilities.external > v * 3, k);
});

test("buildRequest 出题已去偏：键集合不变，跨消息集排列不同", () => {
  const mk = (extra: string[]) =>
    buildRequest({
      revision: 1,
      relation: "crush",
      task: "other_messages",
      targetIds: ["t0"],
      messages: [
        { id: "t0", sender: "other", text: "怎么回事？", timestamp: null, kind: "text" },
        ...extra.map((id) => ({
          id,
          sender: "self" as const,
          text: "补充一句",
          timestamp: null,
          kind: "text" as const,
        })),
      ],
    });
  const orders = [[], ["a"], ["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]].map(
    (extra) => {
      const q = mk(extra).questions["t0_targets"];
      assert.equal(q.type, "choice");
      return keysOf(q);
    },
  );
  const base = Object.keys(TARGETS);
  for (const o of orders) assert.deepEqual([...o].sort(), [...base].sort());
  assert.ok(
    new Set(orders.map((o) => o.join(","))).size > 1,
    "不同消息集的排列应不同",
  );
});
