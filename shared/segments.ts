import type { Message } from "./types";

// 自适应分析单元：按信息量积累，在自然停顿或容量上限处切分。
// 聊得猛（一天几百条）切得细；聊得稀（两个月几十条）合并成一个单元全读。
// —— 不做死板的日历切分（产品口径：密度决定粒度）。
const GAP_SPLIT_MS = 48 * 3600_000; // ≥48h 停顿视为自然边界
const UNIT_CAP_MSGS = 120;
const UNIT_CAP_CHARS = 9000;
const UNIT_MIN_MSGS = 20; // 单元不足此数时不按停顿切分（太稀就合并）

export type AnalysisUnit = { messages: Message[]; label: string };

// Full date+time only: bare "21:53" has no anchor for unit splitting.
export function parseTs(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw
    .replace(/[[\]]/g, " ")
    .replace(",", " ")
    .match(
      /(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    );
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isNaN(t.getTime()) ? null : t.getTime();
}

export function humanGap(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分钟`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}小时`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}天`;
  return `${Math.round(d / 30)}个月`;
}

const dayLabel = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

// 消息须按时间正序传入。切分规则：
// 1) 容量上限（120 条 / 9000 字）必切；
// 2) ≥48h 停顿且当前单元已有 ≥20 条 → 在停顿处切；
// 3) 单元太小则跨停顿继续积累（稀疏期全读）。
export function buildAnalysisUnits(messages: Message[]): AnalysisUnit[] {
  const units: AnalysisUnit[] = [];
  let unit: Message[] = [];
  let chars = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  const flush = () => {
    if (!unit.length) return;
    const a = firstTs ?? 0;
    const b = lastTs ?? a;
    const label =
      a && b && dayLabel(a) !== dayLabel(b)
        ? `${dayLabel(a)} - ${dayLabel(b)}`
        : dayLabel(a || b);
    units.push({ messages: unit, label });
    unit = [];
    chars = 0;
  };

  for (const m of messages) {
    const t = parseTs(m.timestamp);
    const len = Array.from(m.text).length;
    if (
      unit.length &&
      (unit.length >= UNIT_CAP_MSGS ||
        chars + len > UNIT_CAP_CHARS ||
        (t !== null &&
          lastTs !== null &&
          t - lastTs >= GAP_SPLIT_MS &&
          unit.length >= UNIT_MIN_MSGS))
    ) {
      flush();
    }
    if (t !== null) {
      if (firstTs === null) firstTs = t;
      lastTs = t;
    }
    unit.push(m);
    chars += len;
  }
  flush();
  return segments_with_unique_labels(units);
}

function segments_with_unique_labels(units: AnalysisUnit[]): AnalysisUnit[] {
  const used = new Map<string, number>();
  return units.map((u) => {
    const n = (used.get(u.label) ?? 0) + 1;
    used.set(u.label, n);
    return n > 1 ? { ...u, label: `${u.label} · 第${n}段` } : u;
  });
}
