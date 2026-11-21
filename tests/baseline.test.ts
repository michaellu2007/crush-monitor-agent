import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBaseline, describeBaseline } from "../shared/baseline";
import { buildRequest } from "../server/analysis";
import type { Message, UserProfile } from "../shared/types";

const DAY = 86_400_000;
// 会话锚点取最后一条消息时间：用固定基准日，测试不随墙钟漂移
const T0 = new Date(2026, 8, 1, 12, 0).getTime();
const ts = (offsetMs: number) => {
  const d = new Date(T0 + offsetMs);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const msg = (
  id: string,
  sender: "self" | "other",
  text: string,
  offsetMs = 0,
): Message => ({ id, sender, text, timestamp: ts(offsetMs), kind: "text" });

test("样本不足（<20 条对方文本）不产出基线", () => {
  const ms = Array.from({ length: 19 }, (_, i) =>
    msg(`o${i}`, "other", "今天路过那家店，人还是那么多", i * DAY),
  );
  assert.equal(computeBaseline(ms), null);
});

test("90 天窗口优先，窗口内 <30 条回退全部历史", () => {
  // 25 条在最近 30 天 + 25 条在一年前：窗口内不足 30 → 回退全部（共 50 条）
  const ms = [
    ...Array.from({ length: 25 }, (_, i) =>
      msg(`old${i}`, "other", "去年这时候还在上课来着", -(300 + i) * DAY),
    ),
    ...Array.from({ length: 25 }, (_, i) =>
      msg(`new${i}`, "other", "最近在忙一个新项目", -i * DAY),
    ),
  ];
  const b = computeBaseline(ms);
  assert.ok(b);
  assert.equal(b.window, "全部历史");
  assert.equal(b.sample, 50);

  // 35 条都在最近 30 天 → 开窗
  const ms2 = Array.from({ length: 35 }, (_, i) =>
    msg(`n${i}`, "other", "最近在忙一个新项目", -i * DAY),
  );
  const b2 = computeBaseline(ms2);
  assert.ok(b2);
  assert.equal(b2.window, "近90天");
  assert.equal(b2.sample, 35);
});

test("短回复占比按剥掉表情标点后的可见字数（≤4）计", () => {
  const texts = [
    "嗯嗯", // 2 短
    "哈哈哈哈", // 4 短
    "好的。", // 2 短（标点不算）
    "😊😊", // 0 可见 → 短（纯表情本身会被门控，但统计口径一致）
    "今天路过那家店，人还是那么多", // 长
    "明天下午三点在老地方见", // 长
  ];
  const ms = texts.flatMap((t, i) => [msg(`s${i}`, "self", "前文", i * DAY), msg(`o${i}`, "other", t, i * DAY)]);
  // 凑足样本量：其余都是长消息
  for (let i = texts.length; i < 20; i++)
    ms.push(msg(`s${i}`, "self", "前文", i * DAY), msg(`o${i}`, "other", "这是一条普通长度的消息内容", i * DAY));
  const b = computeBaseline(ms)!;
  assert.equal(b.sample, 20);
  assert.equal(b.shortReplyRate, 0.2); // 4/20
});

test("回复间隔中位数：只计 ≥1 分钟的间隔，按全序列上一条计算", () => {
  const ms: Message[] = [];
  // 20 组对话：self 发 → other 隔 10 分钟回；其中第 0 组 other 隔 30 分钟
  for (let i = 0; i < 20; i++) {
    ms.push(msg(`s${i}`, "self", "在忙吗", i * DAY));
    ms.push(msg(`o${i}`, "other", "刚看到，在弄东西", i * DAY + (i === 0 ? 30 : 10) * 60_000));
  }
  const b = computeBaseline(ms)!;
  assert.equal(b.medianGapMin, 10);
});

test("主动开聊率：≥12h 开新会话，会话数不足为 null", () => {
  const ms: Message[] = [];
  // 5 个会话：前 4 个 self 开，第 5 个 other 开；每会话 5 条对方消息（共 25 ≥ 最小样本）
  for (let i = 0; i < 5; i++) {
    const start = i * 2 * DAY;
    ms.push(
      msg(`s${i}`, i === 4 ? "other" : "self", "开个话头", start),
    );
    for (let j = 0; j < 5; j++)
      ms.push(
        msg(
          `o${i}_${j}`,
          "other",
          "这是一条普通长度的消息",
          start + (j + 1) * 60_000 * 30,
        ),
      );
  }
  const b = computeBaseline(ms)!;
  assert.equal(b.initiationRate, 0.2);

  // 只有 4 个会话（<5）→ 主动率为 null；对方消息 20 条仍达标
  const few: Message[] = [];
  for (let i = 0; i < 4; i++) {
    const start = i * 2 * DAY;
    few.push(msg(`f${i}`, "self", "开个话头", start));
    for (let j = 0; j < 5; j++)
      few.push(
        msg(
          `fo${i}_${j}`,
          "other",
          "这是一条普通长度的消息",
          start + (j + 1) * 60_000 * 30,
        ),
      );
  }
  const b2 = computeBaseline(few)!;
  assert.equal(b2.initiationRate, null);
});

test("全程无时间戳：时间项为 null，仍产出静态统计", () => {
  const ms = Array.from({ length: 25 }, (_, i) => ({
    id: `o${i}`,
    sender: "other" as const,
    text: i % 2 ? "嗯嗯" : "这是一条普通长度的消息内容",
    timestamp: null,
    kind: "text" as const,
  }));
  const b = computeBaseline(ms)!;
  assert.equal(b.window, "全部历史");
  assert.equal(b.medianGapMin, null);
  assert.equal(b.initiationRate, null);
  assert.equal(b.shortReplyRate, 0.48); // 12/25（i 为奇数的 12 条是"嗯嗯"）
});

test("describeBaseline 输出包含关键数字", () => {
  const b = computeBaseline(
    Array.from({ length: 20 }, (_, i) => msg(`o${i}`, "other", "嗯嗯", i * DAY)),
  )!;
  assert.match(describeBaseline(b), /短回复 100%/);
  assert.match(describeBaseline(b), /样本 20 条/);
});

const baseInput = (target: Message, profile?: UserProfile) => ({
  task: "other_messages" as const,
  targetIds: [target.id],
  revision: 1,
  relation: "crush" as const,
  ...(profile ? { userProfile: profile } : {}),
  messages: [
    msg("s1", "self", "那个展你去了吗", 0),
    target,
    msg("s2", "self", "好吧，那先这样", 60_000 * 30),
  ],
});

const profileWithBaseline: UserProfile = {
  baseline: {
    window: "近90天",
    sample: 120,
    shortReplyRate: 0.62,
    medianLen: 6,
    medianGapMin: 240,
    emojiRate: 0.3,
    initiationRate: 0.4,
  },
};

test("buildRequest：短消息 + 基线 → 情绪/意图题带基线校准句，常态分支", () => {
  const target = msg("t1", "other", "嗯嗯", 60_000 * 10);
  const { questions } = buildRequest(baseInput(target, profileWithBaseline));
  const q = questions["t1_emotions"] as { instructions: string };
  assert.match(q.instructions, /短回复占 62%/);
  assert.match(q.instructions, /对方常态/);
  const qi = questions["t1_intents"] as { instructions: string };
  assert.match(qi.instructions, /短回复占 62%/);
});

test("buildRequest：低占比基线 → 偏离习惯分支", () => {
  const target = msg("t1", "other", "嗯嗯", 60_000 * 10);
  const { questions } = buildRequest(
    baseInput(target, {
      baseline: { ...profileWithBaseline.baseline!, shortReplyRate: 0.12 },
    }),
  );
  const q = questions["t1_emotions"] as { instructions: string };
  assert.match(q.instructions, /偏离其习惯/);
});

test("buildRequest：正常长度消息不注入基线句；无画像时题目与原先一致", () => {
  const target = msg("t1", "other", "那天玩的那个地方还挺不错的", 60_000 * 10);
  const withProfile = buildRequest(baseInput(target, profileWithBaseline));
  const q = withProfile.questions["t1_emotions"] as { instructions: string };
  assert.ok(!q.instructions.includes("基线"));

  const noProfile = buildRequest(baseInput(target));
  const q2 = noProfile.questions["t1_emotions"] as { instructions: string };
  assert.ok(!q2.instructions.includes("基线"));
  assert.ok(!("userProfile" in (noProfile as ReturnType<typeof buildRequest>)));
});

test("buildRequest：state 带守卫句 baselineNote，无基线时不带", () => {
  const target = msg("t1", "other", "嗯嗯", 60_000 * 10);
  const withProfile = buildRequest(baseInput(target, profileWithBaseline));
  const state = withProfile.state as Record<string, unknown>;
  const up = state.userProfile as Record<string, unknown>;
  assert.match(String(up.baselineNote), /客观事实/);

  const noProfile = buildRequest(baseInput(target));
  assert.equal((noProfile.state as Record<string, unknown>).userProfile, undefined);
});
