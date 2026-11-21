import { test } from "node:test";
import assert from "node:assert/strict";
import { writeConversation, readConversation } from "../server/conv-store";

/** 后台分析的合并写盘语义：重读→合并→写回，必须保住并发改动。 */
function mergeAndWrite(
  convId: string,
  addedLines: Record<string, unknown>,
  overview?: unknown,
) {
  const cur = readConversation(convId) as Record<string, unknown> | undefined;
  if (!cur || cur.schema !== 1) return false;
  const lines = { ...((cur.lines as object) ?? {}), ...addedLines };
  writeConversation(convId, {
    ...cur,
    lines,
    ...(overview ? { overview } : {}),
    analyzedCount: Object.keys(lines).length,
  });
  return true;
}

const seed = (id: string, extra: Record<string, unknown> = {}) =>
  writeConversation(id, {
    schema: 1,
    other: "测试联系人",
    messages: [{ id: "m1", sender: "other", text: "你好", timestamp: null, kind: "text" }],
    lines: {},
    events: {},
    revision: 1,
    ...extra,
  });

test("合并写盘：新增 lines 追加而不覆盖已有", () => {
  const id = "zz-bg-merge-" + Date.now();
  try {
    seed(id, { lines: { old: { id: "old" } } });
    assert.equal(mergeAndWrite(id, { fresh: { id: "fresh" } }), true);
    const cur = readConversation(id) as { lines: Record<string, unknown> };
    assert.deepEqual(Object.keys(cur.lines).sort(), ["fresh", "old"]);
  } finally {
    writeConversation(id, null);
  }
});

test("合并写盘：分析期间同步写入的新消息不丢（重读合并语义）", () => {
  const id = "zz-bg-sync-" + Date.now();
  try {
    seed(id);
    // 模拟"同步 bat 在分析进行中写了新消息"
    const mid = readConversation(id) as Record<string, unknown> & {
      messages: unknown[];
    };
    mid.messages.push({ id: "m2", sender: "other", text: "新消息", timestamp: null, kind: "text" });
    writeConversation(id, mid);
    // 后台分析返回后写盘
    mergeAndWrite(id, { lineM1: { id: "lineM1" } }, { affinity: { value: 60 } });
    const cur = readConversation(id) as { messages: unknown[]; overview: unknown };
    assert.equal(cur.messages.length, 2, "同步写入的新消息必须保留");
    assert.ok(cur.overview, "overview 已写入");
  } finally {
    writeConversation(id, null);
  }
});

test("合并写盘：overview 可选（不传就不覆盖旧值）", () => {
  const id = "zz-bg-ov-" + Date.now();
  try {
    seed(id, { overview: { stage: "old" } });
    mergeAndWrite(id, { x: { id: "x" } });
    const cur = readConversation(id) as { overview: { stage: string } };
    assert.equal(cur.overview.stage, "old");
  } finally {
    writeConversation(id, null);
  }
});

test("合并写盘：会话已删除时返回 false（不复活文件）", () => {
  assert.equal(mergeAndWrite("zz-does-not-exist-" + Date.now(), { a: 1 }), false);
});

test("合并写盘：analyzedCount 跟随 lines 数量", () => {
  const id = "zz-bg-count-" + Date.now();
  try {
    seed(id);
    mergeAndWrite(id, { a: { id: "a" }, b: { id: "b" } });
    const cur = readConversation(id) as { analyzedCount: number };
    assert.equal(cur.analyzedCount, 2);
  } finally {
    writeConversation(id, null);
  }
});
