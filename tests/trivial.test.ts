import { test } from "node:test";
import assert from "node:assert/strict";
import { trivialSkipReason } from "../shared/trivial";
import { incrementalJobs } from "../shared/incremental";
import type { Message } from "../shared/types";

const msg = (
  id: string,
  sender: "self" | "other",
  text: string,
  ts: string | null = "2026年09月19日 12:00",
): Message => ({ id, sender, text, timestamp: ts, kind: "text" });

test("纯表情消息被门控", () => {
  for (const t of ["😊", "😂😂😂", "👍🏻", "🤔️"]) {
    assert.match(trivialSkipReason(t)!, /纯表情/, t);
  }
  // 键帽表情剥掉修饰符后剩一个数字，按"单字"跳过——行为一致即可
  assert.ok(trivialSkipReason("1️⃣") !== null, "1️⃣");
});

test("纯标点消息被门控", () => {
  for (const t of ["。。。", "？！", "？", "……", "!!!", "，。"]) {
    assert.match(trivialSkipReason(t)!, /纯表情\/标点/, t);
  }
});

test("单字消息被门控（含带标点的单字）", () => {
  for (const t of ["嗯", "哦", "好", "6", "嗯。", "哦？", "哈"]) {
    assert.match(trivialSkipReason(t)!, /单字/, t);
  }
});

test("多字消息不门控：哈哈/妈的/ok/666 照常送评", () => {
  for (const t of ["哈哈", "哈哈哈", "妈的", "ok", "666", "在吗", "好的呀", "收到"]) {
    assert.equal(trivialSkipReason(t), null, t);
  }
});

test("增量任务不把低信息量消息送评，正常消息不受影响", () => {
  const messages = [
    msg("a", "other", "今天下午一起去看展吗"),
    msg("b", "other", "😊"),
    msg("c", "self", "好啊，几点碰头"),
    msg("d", "other", "嗯"),
    msg("e", "other", "三点在地铁口等我"),
  ];
  const jobs = incrementalJobs(messages, "crush", 1, {}, {}, true);
  const targeted = new Set(jobs.flatMap((j) => j.targetIds));
  assert.ok(targeted.has("a"));
  assert.ok(targeted.has("c"));
  assert.ok(targeted.has("e"));
  assert.equal(targeted.has("b"), false);
  assert.equal(targeted.has("d"), false);
});
