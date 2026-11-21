import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest } from "../server/analysis";
import { RUBRIC } from "../shared/types";
import type { AnalysisRequest } from "../shared/types";

/** 判官盲区补丁（判官评测报告 2026-10-26 第四节）：叠词爽快回应默认积极。 */
function baseInput(text: string): AnalysisRequest {
  return {
    revision: 1,
    relation: "crush",
    messages: [
      { id: "t1", sender: "other", text, timestamp: "2026年10月29日 12:00", kind: "text" },
    ],
    task: "other_messages",
    targetIds: ["t1"],
  };
}

test("盲区补丁：叠词判据进情绪题题干", () => {
  const { questions } = buildRequest(baseInput("行行行"));
  const q = questions["t1_emotions"] as { instructions: string };
  assert.match(q.instructions, /叠词爽快回应/);
  assert.match(q.instructions, /默认判积极/);
});

test("盲区补丁：叠词判据进意图题题干（倾向延续类候选）", () => {
  const { questions } = buildRequest(baseInput("行行行"));
  const q = questions["t1_intents"] as { instructions: string };
  assert.match(q.instructions, /叠词爽快回应/);
  assert.match(q.instructions, /agree、continue/);
});

test("盲区补丁：RUBRIC bump（题目文本变化需守护可比性）", () => {
  assert.equal(RUBRIC, "crush-2026-10-28.0");
});
