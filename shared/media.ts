/**
 * 媒体消息（图片/表情包/语音/视频/文件/链接等）的统一识别与展示。
 *
 * 两条导入路径共用：
 * - TXT 粘贴：parser.ts 的 toMessages 先 decodeFaces 再 classifyMedia；
 * - 微信导入：wechat.ts 出来的 [图片]/[表情] 等占位在 App.tsx importChat 时分类。
 *
 * AI 红线：classifyMedia 命中的消息 kind=unreadable，逐条评分天然跳过；
 * 上下文里只发规范化占位符（[图片] 等）。address 只存 Message.media 供本机
 * 展示，analysis.ts 的 buildRequest 不发送该字段，图片地址永不出本机。
 */

// 微信自带文字表情 → Unicode emoji（显示与语义分析通用）
export const FACE_MAP: Record<string, string> = {
  微笑: "🙂", 撇嘴: "😣", 色: "😍", 发呆: "😐", 得意: "😎", 流泪: "😢",
  害羞: "😳", 闭嘴: "🤐", 睡: "😴", 大哭: "😭", 尴尬: "😅", 发怒: "😡",
  调皮: "😜", 呲牙: "😁", 惊讶: "😲", 难过: "🙁", 龇牙: "😁", 冷汗: "😰",
  抓狂: "🤯", 吐: "🤮", 偷笑: "🤭", 愉快: "☺️", 白眼: "🙄", 傲慢: "😤",
  困: "😪", 惊恐: "😱", 悠闲: "😌", 咒骂: "🤬", 疑问: "❓", 嘘: "🤫",
  晕: "😵", 衰: "😞", 骷髅: "💀", 敲打: "👊", 再见: "👋", 擦汗: "😓",
  鼓掌: "👏", 坏笑: "😏", 委屈: "🥺", 快哭了: "😥", 阴险: "😈", 亲亲: "😘",
  笑脸: "😄", 吃瓜: "🍉", 加油: "💪", Emm: "🤔", 旺柴: "🐕", OK: "👌",
  合十: "🙏", 握手: "🤝", 点赞: "👍", 拳头: "✊", 咖啡: "☕", 蛋糕: "🎂",
  玫瑰: "🌹", 心: "❤️", 破涕为笑: "😂", 脸红: "😳", 幽灵: "👻", 庆祝: "🎉",
  转圈: "🌀", 捂脸: "🤦", 翻白眼: "🙄", 右捂脸: "🤦", 左捂脸: "🤦", 哈欠: "🥱",
  猪头: "🐷", 拥抱: "🤗", 强: "💪", 弱: "😖", 饭: "🍚", 西瓜: "🍉",
};
const FACE_RE = /\[([一-龥A-Za-z]{1,6})\]/g;
export function decodeFaces(text: string): string {
  return text.replace(FACE_RE, (raw, name: string) => FACE_MAP[name] ?? raw);
}

export type MediaType =
  | "image"
  | "sticker"
  | "voice"
  | "video"
  | "file"
  | "link"
  | "card"
  | "revoked"
  | "unsupported";

/** address：文件路径 / URL / 链接标题，仅本机展示，不进任何模型 prompt。 */
export type MediaInfo = { type: MediaType; address?: string };

export const MEDIA_LABELS: Record<MediaType, string> = {
  image: "图片",
  sticker: "表情包",
  voice: "语音",
  video: "视频",
  file: "文件",
  link: "链接",
  card: "卡片消息",
  revoked: "撤回的消息",
  unsupported: "不可见消息",
};
export const MEDIA_ICONS: Record<MediaType, string> = {
  image: "🖼️",
  sticker: "😉",
  voice: "🎤",
  video: "🎬",
  file: "📎",
  link: "🔗",
  card: "🃏",
  revoked: "↩️",
  unsupported: "🚫",
};
// 发给 AI 的上下文占位符（与微信导入路径的历史格式一致）
export const MEDIA_PLACEHOLDERS: Record<MediaType, string> = {
  image: "[图片]",
  sticker: "[表情包]",
  voice: "[语音]",
  video: "[视频]",
  file: "[文件]",
  link: "[链接]",
  card: "[卡片消息]",
  revoked: "[撤回消息]",
  unsupported: "[不支持的消息]",
};

// 表情包没有本地文件可显示时，按 md5 散列出不同图标（至少不千篇一律）
const STICKER_ICONS = [
  "😀", "😂", "🥰", "😎", "🤔", "😭", "🥺", "😜",
  "😡", "🤯", "🫠", "😱", "🤡", "👻", "💯", "🔥",
];
export function stickerIconFor(hash?: string): string {
  if (!hash) return STICKER_ICONS[0];
  let n = 2166136261;
  for (const c of hash) n = ((n ^ c.charCodeAt(0)) * 16777619) >>> 0;
  return STICKER_ICONS[n % STICKER_ICONS.length];
}

