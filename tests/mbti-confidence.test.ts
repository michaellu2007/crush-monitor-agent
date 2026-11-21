import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sampleTier,
  decideAxis,
  decideMbti,
  MBTI_GATES,
  type AxisInput,
} from "../server/mbti-confidence";

const axis = (over: Partial<AxisInput> = {}): AxisInput => ({
  dim: "E/I",
  pick: "E",
  voteShare: 1,
  evidenceRate: 1,
  hitHi: 0,
  hitLo: 0,
  total: 100,
  hiPick: "",
  ...over,
});

test("样本充足度：三项达标=ok，一项不达标=thin，两项+=insufficient", () => {
  assert.equal(
    sampleTier({ medianLen: 20, longCount: 50, placeholderRatio: 0.1 }),
    "ok",
  );
  assert.equal(
    sampleTier({ medianLen: 6, longCount: 50, placeholderRatio: 0.1 }),
    "thin",
  );
  assert.equal(
    sampleTier({ medianLen: 6, longCount: 5, placeholderRatio: 0.1 }),
    "insufficient",
  );
  assert.equal(
    sampleTier({ medianLen: 6, longCount: 5, placeholderRatio: 0.8 }),
    "insufficient",
  );
});

test("阈值常量：短消息判定线 8 字、命中率 1.5%、最少 8 条命中", () => {
  assert.equal(MBTI_GATES.shortChatMedian, 8);
  assert.equal(MBTI_GATES.statHitRate, 0.015);
  assert.equal(MBTI_GATES.statMinHits, 8);
});

test("单轴：样本不足时不给 pick", () => {
  const v = decideAxis(axis(), "insufficient");
  assert.equal(v.pick, null);
  assert.equal(v.status, "insufficient");
});

test("单轴：投票一致 + 证据可信 → ok，置信按加权取整", () => {
  const v = decideAxis(axis({ voteShare: 1, evidenceRate: 1 }), "ok");
  assert.equal(v.pick, "E");
  assert.equal(v.status, "ok");
  assert.equal(v.percent, 95); // 100 封顶 95
});

test("单轴：证据引用全不可信时，一致投票也只算弱结论", () => {
  const v = decideAxis(axis({ voteShare: 1, evidenceRate: 0 }), "ok");
  assert.equal(v.pick, "E");
  assert.equal(v.status, "weak");
  assert.ok(v.percent <= 60);
});

test("单轴：投票分裂但词面统计强 → 按统计给弱结论（方向取统计高侧）", () => {
  const v = decideAxis(
    axis({
      dim: "J/P",
      pick: "P",
      voteShare: 0.5,
      evidenceRate: 1,
      hitHi: 12,
      hitLo: 3,
      hiPick: "J",
      total: 100,
    }),
    "ok",
  );
  assert.equal(v.pick, "J");
  assert.equal(v.status, "weak");
  assert.ok(v.percent <= 55);
});

test("单轴：投票分裂且词面统计不足 → 不给 pick（split）", () => {
  const v = decideAxis(
    axis({
      dim: "J/P",
      pick: "P",
      voteShare: 0.5,
      evidenceRate: 1,
      hitHi: 5,
      hitLo: 4,
      hiPick: "J",
      total: 100,
    }),
    "ok",
  );
  assert.equal(v.pick, null);
  assert.equal(v.status, "split");
});

test("短消息会话：E/I 与 S/N 即使全票一致也降为弱结论", () => {
  const d = decideMbti(
    [
      axis({ dim: "E/I", pick: "E" }),
      axis({ dim: "S/N", pick: "S" }),
      axis({ dim: "T/F", pick: "T" }),
      axis({ dim: "J/P", pick: "J" }),
    ],
    { medianLen: 6, longCount: 50, placeholderRatio: 0.07 },
  );
  const ei = d.axes.find((a) => a.dim === "E/I")!;
  const sn = d.axes.find((a) => a.dim === "S/N")!;
  assert.equal(ei.status, "weak");
  assert.equal(sn.status, "weak");
  assert.ok(ei.percent <= 60 && sn.percent <= 60);
  assert.match(ei.reason, /短消息/);
  assert.ok(d.notes.some((n) => n.includes("E/I 与 S/N")));
});

