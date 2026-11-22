import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { judgeOutcome, calibrationSummary } from "../shared/calibration";
import {
  addCalibration,
  listCalibration,
  confirmCalibration,
} from "../server/calibration-store";

test("对账判定：延续类意图 → 接住", () => {
  assert.equal(judgeOutcome({ continue: 0.9 }, {}), "caught");
  assert.equal(judgeOutcome({ answer: 0.6, close: 0.3 }, {}), "caught");
});

test("对账判定：收尾/拒绝 ≥0.4 且不低于接球 → 没接", () => {
  assert.equal(judgeOutcome({ close: 0.9 }, {}), "missed");
  assert.equal(judgeOutcome({ refuse: 0.5, answer: 0.4 }, {}), "missed");
});

test("对账判定：意图都弱时正向情绪兜底 → 接住；否则 null", () => {
  assert.equal(
    judgeOutcome({ other: 0.6 }, { happy: 0.7, calm: 0.3 }),
    "caught",
  );
  assert.equal(judgeOutcome({ other: 0.9 }, { calm: 1 }), null);
  assert.equal(judgeOutcome(undefined, undefined), null);
});

test("校准摘要：样本 <5 不出校准率（宁少报）", () => {
  const mk = (outcome: "caught" | "missed") =>
    ({ outcome }) as never;
  const four = [1, 2, 3, 4].map((i) => mk(i % 2 ? "caught" : "missed"));
  const s4 = calibrationSummary(four);
  assert.equal(s4.n, 4);
  assert.equal(s4.rate, null);
  const five = [...four, mk("caught")] as never[];
  const s5 = calibrationSummary(five as never);
  assert.equal(s5.rate, Math.round((3 / 5) * 100));
});

test("校准落盘：记录→确认→列表回环", () => {
  const convId = "zz-cal-test";
  try {
    const rec = addCalibration({
      convId,
      intent: "推进关系",
      draft: "周末有个市集，一起去逛？",
      actionIndex: 1,
      catchProbability: 0.65,
    });
    assert.equal(rec.outcome, null);
    const listed = listCalibration(convId);
    assert.ok(listed.some((r) => r.id === rec.id));
    assert.equal(confirmCalibration(rec.id, "caught"), 1);
    const after = listCalibration(convId).find((r) => r.id === rec.id);
    assert.equal(after?.outcome, "caught");
  } finally {
    try {
      // 清理本测试写入的记录：整体文件重写剔除
      const p = "data/calibration.json";
      const raw = JSON.parse(readFileSync(p, "utf8"));
      raw.records = raw.records.filter(
        (r: { convId: string }) => r.convId !== convId,
      );
      writeFileSync(p, JSON.stringify(raw), "utf8");
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});
