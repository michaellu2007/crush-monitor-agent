import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlaceholderText, evidenceMatchRate } from "../server/profile-extract";
import { normalizeProfile } from "../shared/profile";

const msg = (text: string) => ({ text });

test("占位判定：整行媒体标记与空文本都算占位", () => {
  for (const t of ["[图片]", "[表情包]", "[语音]", "[卡片消息]", "[撤回消息]", "  ", ""])
    assert.equal(isPlaceholderText(t), true, t);
});

test("占位判定：带标题的链接占位也算", () => {
  assert.equal(isPlaceholderText("[链接] 某篇文章"), true);
});

test("占位判定：正常聊天不算占位", () => {
  assert.equal(isPlaceholderText("今天好累啊"), false);
  assert.equal(isPlaceholderText("行"), false);
});

test("证据回验率：全部命中=1，半数=0.5，全不中=0", () => {
  const msgs = [msg("周末去看展吧"), msg("好啊我正好想去")];
  assert.equal(evidenceMatchRate("周末去看展吧；好啊我正好想去", msgs), 1);
  assert.equal(evidenceMatchRate("周末去看展吧；完全不存在的一句话", msgs), 0.5);
  assert.equal(evidenceMatchRate("完全没有的两句话都不是原话", msgs), 0);
});

test("证据回验率：剥掉转写行前缀后仍能命中（回归五轮修准）", () => {
  const msgs = [msg("我明天要加班到很晚")];
  assert.equal(evidenceMatchRate("对方（2026年11月1日 10:00）：我明天要加班到很晚", msgs), 1);
});

test("证据回验率：无有效段（<4 字）记 0，不误判为可信", () => {
  assert.equal(evidenceMatchRate("好；行", [msg("好")]), 0);
  assert.equal(evidenceMatchRate(undefined, [msg("随便什么")]), 0);
});

test("画像规整：四轴齐全且合法才保留 type（与 axes 强一致）", () => {
  const p = normalizeProfile(
    {
      interests: [],
      boundaries: [],
      events: [],
      mbti: {
        type: "ENTJ",
        tier: "medium",
        axes: [
          { dim: "E/I", pick: "E", percent: 80, status: "ok", reason: "x" },
          { dim: "S/N", pick: "N", percent: 70, status: "ok" },
          { dim: "T/F", pick: "T", percent: 75, status: "ok" },
          { dim: "J/P", pick: "J", percent: 90, status: "ok" },
        ],
      },
    },
    "wxid_test",
  );
  assert.ok(p?.mbti);
  assert.equal(p.mbti.type, "ENTJ");
  assert.equal(p.mbti.tier, "medium");
  assert.equal(p.mbti.axes[0].status, "ok");
});

test("画像规整：type 与 axes 不一致时以 axes 为准重拼", () => {
  const p = normalizeProfile(
    {
      interests: [],
      boundaries: [],
      events: [],
      mbti: {
        type: "INFP",
        axes: [
          { dim: "E/I", pick: "E", percent: 80 },
          { dim: "S/N", pick: "N", percent: 70 },
          { dim: "T/F", pick: "T", percent: 75 },
          { dim: "J/P", pick: "J", percent: 90 },
        ],
      },
    },
    "wxid_test",
  );
  assert.equal(p?.mbti?.type, "ENTJ");
});

test("画像规整：缺一轴 pick 时丢弃 type，只保留逐轴结论（宁可说测不准）", () => {
  const p = normalizeProfile(
    {
      interests: [],
      boundaries: [],
      events: [],
      mbti: {
        type: "ENTJ",
        tier: "low",
        axes: [
          { dim: "E/I", pick: "E", percent: 60, status: "weak", reason: "短消息会话" },
          { dim: "S/N", percent: 0, status: "split", reason: "投票分歧" },
          { dim: "T/F", pick: "T", percent: 60, status: "weak" },
          { dim: "J/P", pick: "J", percent: 60, status: "weak" },
        ],
      },
    },
    "wxid_test",
  );
  assert.equal(p?.mbti?.type, undefined);
  assert.equal(p?.mbti?.axes.length, 4);
  const sn = p?.mbti?.axes.find((a) => a.dim === "S/N");
  assert.equal(sn?.pick, undefined);
  assert.equal(sn?.status, "split");
});

test("画像规整：tier/status 非法值被丢弃，不污染展示", () => {
  const p = normalizeProfile(
    {
      interests: [],
      boundaries: [],
      events: [],
      mbti: {
        tier: "超准",
        axes: [{ dim: "E/I", pick: "E", percent: 70, status: "bogus" }],
      },
    },
    "wxid_test",
  );
  assert.equal(p?.mbti?.tier, undefined);
  assert.equal(p?.mbti?.axes[0].status, undefined);
  assert.equal(p?.mbti?.type, undefined); // 只有一轴，拼不出四字母
});
