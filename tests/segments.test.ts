import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnalysisUnits, buildTopics, parseTs, humanGap } from "../shared/segments";
import type { LineResult, Message } from "../shared/types";

let n = 0;
const msg = (text: string, timestamp: string | null): Message => ({
  id: "m" + ++n,
  sender: n % 2 ? "self" : "other",
  text,
  timestamp,
  kind: "text",
});

test("parseTs accepts the formats the parser emits", () => {
  assert.equal(parseTs("2026年10月11日 21:53"), new Date(2026, 9, 11, 21, 53).getTime());
  assert.equal(parseTs("2026/10/11 21:53"), new Date(2026, 9, 11, 21, 53).getTime());
  assert.equal(parseTs("[2026/10/11, 09:02]"), new Date(2026, 9, 11, 9, 2).getTime());
  assert.equal(parseTs("21:53"), null);
  assert.equal(parseTs(null), null);
});

test("humanGap buckets coarse intervals", () => {
  assert.equal(humanGap(5 * 60000), "5分钟");
  assert.equal(humanGap(3 * 3600000), "3小时");
  assert.equal(humanGap(2 * 86400000), "2天");
  assert.equal(humanGap(90 * 86400000), "3个月");
});

test("buildAnalysisUnits: 稀疏期跨大停顿合并（两个月 10 条 = 一个单元）", () => {
  const messages: Message[] = [
    ...Array.from({ length: 5 }, (_, i) => msg("七月" + i, "2026年7月1日 12:00")),
    ...Array.from({ length: 5 }, (_, i) => msg("八月" + i, "2026年8月11日 12:00")),
  ];
  const units = buildAnalysisUnits(messages);
  assert.equal(units.length, 1);
  assert.equal(units[0].messages.length, messages.length);
});

test("buildAnalysisUnits: 密集期按容量切分", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 250; i++)
    messages.push(msg("x".repeat(50), "2026年10月11日 10:00"));
  const units = buildAnalysisUnits(messages);
  assert.ok(units.length >= 2);
  for (const u of units) assert.ok(u.messages.length <= 120);
});

test("buildAnalysisUnits: 无时间戳消息不切分", () => {
  const units = buildAnalysisUnits(
    Array.from({ length: 50 }, (_, i) => msg("hi", null)),
  );
  assert.equal(units.length, 1);
});

const rate = (id: string, extra: Partial<LineResult> = {}): LineResult => ({
  id,
  score: { value: 70, confidence: 0.8, status: "clear", probabilities: {} },
  ...extra,
});

test("buildTopics: 停顿阈值自适应——密集期 30 分钟停顿不切，2 小时切", () => {
  const ts = (h: number, min: number) =>
    `2026年10月11日 ${h}:${String(min).padStart(2, "0")}`;
  const messages: Message[] = Array.from({ length: 20 }, (_, i) =>
    msg("日常" + i, ts(10, i)),
  );
  messages.push(msg("稍后聊", ts(10, 49))); // 距上条 30 分钟，低于自适应阈值 → 同块
  messages.push(msg("新话题", ts(12, 49))); // 距上条 2 小时 ≥ 阈值 → 切
  const units = buildTopics(messages);
  assert.equal(units.length, 2);
  assert.equal(units[1].messages.length, 1);
  assert.equal(units[1].messages[0].text, "新话题");
});

test("buildTopics: self 的发起信号细分板块", () => {
  const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
    id: "t" + i,
    sender: i % 2 ? "self" : "other",
    text: "聊" + i,
    timestamp: `2026年10月11日 10:0${i}`,
    kind: "text",
  }));
  const units = buildTopics(messages, { t3: rate("t3", { mode: "initiate" }) });
  assert.equal(units.length, 2);
  assert.equal(units[0].messages.length, 3);
  assert.equal(units[1].messages[0].id, "t3");
});

test("buildTopics: other 的转移话题意图细分板块；碎块向前合并、弱信号不切", () => {
  const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
    id: "t" + i,
    sender: i % 2 ? "other" : "self",
    text: "聊" + i,
    timestamp: `2026年10月11日 10:0${i}`,
    kind: "text",
  }));
  // t1 是 other 的第 2 条：边界信号落在 1 条碎块上 → 向前合并不切
  let units = buildTopics(messages, {
    t1: rate("t1", { intents: { change: 0.6 } }),
  });
  assert.equal(units.length, 1);
  // t3 达到阈值且前面已有 3 条 → 切
  units = buildTopics(messages, {
    t3: rate("t3", { intents: { change: 0.6 } }),
  });
  assert.equal(units.length, 2);
  assert.equal(units[1].messages[0].id, "t3");
  // 低于 0.5 阈值的 change 不切
  units = buildTopics(messages, {
    t3: rate("t3", { intents: { change: 0.4 } }),
  });
  assert.equal(units.length, 1);
});

test("buildTopics: 容量上限照常生效", () => {
  const units = buildTopics(
    Array.from({ length: 250 }, (_, i) => msg("x".repeat(50), "2026年10月11日 10:00")),
  );
  for (const u of units) assert.ok(u.messages.length <= 120);
});
