import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWatchRules, WATCH_PARAMS } from "../shared/watch-rules";
import { filterCooldown } from "../server/watch";
import { parseTs } from "../shared/segments";
import type { LineResult, Message } from "../shared/types";

// 时间全部本地时区构造，与 parseTs 同口径；now 显式注入，不依赖真实时钟。
const HOUR = 3600000;
const DAY = 24 * HOUR;
const BASE = new Date(2026, 9, 20, 12, 0).getTime();
const p2 = (n: number) => String(n).padStart(2, "0");
const fmt = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p2(
    d.getHours(),
  )}:${p2(d.getMinutes())}`;
};

const lineOf = (p: {
  emotions?: Record<string, number>;
  targets?: Record<string, number>;
  intents?: Record<string, number>;
}): LineResult => ({
  id: "x",
  score: { value: null, confidence: 0, status: "insufficient", probabilities: {} },
  ...(p.emotions ? { emotions: p.emotions } : {}),
  ...(p.targets ? { targets: p.targets } : {}),
  ...(p.intents ? { intents: p.intents } : {}),
});

type Conv = { messages: Message[]; lines: Record<string, LineResult> };

/** 健康会话：互相接球、情绪平稳、无长间隔（任何规则都不该响）。 */
function baseConv(endMs = BASE - 2 * HOUR): Conv {
  const messages: Message[] = [];
  const lines: Record<string, LineResult> = {};
  const count = 44;
  const start = endMs - (count - 1) * 2 * HOUR;
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
      lines[id] = lineOf({ intents: { continue: 1 }, emotions: { calm: 1 } });
  }
  return { messages, lines };
}

/** 冷淡会话：只有前 2 条对方消息愿意聊，其余 20 条全是收尾。 */
function coolingConv(): Conv {
  const conv = baseConv();
  let n = 0;
  for (const m of conv.messages) {
    if (m.sender !== "other") continue;
    conv.lines[m.id] = lineOf(
      n < 2
        ? { intents: { continue: 1 }, emotions: { calm: 1 } }
        : { intents: { close: 1 }, emotions: { calm: 1 } },
    );
    n++;
  }
  return conv;
}

/** 水位趋势回落：前 25 天持续开心，最后 5 天每天 8 条指向自己的难过（情绪低谷）。 */
function downtrendConv(): Conv {
  const messages: Message[] = [];
  const lines: Record<string, LineResult> = {};
  let i = 0;
  const push = (
    sender: "self" | "other",
    at: number,
    text: string,
    p?: { emotions?: Record<string, number>; targets?: Record<string, number>; intents?: Record<string, number> },
  ) => {
    const id = `d${i++}`;
    messages.push({ id, sender, text, timestamp: fmt(at), kind: "text" });
    if (sender === "other" && p) lines[id] = lineOf({ intents: { answer: 1 }, ...p });
  };
  for (let day = 30; day >= 5; day--) {
    for (let k = 0; k < 3; k++) {
      const at = BASE - day * DAY + k * HOUR;
      push("other", at, `和你聊天真开心 ${day}-${k}`, {
        emotions: { happy: 1 },
        intents: { continue: 1 },
      });
      push("self", at + HOUR / 2, "我也是哈哈");
    }
  }
  for (let day = 4; day >= 0; day--) {
    for (let k = 0; k < 8; k++) {
      const at = BASE - day * DAY + k * HOUR;
      push("other", at, "最近好累，感觉撑不住了", {
        emotions: { sad: 1 },
        targets: { other_self: 1 },
        intents: { answer: 1 },
      });
      push("self", at + HOUR / 2, "抱抱，别太勉强");
    }
  }
  return { messages, lines };
}

/** 邀约悬空：健康聊天 + 最后一条是我方邀约，73 小时前发出。 */
function inviteConv(text = "周末一起去看展吗", withIntents = true): Conv {
  const conv = baseConv(BASE - 74 * HOUR);
  const id = "invite";
  conv.messages.push({
    id,
    sender: "self",
    text,
    timestamp: fmt(BASE - 73 * HOUR),
    kind: "text",
  });
  if (withIntents) conv.lines[id] = lineOf({ intents: { invite: 1 } });
  return conv;
}

/** 主动骤降：两个 7-14 天前的会话簇都由对方发起，近 7 天唯一会话簇由我方发起。 */
function initiationDropConv(): Conv {
  const messages: Message[] = [];
  const lines: Record<string, LineResult> = {};
  let i = 0;
  const cluster = (startMs: number, first: "self" | "other") => {
    for (let k = 0; k < 20; k++) {
      const sender = k % 2 === 0 ? first : first === "self" ? "other" : "self";
      const id = `c${i++}`;
      messages.push({
        id,
        sender,
        text: sender === "other" ? `我又来找你啦 ${k}` : "嘿嘿",
        timestamp: fmt(startMs + k * HOUR),
        kind: "text",
      });
      if (sender === "other")
        lines[id] = lineOf({ intents: { continue: 1 }, emotions: { calm: 1 } });
    }
  };
  cluster(BASE - 13 * DAY, "other");
  cluster(BASE - 9 * DAY + HOUR, "other");
  cluster(BASE - 2 * DAY, "self");
  return { messages, lines };
}

const rules = (conv: Conv, now = BASE) =>
  evaluateWatchRules(conv, now).map((a) => a.rule);

test("预警门槛：没有逐条分析（lines 空）不预警", () => {
  const conv = inviteConv();
  assert.deepEqual(rules({ messages: conv.messages, lines: {} }), []);
});

test("预警门槛：对方文本不足 20 条不预警", () => {
  const conv = baseConv();
  assert.deepEqual(
    rules({ messages: conv.messages.slice(0, 20), lines: conv.lines }),
    [],
  );
});

test("健康会话：四条规则都不触发", () => {
  assert.deepEqual(rules(baseConv()), []);
});

test("R1 连续冷淡：低意愿连击 + 会话偏冷淡时触发", () => {
  const fired = rules(coolingConv());
  assert.deepEqual(fired, ["cooling_streak"]);
});

test("R1 不触发：低意愿连击不足 3 条", () => {
  const conv = baseConv();
  const others = conv.messages.filter((m) => m.sender === "other");
  conv.lines[others.at(-1)!.id] = lineOf({ intents: { close: 1 } });
  conv.lines[others.at(-2)!.id] = lineOf({ intents: { close: 1 } });
  assert.ok(!rules(conv).includes("cooling_streak"));
});

test("R2 触发：7 日均线下穿 30 日均线且近 7 天大跌", () => {
  const fired = rules(downtrendConv());
  assert.deepEqual(fired, ["valence_downtrend"]);
});

test("R2 不触发：只有小幅回落（正常振荡）", () => {
  const conv = baseConv(BASE - 3 * DAY);
  const angryAt = BASE - 2 * HOUR;
  conv.messages.push({
    id: "a1",
    sender: "other",
    text: "行吧",
    timestamp: fmt(angryAt),
    kind: "text",
  });
  conv.lines["a1"] = lineOf({
    emotions: { angry: 1 },
    targets: { me: 1 },
    intents: { answer: 1 },
  });
  assert.ok(!rules(conv).includes("valence_downtrend"));
});

test("R3 触发：邀约悬空 73 小时", () => {
  const fired = evaluateWatchRules(inviteConv(), BASE);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].rule, "invite_dangling");
  assert.equal(fired[0].title, "邀约还没有回应");
  assert.match(fired[0].detail, /73 小时/);
});

test("R3 回退：旧会话无意图分布时只认问号结尾（判为提问）", () => {
  const fired = evaluateWatchRules(inviteConv("在忙吗？", false), BASE);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].title, "提问还没有回应");
});

test("R3 回退：旧会话无问号结尾的普通消息不触发", () => {
  const fired = evaluateWatchRules(inviteConv("哈哈哈好吧", false), BASE);
  assert.deepEqual(fired, []);
});

test("R3 边界：不满 72 小时不触发", () => {
  const conv = inviteConv();
  const inviteTs = parseTs(conv.messages.at(-1)!.timestamp)!;
  assert.deepEqual(rules(conv, inviteTs + 71 * HOUR), []);
});

test("R3 不触发：最后一条是对方消息", () => {
  assert.ok(!rules(baseConv()).includes("invite_dangling"));
});

test("R4 触发：对方主动开聊从前 7 天 2 次掉到近 7 天 0 次", () => {
  const fired = evaluateWatchRules(initiationDropConv(), BASE);
  assert.deepEqual(
    fired.map((a) => a.rule),
    ["initiation_drop"],
  );
  assert.match(fired[0].detail, /近 7 天 0 次/);
});

test("R4 不触发：近 7 天仍有对方主动（未腰斩）", () => {
  const conv = initiationDropConv();
  // 在最后一个簇结束 12 小时后，追加一个由对方发起的近期簇 → recent=1，不满足 <2×0.5
  const messages = conv.messages;
  const lines = conv.lines;
  const start = BASE - 2 * DAY + 20 * HOUR + 12 * HOUR;
  for (let k = 0; k < 10; k++) {
    const sender = k % 2 === 0 ? "other" : "self";
    const id = `x${k}`;
    messages.push({
      id,
      sender,
      text: sender === "other" ? "在吗" : "在",
      timestamp: fmt(start + k * HOUR),
      kind: "text",
    });
    if (sender === "other")
      lines[id] = lineOf({ intents: { continue: 1 }, emotions: { calm: 1 } });
  }
  assert.ok(!rules(conv).includes("initiation_drop"));
});

test("冷却：同会话同规则 24 小时内不重复，跨规则/超时不受限", () => {
  const alerts = [
    { rule: "cooling_streak" as const, title: "t", detail: "d" },
    { rule: "valence_downtrend" as const, title: "t", detail: "d" },
  ];
  const recent = { "c1:cooling_streak": BASE - 1 * HOUR };
  assert.deepEqual(filterCooldown("c1", alerts, recent, BASE), [
    alerts[1],
  ]);
  const stale = { "c1:cooling_streak": BASE - 25 * HOUR };
  assert.deepEqual(filterCooldown("c1", alerts, stale, BASE), alerts);
  // 跨会话互不影响
  assert.deepEqual(filterCooldown("c2", alerts, recent, BASE), alerts);
  assert.equal(
    WATCH_PARAMS.inviteStaleHours,
    72,
    "悬空门槛常量被误改时给出提示",
  );
});
