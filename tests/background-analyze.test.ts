import { test } from "node:test";
import assert from "node:assert/strict";
import { writeConversation, readConversation } from "../server/conv-store";
import { mergeAndWrite } from "../server/background-analyze";
import type { LineResult } from "../shared/types";

/** 最小合法 LineResult——测试只关心 id/event，评分字段给个合法壳。 */
const line = (id: string, event?: LineResult["event"]): LineResult => ({
  id,
  ...(event ? { event } : {}),
  score: { value: null, confidence: 0, status: "insufficient", probabilities: {} },
});

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
    seed(id, { lines: { old: line("old") } });
    assert.equal(mergeAndWrite(id, { fresh: line("fresh") }), true);
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
    mergeAndWrite(id, { lineM1: line("lineM1") }, { affinity: { value: 60 } } as never);
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
    mergeAndWrite(id, { x: line("x") });
    const cur = readConversation(id) as { overview: { stage: string } };
    assert.equal(cur.overview.stage, "old");
  } finally {
    writeConversation(id, null);
  }
});

test("合并写盘：会话已删除时返回 false（不复活文件）", () => {
  assert.equal(mergeAndWrite("zz-does-not-exist-" + Date.now(), { a: line("a") }), false);
});

test("合并写盘：analyzedCount 跟随 lines 数量", () => {
  const id = "zz-bg-count-" + Date.now();
  try {
    seed(id);
    mergeAndWrite(id, { a: line("a"), b: line("b") });
    const cur = readConversation(id) as { analyzedCount: number };
    assert.equal(cur.analyzedCount, 2);
  } finally {
    writeConversation(id, null);
  }
});

test("合并写盘：新 lines 里的事件提取落盘（collectEvents）", () => {
  const id = "zz-bg-events-" + Date.now();
  try {
    seed(id, {
      messages: [
        { id: "m1", sender: "other", text: "周六一起看展吧", timestamp: null, kind: "text" },
      ],
    });
    mergeAndWrite(id, {
      m1: line("m1", { kind: "invitation", confidence: 0.9 }),
    });
    const cur = readConversation(id) as {
      events: Record<string, { kind: string; status: string }>;
    };
    assert.equal(cur.events.m1?.kind, "invitation", "新邀约事件必须落盘");
    assert.equal(cur.events.m1?.status, "active");
  } finally {
    writeConversation(id, null);
  }
});

test("合并写盘：overview 的 memoryUpdates 更新已有事件状态", () => {
  const id = "zz-bg-memupd-" + Date.now();
  try {
    seed(id, {
      events: {
        m1: { id: "m1", kind: "invitation", confidence: 0.9, status: "active" },
      },
    });
    mergeAndWrite(
      id,
      {},
      undefined,
      [{ id: "m1", status: "resolved", evidenceId: "m2" }],
    );
    const cur = readConversation(id) as {
      events: Record<string, { status: string; resolvedBy?: string }>;
    };
    assert.equal(cur.events.m1.status, "resolved", "已兑现的邀约必须标记为 resolved");
    assert.equal(cur.events.m1.resolvedBy, "m2", "证据消息 ID 必须落盘");
  } finally {
    writeConversation(id, null);
  }
});
