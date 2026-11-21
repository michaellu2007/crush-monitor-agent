import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript } from "../server/transcript";

const msg = (i: number, text = `第${i}条消息的内容`) => ({
  sender: i % 2 === 0 ? ("other" as const) : ("self" as const),
  text,
  timestamp: `2026年11月2日 ${String(9 + (i % 10)).padStart(2, "0")}:30`,
});

test("转写预算：全部消息在预算内时一条不少", () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(i));
  const t = buildTranscript(messages, 100_000);
  assert.ok(t.includes("第0条"), "最旧的消息保留");
  assert.ok(t.includes("第9条"), "最新的消息保留");
  assert.ok(!t.includes("已省略"));
});

test("转写预算：超预算时从最旧开始省略、保留最近的", () => {
  const messages = Array.from({ length: 200 }, (_, i) => msg(i, `第${i}条，多一些内容让它更重`));
  const t = buildTranscript(messages, 2_000);
  assert.ok(t.includes("已省略"), "应有省略提示");
  assert.ok(!t.includes("第0条"), "最旧的应被省略");
  const tail = t.split("\n").filter((l) => l.includes("：")).at(-1);
  assert.ok(tail?.includes("199"), "最新一条必须在");
  const body = t.slice(t.indexOf("\n") + 1);
  assert.ok(body.length <= 2_100, `预算 ${body.length}`);
});

test("转写备注名：self/other 用传入的备注名", () => {
  const t = buildTranscript(
    [
      { sender: "self", text: "嗨", timestamp: null },
      { sender: "other", text: "哈喽", timestamp: null },
    ],
    1_000,
    { self: "小明", other: "小红" },
  );
  assert.ok(t.includes("小明：嗨"));
  assert.ok(t.includes("小红：哈喽"));
  assert.ok(!t.includes("我：嗨"));
});

test("转写空输入：返回空字符串不抛错", () => {
  assert.equal(buildTranscript([], 1_000), "");
});
