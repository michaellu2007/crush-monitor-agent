import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWatchRules, WATCH_PARAMS } from "../shared/watch-rules";
import type { LineResult, Message } from "../shared/types";

const HOUR = 3600000;
const BASE = new Date(2026, 9, 20, 12, 0).getTime();
const p2 = (n: number) => String(n).padStart(2, "0");
const fmt = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** 健康会话 + 末尾一条 2 小时前的我方邀约（默认阈值不报，收紧后应报）。 */
function freshInviteConv(): { messages: Message[]; lines: Record<string, LineResult> } {
  const messages: Message[] = [];
  const lines: Record<string, LineResult> = {};
  const count = 44;
  const start = BASE - (count - 1) * 2 * HOUR;
  for (let i = 0; i < count; i++) {
    const sender = i % 2 === 0 ? "self" : "other";
    const id = `m${i}`;
    messages.push({
      id,
      sender,
      text: sender === "other" ? `今天也挺开心的呀 ${i}` : "哈哈是啊",
      timestamp: fmt(start + i * 2 * HOUR),
      kind: "text",
    });
    if (sender === "other")
      lines[id] = {
        id,
        score: { value: null, confidence: 0, status: "insufficient", probabilities: {} },
        intents: { continue: 1 },
        emotions: { calm: 1 },
      };
  }
  messages.push({
    id: "invite",
    sender: "self",
    text: "周末一起去看展吗",
    timestamp: fmt(BASE - 2 * HOUR),
    kind: "text",
  });
  lines["invite"] = {
    id: "invite",
    score: { value: null, confidence: 0, status: "insufficient", probabilities: {} },
    intents: { invite: 1 },
  };
  return { messages, lines };
}

test("阈值覆盖：默认 72h 下 2 小时前的邀约不报", () => {
  const conv = freshInviteConv();
  assert.deepEqual(evaluateWatchRules(conv, BASE).map((a) => a.rule), []);
});

test("阈值覆盖：inviteStaleHours=1 时同一会话报出悬空邀约", () => {
  const conv = freshInviteConv();
  const fired = evaluateWatchRules(conv, BASE, { inviteStaleHours: 1 }).map(
    (a) => a.rule,
  );
  assert.deepEqual(fired, ["invite_dangling"]);
});

test("阈值覆盖：冷却常量完整性（inviteStaleHours 仍为 72 默认值）", () => {
  assert.equal(WATCH_PARAMS.inviteStaleHours, 72);
});
