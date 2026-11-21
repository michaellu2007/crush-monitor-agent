// 顾问斜杠指令解析（2026-11-18）：/readall /compact /goal /clear /mode /help。
// 纯函数可单测；未知 /xxx 不当指令（可能是路径等普通文本）→ 原样作为问题。
export type AdvCommand =
  | { type: "question"; question: string } // 普通提问
  | { type: "readall"; question: string } // 本轮读取全部聊天记录再答
  | { type: "compact" } // 立即压缩对话历史
  | { type: "goal"; arg: string } // 设定/清除/查看会话目标（arg 为空=查看）
  | { type: "clear" } // 清空顾问对话（=新建）
  | { type: "mode"; arg: string } // auto|manual（空=切换）
  | { type: "help" };

export const ADV_COMMAND_HELP = [
  "/readall <问题> —— 本轮读取全部聊天记录再回答",
  "/compact —— 立即压缩对话历史（长对话卡时用）",
  "/goal <目标> —— 设定本次咨询目标，后续回答围绕它；/goal clear 清除",
  "/mode auto|manual —— 自动模式（顾问自己检索历史）/ 手动模式（勾选记录）",
  "/clear —— 新建顾问对话",
  "/help —— 显示本列表",
].join("\n");

export function parseAdvCommand(raw: string): AdvCommand {
  const t = raw.trim();
  if (!t.startsWith("/")) return { type: "question", question: t };
  const sp = t.search(/\s/);
  const cmd = (sp === -1 ? t : t.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? "" : t.slice(sp + 1).trim();
  switch (cmd) {
    case "/readall":
      return arg ? { type: "readall", question: arg } : { type: "help" };
    case "/compact":
      return { type: "compact" };
    case "/goal":
      return { type: "goal", arg };
    case "/clear":
      return { type: "clear" };
    case "/mode":
      return { type: "mode", arg: arg.toLowerCase() };
    case "/help":
      return { type: "help" };
    default:
      // 未知指令：按普通文本处理（可能只是以 / 开头的正常内容）
      return { type: "question", question: t };
  }
}
