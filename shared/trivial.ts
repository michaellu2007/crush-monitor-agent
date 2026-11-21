/**
 * 规则门控：纯表情/纯标点/单字消息信息量极低（短文本情感处理的低信息分支，
 * 依据见情感文献参考.md D2 节：Kiritchenko 2014、Kralj Novak 2015），
 * 直接跳过 judge 逐条评分——省调用次数，也避免把"哦/嗯"硬判成态度。
 *
 * 判定刻意保守：只拦"剥掉表情与标点后不超过 1 个字符"的消息。
 * 哈哈、妈的、ok、666 等多字消息照常送评。
 */

const EMOJI_AND_MARKS =
  /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}]/gu;

/** 剥掉表情与标点后的可见字数（供门控与短回复基线共用同一口径）。 */
export function visibleLength(text: string): number {
  const rest = text
    .replace(EMOJI_AND_MARKS, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  return Array.from(rest).length;
}

/** 是否含 emoji/图形字符（match+全局正则不涉 lastIndex 状态）。 */
export function hasEmoji(text: string): boolean {
  return text.match(EMOJI_AND_MARKS) !== null;
}

/** 低信息量消息返回给用户看的跳过原因；正常消息返回 null。 */
export function trivialSkipReason(text: string): string | null {
  const count = visibleLength(text);
  if (count === 0) {
    // 剥完什么都不剩：纯表情或纯标点
    return "纯表情/标点，低信息量，跳过评分";
  }
  if (count === 1) return "单字消息，低信息量，跳过评分";
  return null;
}
