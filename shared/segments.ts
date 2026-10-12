import type { Message } from "./types";
import { MAX_MESSAGES, MAX_TEXT_CHARS } from "./limits";

// ponytail: month buckets + count/char cap; per-event memory continuity across
// segments is out of scope — each segment is judged standalone. Merge window
// overlap if cross-segment event resolution ever matters.
export type Segment = { messages: Message[]; label: string };

// Full date+time only: bare "21:53" has no anchor for month bucketing.
export function parseTs(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw
    .replace(/[[\]]/g, " ")
    .replace(",", " ")
    .match(
      /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    );
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isNaN(t.getTime()) ? null : t.getTime();
}

const key = (t: number) => {
  const d = new Date(t);
  return d.getFullYear() * 12 + d.getMonth();
};
const label = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
};
export function humanGap(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分钟`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}小时`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}天`;
  return `${Math.round(d / 30)}个月`;
}

// Messages already arrive chronological (oldest first). Group by calendar
// month (dateless messages ride along with the previous one), then split any
// month exceeding the per-request caps into consecutive sub-chunks.
export function buildSegments(messages: Message[]): Segment[] {
  const caps = { count: Math.min(120, MAX_MESSAGES), chars: 11000 };
  const buckets: { key: number; first: number; items: Message[] }[] = [];
  let current: { key: number; first: number; items: Message[] } | null = null;
  for (const m of messages) {
    const t = parseTs(m.timestamp);
    const k: number = t !== null ? key(t) : (current?.key ?? -Infinity);
    if (!current || k !== current.key) {
      current = { key: k, first: t ?? 0, items: [] };
      buckets.push(current);
    } else if (t !== null && !current.first) current.first = t;
    current.items.push(m);
  }
  const segments: Segment[] = [];
  for (const b of buckets) {
    let chunk: Message[] = [],
      chars = 0;
    const name = b.first ? label(b.first) : "早期消息";
    const flush = () => {
      if (chunk.length) segments.push({ messages: chunk, label: name });
      chunk = [];
      chars = 0;
    };
    for (const m of b.items) {
      const n = Array.from(m.text).length;
      if (chunk.length && (chunk.length >= caps.count || chars + n > caps.chars))
        flush();
      chunk.push(m);
      chars += n;
    }
    flush();
  }
  return segments;
}