test("短消息会话：只有两轴确定时不给四字母（tier=low）", () => {
  const d = decideMbti(
    [
      axis({ dim: "E/I", pick: "E" }),
      axis({ dim: "S/N", pick: "S" }),
      axis({ dim: "T/F", pick: "T" }),
      // J/P 分裂且统计弱 → 无 pick
      axis({
        dim: "J/P",
        pick: "J",
        voteShare: 0.5,
        evidenceRate: 0,
        hitHi: 2,
        hitLo: 2,
        total: 100,
      }),
    ],
    { medianLen: 6, longCount: 50, placeholderRatio: 0.07 },
  );
  assert.equal(d.type, null);
  assert.equal(d.tier, "low");
});

test("长文本会话：四轴全确定 → 高可信并给出四字母", () => {
  const d = decideMbti(
    [
      axis({ dim: "E/I", pick: "E" }),
      axis({ dim: "S/N", pick: "N" }),
      axis({ dim: "T/F", pick: "T" }),
      axis({ dim: "J/P", pick: "J" }),
    ],
    { medianLen: 30, longCount: 80, placeholderRatio: 0.05 },
  );
  assert.equal(d.type, "ENTJ");
  assert.equal(d.tier, "high");
});

test("四轴方向都判出但置信偏低 → 仍给四字母，但标低可信并说明", () => {
  const weak = (dim: string, pick: string) =>
    axis({ dim, pick, voteShare: 0.67, evidenceRate: 0, total: 100 });
  const d = decideMbti(
    [weak("E/I", "E"), weak("S/N", "S"), weak("T/F", "T"), weak("J/P", "J")],
    { medianLen: 30, longCount: 80, placeholderRatio: 0.05 },
  );
  assert.equal(d.type, "ESTJ");
  assert.equal(d.tier, "low");
  assert.ok(d.notes.some((n) => n.includes("仅作弱参考")));
});

test("两路证据冲突（投票明确 vs 强统计反向）→ 弃权，不给方向", () => {
  const d = decideMbti(
    [
      axis({ dim: "E/I", pick: "E" }),
      // 模型全票 S，但词面假设词 18 vs 细节 2 反向：词表长度不对称带来的假象，弃权
      axis({
        dim: "S/N",
        pick: "S",
        voteShare: 1,
        evidenceRate: 1,
        hitHi: 18,
        hitLo: 2,
        hiPick: "N",
        total: 800,
      }),
      axis({ dim: "T/F", pick: "T" }),
      axis({ dim: "J/P", pick: "J" }),
    ],
    { medianLen: 30, longCount: 80, placeholderRatio: 0.05 },
  );
  const sn = d.axes.find((a) => a.dim === "S/N")!;
  assert.equal(sn.pick, null);
  assert.equal(sn.status, "split");
  assert.match(sn.reason, /两路证据冲突/);
  assert.equal(d.type, null, "有轴弃权 → 不给四字母");
});

test("投票不明确 + 强统计 → 统计定方向，只标弱结论", () => {
  const d = decideMbti(
    [
      axis({ dim: "E/I", pick: "E" }),
      axis({ dim: "S/N", pick: "S" }),
      // 投票 1:1，但词面 J 15:6 强 → 按 J 给弱结论
      axis({
        dim: "J/P",
        pick: "P",
        voteShare: 0.5,
        evidenceRate: 0.2,
        hitHi: 15,
        hitLo: 6,
        hiPick: "J",
        total: 800,
      }),
      axis({ dim: "T/F", pick: "T" }),
    ],
    { medianLen: 30, longCount: 80, placeholderRatio: 0.05 },
  );
  const jp = d.axes.find((a) => a.dim === "J/P")!;
  assert.equal(jp.pick, "J");
  assert.equal(jp.status, "weak");
});

test("样本不足：整份不给结论", () => {
  const d = decideMbti(
    [
      axis({ dim: "E/I" }),
      axis({ dim: "S/N" }),
      axis({ dim: "T/F" }),
      axis({ dim: "J/P" }),
    ],
    { medianLen: 4, longCount: 2, placeholderRatio: 0.8 },
  );
  assert.equal(d.type, null);
  assert.equal(d.tier, "insufficient");
  assert.ok(d.axes.every((a) => a.pick === null));
});
