// 顾问上下文压缩策略（2026-11-04）：触发口径 = 轮数 >8 或投影超模型窗口预算 70%
// （窗口按 context-budget.ts 模型自适应）；封顶用 trimDialogToBudget 纯函数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimDialogToBudget, dialogSegmentStart } from "../server/advise";
import { transcriptCharBudget } from "../server/context-budget";

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

test("trimDialogToBudget：未超预算原样返回", () => {
  const d = [turn("user", "a".repeat(100)), turn("assistant", "b".repeat(100))];
  assert.equal(trimDialogToBudget(d, 50, 1000), d);
});

test("trimDialogToBudget：超预算从头部成对丢轮、保末尾，至少留一对", () => {
  const d = Array.from({ length: 10 }, (_, i) =>
    turn(i % 2 === 0 ? "user" : "assistant", `${"x".repeat(500)}#${i}`),
  );
  const out = trimDialogToBudget(d, 0, 3000); // 总 5000 字，预算 3000 → 丢到 ≤3000
  assert.ok(out.length < d.length, "有丢弃");
  assert.ok(out[out.length - 1].content.endsWith("#9"), "末尾保留");
  assert.equal(out.length % 2, 0, "成对保留");
  const size = out.reduce((n, t) => n + t.content.length, 0);
  assert.ok(size <= 3000, "封顶后 ≤ 预算");
});

test("trimDialogToBudget：预算再小也至少保留一对，不返回空", () => {
  const d = [turn("user", "a".repeat(5000)), turn("assistant", "b".repeat(5000))];
  const out = trimDialogToBudget(d, 1000, 2000);
  assert.equal(out.length, 2);
});

test("压缩触发口径：70% 窗口预算随模型窗口自适应（deepseek 1M vs 8b 128k）", () => {
  const deepseek = Math.round(transcriptCharBudget("deepseek-chat") * 0.7);
  const local8b = Math.round(transcriptCharBudget("qwen3-8b") * 0.7);
  assert.ok(deepseek > 500_000, `deepseek 1M 窗口 70% ≈ ${deepseek}`);
  assert.ok(local8b > 20_000 && local8b < 200_000, `8b 128k 窗口 70% ≈ ${local8b}`);
  assert.ok(deepseek > local8b * 2, "同一对话在 8b 上更早触发压缩");
});

const H = 3_600_000;
const tsTurn = (role: "user" | "assistant", content: string, ts: number) => ({
  role,
  content,
  ts,
});

test("dialogSegmentStart：最后一个 >2h 停顿是段边界（压缩点切在边界上）", () => {
  const d = [
    tsTurn("user", "昨天的问题", 0),
    tsTurn("assistant", "昨天的回答", 5 * 60_000),
    tsTurn("user", "今天的新问题", 5 * H), // >2h 边界 → 下标 2
    tsTurn("assistant", "今天的回答", 5 * H + 60_000),
  ];
  assert.equal(dialogSegmentStart(d), 2);
});

test("dialogSegmentStart：取最后一个边界，短停顿不算", () => {
  const d = [
    tsTurn("user", "a", 0),
    tsTurn("assistant", "b", 3 * H), // 第一个边界，下标 1
    tsTurn("user", "c", 3 * H + 30 * 60_000), // 30 分钟，不算
    tsTurn("assistant", "d", 3 * H + 60 * 60_000),
  ];
  assert.equal(dialogSegmentStart(d), 1);
  const d2 = [
    tsTurn("user", "a", 0),
    tsTurn("assistant", "b", 30 * 60_000),
    tsTurn("user", "c", 4 * H), // 只有这里 >2h
    tsTurn("assistant", "d", 4 * H + 60_000),
  ];
  assert.equal(dialogSegmentStart(d2), 2);
});

test("dialogSegmentStart：无 ts 或无边界返回 -1（退回固定 8 轮口径）", () => {
  assert.equal(dialogSegmentStart([turn("user", "a"), turn("assistant", "b")]), -1);
  const d = [
    tsTurn("user", "a", 0),
    tsTurn("assistant", "b", 1.5 * H), // ≤2h 不算边界
  ];
  assert.equal(dialogSegmentStart(d), -1);
});