const TAG_TYPES: Record<string, MediaType> = {
  图片: "image", 图像: "image", 照片: "image", 相片: "image",
  img: "image", image: "image", photo: "image", picture: "image",
  表情: "sticker", 表情包: "sticker", 动画表情: "sticker", 贴图: "sticker",
  贴纸: "sticker", sticker: "sticker",
  语音: "voice", 音频: "voice", voice: "voice", audio: "voice",
  视频: "video", video: "video",
  文件: "file", 附件: "file", file: "file",
  链接: "link", 网页: "link", 网址: "link", link: "link", url: "link",
  位置: "card", 名片: "card", 红包: "card", 转账: "card", 小程序: "card",
  引用: "card", 合并转发: "card", 聊天记录: "card",
  撤回: "revoked", 撤回消息: "revoked",
  不支持的消息: "unsupported", 未知消息: "unsupported",
};

const TAG_ONLY = /^\[([^\[\]]{1,12})\]$/;
// 标签名不含冒号，保证在第一个冒号处切分（地址里常含 D: 这类盘符）
const TAG_WITH_ADDRESS = /^\[([^[\]:：]{1,10})[：:]\s*([^\[\]]+?)\s*\]$/;
const OMITTED = /^<\s*(media|image|video|audio|sticker)\s+omitted\s*>$/i;
const OMITTED_TYPES: Record<string, MediaType> = {
  media: "file", image: "image", video: "video", audio: "voice",
  sticker: "sticker",
};
const BARE_URL = /^(?:https?:\/\/|www\.)\S+$/i;
const MD_LINK = /^\[([^\[\]]{1,120})\]\((https?:\/\/\S+)\)$/i;
const BARE_PATH = /^([A-Za-z]:[\\/][^<>:"|?*\n]+\.[A-Za-z0-9]{2,5})$/;
const EXT_TYPES: Record<string, MediaType> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  bmp: "image", avif: "image",
  mp4: "video", mov: "video", avi: "video", mkv: "video",
  mp3: "voice", wav: "voice", amr: "voice", aac: "voice", m4a: "voice",
};
// chatlog/微信导出的 appmsg XML 原文（可多行、很长），按内嵌标签猜类型
const XML_BLOB = /^\s*<(\?xml|msg[\s>]|appmsg|img[\s>]|videomsg|voicemsg|emoji)/i;

/**
 * 整条消息就是一个媒体占位/地址时返回 MediaInfo，普通文字返回 null。
 * 刻意保守：混着文字的消息（"看这个 https://…"）一律不拦，照常送评。
 */
export function classifyMedia(raw: string): MediaInfo | null {
  const text = raw.trim();
  if (!text) return null;
  if (XML_BLOB.test(text)) {
    if (/<img[\s>]/i.test(text)) return { type: "image" };
    if (/<videomsg/i.test(text)) return { type: "video" };
    if (/<voicemsg/i.test(text)) return { type: "voice" };
    if (/<emoji/i.test(text)) return { type: "sticker" };
    return { type: "card" };
  }
  // 其余规则只认短标记行，长文本绝不拦截
  if (text.length > 300) return null;
  const omitted = OMITTED.exec(text);
  if (omitted) return { type: OMITTED_TYPES[omitted[1].toLowerCase()] };
  const tag = TAG_ONLY.exec(text);
  if (tag) {
    const type = TAG_TYPES[tag[1].toLowerCase()];
    if (type) return { type };
  }
  const withAddress = TAG_WITH_ADDRESS.exec(text);
  if (withAddress) {
    const type = TAG_TYPES[withAddress[1].toLowerCase()];
    if (type) return { type, address: withAddress[2] };
  }
  // 前缀形态：[链接] 标题 / [文件] 名字.pdf（微信导出常见），后跟内容
  const prefixedLink = /^\[(?:链接|link)\]\s*(.+)$/i.exec(text);
  if (prefixedLink) return { type: "link", address: prefixedLink[1].trim() };
  const prefixedFile = /^\[(?:文件|file)\]\s*(.+)$/i.exec(text);
  if (prefixedFile) return { type: "file", address: prefixedFile[1].trim() };
  // 整条是 [xxx] 形式但不是已知媒体标记（如未收录的微信表情）→ 普通文本
  if (tag) return null;
  if (BARE_URL.test(text)) return { type: "link", address: text };
  const md = MD_LINK.exec(text);
  if (md) return { type: "link", address: md[2] };
  const path = BARE_PATH.exec(text);
  if (path) {
    const ext = path[1].split(".").at(-1)!.toLowerCase();
    const type = EXT_TYPES[ext] ?? "file";
    return { type, address: path[1] };
  }
  return null;
}
