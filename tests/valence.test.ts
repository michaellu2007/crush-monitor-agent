import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateValence,
  summarizeValence,
  VALENCE_PARAMS,
} from "../shared/valence";
import { parseTs } from "../shared/segments";
import type { LineResult, Message } from "../shared/types";

const DAY = 86400000;
const T0 = "2026年09月19日 12:00";

const msg = (
  id: string,
  sender: "self" | "other",
  text: string,
  timestamp: string | null,
): Message => ({ id, sender, text, timestamp, kind: "text" });

const line = (p: {
  emotions?: Record<string, number>;
  targets?: Record<string, number>;
}): LineResult => ({
  id: "x",
  score: { value: null, confidence: 0, status: "insufficient", probabilities: {} },
  ...(p.emotions ? { emotions: p.emotions } : {}),
  ...(p.targets ? { targets: p.targets } : {}),
});

test("聚合层：空输入停在基线 50", () => {
  const r = aggregateValence([], {});
  assert.equal(r.level, 50);
  assert.deepEqual(r.points, []);
  assert.deepEqual(r.negatives, []);
});

test("聚合层：没有 emotions 的行不参与，水位不动", () => {
  const messages = [msg("a", "other", "今天好累", T0)];
  const r = aggregateValence(messages, { a: line({}) });
  assert.equal(r.level, 50);
  assert.equal(r.points.length, 0);
});

test("聚合层：开心消息抬升水位，指向我的愤怒压低水位", () => {
  const messages = [
    msg("a", "other", "哈哈哈太好玩了", T0),
    msg("b", "other", "你烦不烦", T0),
  ];
  const r = aggregateValence(messages, {
    a: line({ emotions: { happy: 1 } }),
    b: line({ emotions: { angry: 1 }, targets: { me: 1 } }),
  });
  assert.equal(r.points.length, 2);
  // happy 0.9^0.88 ≈ +0.91；angry@me 钳制在 -1
  assert.ok(Math.abs(r.points[0].influence - 0.91) < 0.02);
  assert.equal(r.points[1].influence, -1);
  assert.ok(Math.abs(r.level - (50 + 0.9114 - 1)) < 0.05);
  assert.ok(r.level < 50);
});

test("指向归因：'妈的'吐槽第三方事件 → 水位不降反升（信任信号）", () => {
  const messages = [msg("a", "other", "妈的，国庆人太多了", T0)];
  const r = aggregateValence(messages, {
    a: line({
      emotions: { angry: 0.9 },
      targets: { external: 0.9 },
    }),
  });
  assert.ok(r.level > 50, `期望升到 50 以上，实际 ${r.level}`);
  assert.deepEqual(r.negatives, []);
});

test("指向归因：同样是不耐烦，指向我重扣、指向外部几乎不扣、无指向轻扣", () => {
  const mk = (targets: Record<string, number>) =>
    aggregateValence(
      [msg("a", "other", "烦死了", T0)],
      { a: line({ emotions: { annoyed: 1 }, targets }) },
    );
  const me = mk({ me: 1 });
  const external = mk({ external: 1 });
  const general = mk({ general: 1 });
  assert.ok(me.level < 49.2, `指向我应重扣，实际 ${me.level}`);
  assert.ok(external.level > 50, `指向外部应转正，实际 ${external.level}`);
  assert.ok(general.level < 50 && general.level > 49, `无指向应轻扣，实际 ${general.level}`);
  assert.ok(me.level < general.level);
  assert.ok(general.level < 50 && external.level > me.level + 1);
});

test("指向对方自己（自嘲/喊累）是轻度负信号，且计入负信号清单需指向我", () => {
  const messages = [msg("a", "other", "emo了", T0)];
  const r = aggregateValence(messages, {
    a: line({ emotions: { sad: 1 }, targets: { other_self: 1 } }),
  });
  assert.ok(r.level < 50 && r.level > 49, `轻度负信号，实际 ${r.level}`);
  assert.deepEqual(r.negatives, []);
});

test("单条影响力上限：一条再猛的负面消息最多压低 1 分", () => {
  const messages = [msg("a", "other", "！！！怒！！！", T0)];
  const r = aggregateValence(messages, {
    a: line({ emotions: { angry: 1 }, targets: { me: 1 } }),
  });
  assert.equal(r.points[0].influence, -VALENCE_PARAMS.maxInfluence);
  assert.equal(r.level, 49);
});

test("半衰期 10 天：同一负面消息，10 天前影响减半，20 天前再减半", () => {
  // 用未触 ±1 钳制的信号（sad 无指向 → -0.8×0.3=-0.24 → 约 -0.64 分）才能看到衰减
  const messages = [msg("a", "other", "最近有点丧", T0)];
  const lines = { a: line({ emotions: { sad: 1 }, targets: { general: 1 } }) };
  const now = parseTs(T0)!;
  const fresh = aggregateValence(messages, lines, { now });
  const tenDays = aggregateValence(messages, lines, { now: now + 10 * DAY });
  const twentyDays = aggregateValence(messages, lines, { now: now + 20 * DAY });
  assert.ok(Math.abs(fresh.points[0].influence - -0.64) < 0.01);
  assert.ok(Math.abs(tenDays.points[0].influence - -0.32) < 0.01);
  assert.ok(Math.abs(twentyDays.points[0].influence - -0.16) < 0.01);
  assert.ok(fresh.level < tenDays.level && tenDays.level < twentyDays.level);
});

