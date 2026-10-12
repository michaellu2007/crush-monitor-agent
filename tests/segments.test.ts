import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSegments, parseTs, humanGap } from "../shared/segments";
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

test("buildSegments groups by month and caps chunk size", () => {
  const messages = [
    msg("一", "2023年7月4日 10:00"),
    msg("二", "2023年7月4日 10:01"),
    msg("三", null), // 无时间戳跟随上一条所在月份
    msg("四", "2026年3月23日 18:05"),
    msg("五", "2026年3月23日 18:19"),
  ];
  const segments = buildSegments(messages);
  assert.deepEqual(
    segments.map((s) => s.label),
    ["2023年7月", "2026年3月"],
  );
  assert.equal(segments[0].messages.length, 3);
});

test("buildSegments splits oversized months", () => {
  const messages = Array.from({ length: 250 }, (_, i) =>
    msg("x".repeat(50), "2025年6月1日 10:00"),
  );
  const segments = buildSegments(messages);
  assert.ok(segments.length >= 3);
  assert.ok(segments.every((s) => s.messages.length <= 120));
});
