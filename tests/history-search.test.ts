import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearchDb, type IndexedMessage } from "../server/history-search";

const msg = (
  id: string,
  sender: "self" | "other",
  text: string,
  timestamp: string | null = null,
): IndexedMessage => ({ id, sender, text, timestamp });

function seed(d: ReturnType<typeof createSearchDb>) {
  d.indexConversation("conv-a", "contact-a", [
    msg("a1", "other", "周末一起去看展吗？我找到一个新的艺术展"),
    msg("a2", "self", "好啊，我上周刚好想去"),
    msg("a3", "other", "那家咖啡店也不错，下次一起去"),
  ]);
  d.indexConversation("conv-b", "contact-b", [
    msg("b1", "other", "今天加班到十点，累死了"),
    msg("b2", "self", "辛苦了，早点休息"),
  ]);
  d.setMtime("conv-a", 111);
  d.setMtime("conv-b", 222);
}

test("FTS 检索：≥3 字中文子串命中，只返回该联系人的结果", () => {
  const d = createSearchDb(":memory:");
  seed(d);
  const hits = d.search("看展", "contact-a");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].msgId, "a1");
  assert.equal(hits[0].text.includes("艺术展"), true);
  // 跨联系人：contact-b 里没有"看展"，绝不允许把 a 的结果给 b
  assert.deepEqual(d.search("看展", "contact-b"), []);
  d.close();
});

test("LIKE 回退：2 字查询命中（短词是中文高频形态）", () => {
  const d = createSearchDb(":memory:");
  seed(d);
  const hits = d.search("咖啡", "contact-a");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].msgId, "a3");
  assert.deepEqual(d.search("咖啡", "contact-b"), []);
  d.close();
});

test("隐私硬约束：contactId 缺失/为空永远返回空", () => {
  const d = createSearchDb(":memory:");
  seed(d);
  assert.deepEqual(d.search("看展", ""), []);
  d.close();
});

test("LIKE 特殊字符（%/_）不报错、按字面匹配", () => {
  const d = createSearchDb(":memory:");
  d.indexConversation("c", "p", [msg("m1", "other", "折扣 50% off_限量")]);
  assert.equal(d.search("%", "p").length, 1);
  assert.equal(d.search("50%", "p").length, 1);
  assert.equal(d.search("off_", "p").length, 1);
  assert.equal(d.search("offX", "p").length, 0);
  d.close();
});

test("limit 生效且结果按插入序返回", () => {
  const d = createSearchDb(":memory:");
  const messages = Array.from({ length: 10 }, (_, i) =>
    msg(`m${i}`, "other", `聊到看展的事 ${i}`),
  );
  d.indexConversation("c", "p", messages);
  const hits = d.search("看展", "p", 3);
  assert.equal(hits.length, 3);
  assert.deepEqual(
    hits.map((h) => h.msgId),
    ["m0", "m1", "m2"],
  );
  d.close();
});

test("重建幂等：同会话重索引不产生重复结果", () => {
  const d = createSearchDb(":memory:");
  seed(d);
  const messages = [
    msg("a1", "other", "周末一起去看展吗？我找到一个新的艺术展"),
    msg("a2", "self", "好啊，我上周刚好想去"),
  ];
  d.indexConversation("conv-a", "contact-a", messages);
  assert.equal(d.search("看展", "contact-a").length, 1);
  d.close();
});

test("删除会话：索引行与 meta 一并清除，不再命中（其他会话不受影响）", () => {
  const d = createSearchDb(":memory:");
  seed(d);
  d.deleteConversation("conv-a");
  assert.equal(d.search("看展", "contact-a").length, 0);
  assert.equal(d.lastMtime("conv-a"), undefined);
  assert.equal(d.search("加班", "contact-b").length, 1);
  d.close();
});
