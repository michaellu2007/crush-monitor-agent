// 闭环校准落盘：data/calibration.json（data/ 整目录已 gitignore）。
// 原子写（tmp+rename）；上限 200 条挤最旧已确认的（待确认的永远保留）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CalibrationOutcome, CalibrationRecord } from "../shared/calibration";

const FILE = join(process.cwd(), "data", "calibration.json");
const CAP = 200;

function load(): CalibrationRecord[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(raw?.records) ? raw.records : [];
  } catch {
    return [];
  }
}

function save(records: CalibrationRecord[]) {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify({ records }), "utf8");
  renameSync(temp, FILE);
}

export function addCalibration(input: {
  convId: string;
  intent: string;
  draft: string;
  actionIndex: number;
  catchProbability: number | null;
}): CalibrationRecord {
  const records = load();
  const record: CalibrationRecord = {
    id: randomUUID(),
    convId: input.convId,
    intent: input.intent.slice(0, 500),
    draft: input.draft.slice(0, 500),
    actionIndex: input.actionIndex,
    catchProbability: input.catchProbability,
    at: new Date().toISOString(),
    outcome: null,
  };
  // 待确认优先保留：先按预算保住 pending（待确认丢了就永远等不到结果回填），
  // 剩余预算再补已确认的最旧条目（2026-11-19 bug 审查：旧实现 pending 很大时
  // 会把全部 confirmed 挤掉、再从头部丢 pending，与注释意图相反）
  const confirmed = records.filter((r) => r.outcome !== null);
  const pending = records.filter((r) => r.outcome === null);
  const next =
    confirmed.length + pending.length >= CAP
      ? [
          ...pending.slice(-Math.max(0, CAP - 1)),
          ...confirmed.slice(Math.max(0, CAP - 1 - pending.length)),
          record,
        ]
      : [...records, record];
  save(next.slice(-CAP));
  return record;
}

export function listCalibration(convId?: string): CalibrationRecord[] {
  const records = load();
  return convId ? records.filter((r) => r.convId === convId) : records;
}

/** 人工确认（或采纳自动预填）；返回确认条数。 */
export function confirmCalibration(
  id: string,
  outcome: CalibrationOutcome,
  evidenceMsgId?: string,
): number {
  const records = load();
  let n = 0;
  for (const r of records) {
    if (r.id === id) {
      r.outcome = outcome;
      if (evidenceMsgId) r.evidenceMsgId = evidenceMsgId;
      n++;
    }
  }
  if (n) save(records);
  return n;
}
