import type { ContactBaseline, Message } from "./types";
import { parseTs } from "./segments";
import { hasEmoji, visibleLength } from "./trivial";

/**
 * 对方行为基线：从完整聊天记录统计的客观习惯——短回复占比、长度中位数、
 * 回复间隔中位数、表情率、主动开话题率。用途只有一个：校准解读
 * （"哦/嗯嗯"类短消息是 TA 的常态还是异常，由数据说话，不靠猜）。
 * 依据见 情感文献参考.md U 节：实测基线 > 用户断言；Jin & Peña 2010（节奏按人校准）。
 *
 * 纯函数：App 用全量 messages 调用（valenceSummary 同模式），随请求发给服务端
 * 注入判官题目与顾问 prompt；不落盘，消息变了重算即得。
 */
const WINDOW_MS = 90 * 86_400_000; // 近 90 天优先（grill 确认）
const WINDOW_MIN = 30; // 窗口内少于此数回退全部历史
const MIN_SAMPLE = 20; // 对方文本消息少于此数不产出基线
const SESSION_GAP = 12 * 60 * 60 * 1000; // ≥12h 无消息算新会话
const SHORT_MAX = 4; // 剥掉表情标点后 ≤4 字算短回复（嗯嗯/哈哈/好的）
const MIN_SESSIONS = 5; // 会话数不足不出主动率
const MIN_GAP_MS = 60_000; // <1 分钟的间隔是连发，不计入回复间隔

const round2 = (x: number) => Math.round(x * 100) / 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function computeBaseline(messages: Message[]): ContactBaseline | null {
  const ts = (m: Message) => parseTs(m.timestamp);
  const otherText = messages.filter(
    (m) => m.kind === "text" && m.sender === "other",
  );
  if (otherText.length < MIN_SAMPLE) return null;

  const times = messages.map(ts).filter((t): t is number => t !== null);
  if (!times.length) {
    // 全程无时间戳：只算与时间无关的项，窗口标全部历史
    return {
      window: "全部历史",
      sample: otherText.length,
      shortReplyRate: round2(
        otherText.filter((m) => visibleLength(m.text) <= SHORT_MAX).length /
          otherText.length,
      ),
      medianLen: Math.round(
        median(otherText.map((m) => Array.from(m.text).length)),
      ),
      medianGapMin: null,
      emojiRate: round2(
        otherText.filter((m) => hasEmoji(m.text)).length / otherText.length,
      ),
      initiationRate: null,
    };
  }
  // 锚点取会话最后一条的时间（不是墙钟——导入的历史聊天也能正确开窗）
  const lastTs = Math.max(...times);
  const recent = otherText.filter(
    (m) => (ts(m) ?? -Infinity) >= lastTs - WINDOW_MS,
  );
  const useRecent = recent.length >= WINDOW_MIN;
  const pool = useRecent ? recent : otherText;
  if (pool.length < MIN_SAMPLE) return null;

  // 回复间隔要按全序列顺序取"上一条消息"（任何发送者），只统计 pool 内的对方消息
  const poolIds = new Set(pool.map((m) => m.id));
  const gaps: number[] = [];
  let prev: number | null = null;
  for (const m of messages) {
    const t = ts(m);
    if (t === null) continue;
    if (m.sender === "other" && poolIds.has(m.id) && prev !== null)
      if (t - prev >= MIN_GAP_MS) gaps.push((t - prev) / 60_000);
    prev = t;
  }
  // 会话发起：≥12h 开新会话，只统计"开启时间落在基线窗口内"的会话
  // （窗口全部历史时即全程；锚定开启消息本身，不受 pool 首条对方消息的位置影响）
  const windowStart = useRecent ? lastTs - WINDOW_MS : -Infinity;
  let sessions = 0,
    otherInit = 0,
    prevT: number | null = null;
  for (const m of messages) {
    const t = ts(m);
    if (t === null) continue;
    if ((prevT === null || t - prevT >= SESSION_GAP) && t >= windowStart) {
      sessions++;
      if (m.sender === "other") otherInit++;
    }
    prevT = t;
  }
  return {
    window: useRecent ? "近90天" : "全部历史",
    sample: pool.length,
    shortReplyRate: round2(
      pool.filter((m) => visibleLength(m.text) <= SHORT_MAX).length /
        pool.length,
    ),
    medianLen: Math.round(median(pool.map((m) => Array.from(m.text).length))),
    medianGapMin: gaps.length ? Math.round(median(gaps)) : null,
    emojiRate: round2(
      pool.filter((m) => hasEmoji(m.text)).length / pool.length,
    ),
    initiationRate:
      sessions >= MIN_SESSIONS ? round2(otherInit / sessions) : null,
  };
}

/** 基线一句话摘要（UI 面板与注入题目共用口径）。 */
export function describeBaseline(b: ContactBaseline): string {
  const parts = [
    `短回复 ${Math.round(b.shortReplyRate * 100)}%`,
    `长度中位数 ${b.medianLen} 字`,
  ];
  if (b.medianGapMin != null) parts.push(`间隔中位数约 ${b.medianGapMin} 分钟`);
  if (b.initiationRate != null)
    parts.push(`主动开聊 ${Math.round(b.initiationRate * 100)}%`);
  return `${b.window} · 样本 ${b.sample} 条 · ${parts.join(" · ")}`;
}
