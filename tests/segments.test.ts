import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnalysisUnits, parseTs, humanGap } from "../shared/segments";
import type { Message } from "../shared/types";

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
