import { test } from "node:test";
import assert from "node:assert/strict";
import { chatWillingness, messageWillingness } from "../shared/willingness";
import type { LineResult, Message } from "../shared/types";

const line = (over: Partial<LineResult>): LineResult => ({
  id: "m",
  score: { value: null, confidence: 0, status: "ambiguous", probabilities: {} },
  ...over,
});

test("延续性意图意愿高，收尾/边界意图意愿低", () => {
  const ask = messageWillingness(line({ intents: { ask: 1 } }), null);
  const close = messageWillingness(line({ intents: { close: 1 } }), null);
  const boundary = messageWillingness(line({ intents: { boundary: 1 } }), null);
  assert.ok(ask! > 0.9, `ask=${ask}`);
  assert.ok(close! < 0.2, `close=${close}`);
  assert.ok(boundary! < 0.05, `boundary=${boundary}`);
});

test("同样是不耐烦：指向外部事件几乎不扣意愿，指向我重扣", () => {
  const intents = { vent: 0.6, continue: 0.4 };
  const emotions = { annoyed: 1 };
  const external = messageWillingness(
    line({ intents, emotions, targets: { me: 0, external: 1, other_self: 0, general: 0 } }),
    null,
  );
  const atMe = messageWillingness(
    line({ intents, emotions, targets: { me: 1, external: 0, other_self: 0, general: 0 } }),
    null,
  );
  const neutral = messageWillingness(line({ intents, emotions: {} }), null);
  assert.ok(neutral !== null);
  // 冲外部：扣 <= 0.1×1×1 的量级
  assert.ok(neutral - external! <= 0.11, `external drop=${neutral! - external!}`);
  // 冲我：重扣 0.45 量级
  assert.ok(neutral - atMe! >= 0.4, `me drop=${neutral! - atMe!}`);
});

test("回复间隔越长扣越多，缺意图分布返回 null", () => {
  const intents = { continue: 1 };
  const fast = messageWillingness(line({ intents }), 60000);
  const slow = messageWillingness(line({ intents }), 48 * 3600000 + 1000);
  assert.ok(fast! > slow!);
  assert.ok(slow! < 0.85, `slow=${slow}`);
  assert.equal(messageWillingness(undefined, null), null);
  assert.equal(messageWillingness(line({}), null), null);
});

const hour = 3600000;
test("间隔惩罚按人校准：慢节奏者 48h 只是略超常态，快节奏者全额扣", () => {
  const intents = { continue: 1 };
  const abs = messageWillingness(line({ intents }), 48 * hour);
  const slow = messageWillingness(line({ intents }), 48 * hour, 40 * hour);
  const withinNorm = messageWillingness(line({ intents }), 48 * hour, 72 * hour);
  const fast = messageWillingness(line({ intents }), 48 * hour, 5 * 60000);
  // 无基线时保持原绝对路径（0.85 − 0.2）
  assert.ok(Math.abs(abs! - 0.65) < 1e-9, `abs=${abs}`);
  // 慢节奏者：48h 刚超 40h 常态，只扣 0.2×(1−40/48)
  assert.ok(slow! > 0.8, `slow=${slow}`);
  // 48h 在其个人常态（72h）之内：完全不扣
  assert.equal(withinNorm, 0.85);
  // 快节奏者：48h 远超 5 分钟常态，接近全额
  assert.ok(Math.abs(fast! - 0.65) < 0.01, `fast=${fast}`);
});

const stamp = (hours: number): string => {
  const d = new Date(Date.UTC(2026, 9, 1, 0, 0) + Math.round(hours * 60) * 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
/** 交替对话：对方每次回复间隔依次为 gaps[0..n-1]（小时），我方 1 小时后跟进。 */
const conv = (gaps: number[]): Message[] => {
  const messages: Message[] = [msg("s0", "self", stamp(0))];
  let cur = 0;
  gaps.forEach((g, i) => {
    cur += g;
    messages.push(msg("o" + (i + 1), "other", stamp(cur)));
    cur += 1;
    messages.push(msg("s" + (i + 1), "self", stamp(cur)));
  });
  return messages;
};
const continueLines = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      "o" + (i + 1),
      line({ intents: { continue: 1 } }),
    ]),
  );

test("会话级：基线接管——超出个人常态越远，意愿扣得越多", () => {
  // 8 次 40h 常态后，一次 48h（刚超常态）vs 96h（远超常态）
  const mild = chatWillingness(conv([40, 40, 40, 40, 40, 40, 40, 48]), continueLines(8));
  const harsh = chatWillingness(conv([40, 40, 40, 40, 40, 40, 40, 96]), continueLines(8));
  assert.ok(harsh.value! < mild.value!, `mild=${mild.value} harsh=${harsh.value}`);
  assert.equal(mild.level, "engaged");
  assert.ok(mild.value! > 60, `mild=${mild.value}`);
});

const msg = (
  id: string,
  sender: "self" | "other",
  timestamp: string | null,
): Message => ({ id, sender, text: id, timestamp, kind: "text" });

test("会话级：低意愿连击与外部指向安慰提示", () => {
  const messages = [
    msg("s0", "self", "2026-10-12 10:00"),
    msg("o1", "other", "2026-10-12 10:01"),
    msg("s2", "self", "2026-10-12 10:02"),
    msg("o3", "other", "2026-10-12 10:03"),
  ];
  const cooling = chatWillingness(messages, {
    o1: line({ intents: { close: 1 } }),
    o3: line({ intents: { close: 1 } }),
  });
  assert.equal(cooling.lowStreak, 2);
  assert.ok(cooling.value! < 35, `value=${cooling.value}`);
  assert.equal(cooling.level, "cooling");

  const comfort = chatWillingness(messages, {
    o1: line({ intents: { share: 1 } }),
    o3: line({
      intents: { vent: 1 },
      emotions: { annoyed: 0.6, calm: 0.4 },
      targets: { me: 0, external: 0.9, other_self: 0, general: 0.1 },
    }),
  });
  assert.equal(comfort.comfortHint, true);
  assert.ok(comfort.value! >= 35, `comfort value=${comfort.value}`);

  const none = chatWillingness(messages, {});
  assert.equal(none.value, null);
  assert.equal(none.level, null);
});