test("无时间戳消息：不衰减、排在曲线最后、按全量生效", () => {
  const messages = [
    msg("a", "other", "早", "2026年09月19日 08:00"),
    msg("b", "other", "嗯", null),
  ];
  const r = aggregateValence(messages, {
    a: line({ emotions: { happy: 1 } }),
    b: line({ emotions: { angry: 1 }, targets: { me: 1 } }),
  }, { now: parseTs("2026年09月29日 08:00")! });
  // a 已过 10 天衰减一半：+0.45；b 无时间戳不衰减：-1
  assert.ok(Math.abs(r.points[0].influence - 0.46) < 0.02);
  assert.equal(r.points[1].influence, -1);
  assert.equal(r.points.at(-1)!.id, "b");
});

test("负信号清单：指向我 ≥0.5 的负面消息入列；旧会话无 targets 时按词面极性兜底", () => {
  const withTargets = aggregateValence(
    [
      msg("a", "other", "冲我发火", T0),
      msg("b", "other", "自嘲", T0),
    ],
    {
      a: line({ emotions: { angry: 1 }, targets: { me: 1 } }),
      b: line({ emotions: { sad: 1 }, targets: { other_self: 1 } }),
    },
  );
  assert.deepEqual(withTargets.negatives, [
    { id: "a", at: T0, valence: -0.95 },
  ]);
  const legacy = aggregateValence(
    [msg("a", "other", "很难过", T0)],
    { a: line({ emotions: { sad: 1 } }) },
  );
  assert.equal(legacy.negatives.length, 1);
  assert.equal(legacy.negatives[0].id, "a");
});

test("线性模式：负信号固定 1.5×，弱负面不触顶", () => {
  const messages = [msg("a", "other", "哦", T0)];
  const lines = { a: line({ emotions: { annoyed: 1 }, targets: { me: 1 } }) };
  const linear = aggregateValence(messages, lines, { weighting: "linear" });
  // annoyed -0.6 × 1.5 = -0.9，未触 ±1 钳制
  assert.ok(Math.abs(linear.points[0].influence - -0.9) < 0.001);
  const prospect = aggregateValence(messages, lines);
  assert.equal(prospect.points[0].influence, -1);
});

test("水位钳制在 0-100：海量负面也压不到 0 以下", () => {
  const messages = Array.from({ length: 60 }, (_, i) =>
    msg(`m${i}`, "other", `怒${i}`, T0),
  );
  const lines = Object.fromEntries(
    messages.map((m) => [m.id, line({ emotions: { angry: 1 }, targets: { me: 1 } })]),
  );
  const r = aggregateValence(messages, lines);
  assert.ok(r.level >= 0 && r.level <= 100);
  assert.equal(r.level, 0);
});

test("摘要：空曲线 → level 50、变化 null、无负信号、points 0", () => {
  const s = summarizeValence(aggregateValence([], {}));
  assert.equal(s.level, 50);
  assert.equal(s.change7d, null);
  assert.equal(s.negatives7d, 0);
  assert.equal(s.points, 0);
});

test("摘要：跨 7 天有锚点才算 change7d（以最新消息时刻为参考）", () => {
  const T10 = "2026年09月29日 12:00";
  const messages = [
    msg("a", "other", "哈哈哈太好玩了", T0),
    msg("b", "other", "你烦不烦", T10),
  ];
  const r = aggregateValence(messages, {
    a: line({ emotions: { happy: 1 } }),
    b: line({ emotions: { angry: 1 }, targets: { me: 1 } }),
  });
  // a 在 10 天前衰减一半：50 + 0.91×0.5 ≈ 50.5；b 新鲜且触钳制：49.5
  const s = summarizeValence(r);
  assert.equal(s.level, 49.5);
  assert.equal(s.change7d, -1);
  assert.equal(s.points, 2);
  // 负信号在窗口内（距今 0 天）
  assert.equal(s.negatives7d, 1);
});

test("摘要：数据不足 7 天 → change7d 为 null，不编造趋势", () => {
  const T3 = "2026年09月22日 12:00";
  const messages = [
    msg("a", "other", "哈哈哈太好玩了", T0),
    msg("b", "other", "哈哈开心", T3),
  ];
  const s = summarizeValence(
    aggregateValence(messages, {
      a: line({ emotions: { happy: 1 } }),
      b: line({ emotions: { happy: 1 } }),
    }),
  );
  assert.equal(s.change7d, null);
  assert.equal(s.points, 2);
});

test("摘要：7 天前的负信号不计入 negatives7d，窗口内的计入", () => {
  const T9 = "2026年09月28日 12:00";
  const messages = [
    msg("old", "other", "你烦不烦", T0), // 距今 10 天，窗口外
    msg("new", "other", "又在忙", T9), // 距今 1 天，窗口内
  ];
  const r = aggregateValence(messages, {
    old: line({ emotions: { angry: 1 }, targets: { me: 1 } }),
    new: line({ emotions: { annoyed: 1 }, targets: { me: 1 } }),
  });
  const s = summarizeValence(r);
  assert.equal(s.negatives7d, 1);
  // 有 10 天前的锚点 → change7d 可算（两条都触 -1 钳制：50-1-1=48，锚点水位 49）
  assert.equal(s.level, 48);
  assert.equal(s.change7d, -1);
});

test("摘要：无时间戳的负信号无法排除，宁多报计入", () => {
  const r = aggregateValence(
    [msg("a", "other", "你烦不烦", null)],
    { a: line({ emotions: { angry: 1 }, targets: { me: 1 } }) },
  );
  const s = summarizeValence(r);
  assert.equal(s.negatives7d, 1);
  assert.equal(s.change7d, null);
  assert.equal(s.points, 1);
});
