import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCheck } from "../shared/live-check";

test("实时体检触发：≥10 字且与上次不同", () => {
  assert.equal(shouldCheck("今天晚上一起去吃个饭怎么样", null), true);
});

test("实时体检触发：短于 10 字不触发", () => {
  assert.equal(shouldCheck("在吗", null), false);
  assert.equal(shouldCheck("去吃饭吧", null), false);
});

test("实时体检触发：与上次已体检内容相同不重复触发", () => {
  const t = "今天晚上一起去吃个饭怎么样";
  assert.equal(shouldCheck(t, t), false);
});

test("实时体检触发：清空/纯空白不触发", () => {
  assert.equal(shouldCheck("", "之前的内容"), false);
  assert.equal(shouldCheck("   \n  ", null), false);
});

test("实时体检触发：上次为 null 时任何合格草稿都触发", () => {
  assert.equal(shouldCheck("今天晚上一起去吃个饭怎么样", null), true);
});
