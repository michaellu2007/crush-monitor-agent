// 开源版不含微信聊天记录导入实现（该能力随闭源 exe 分发）。
// 构建桩：同名导出、零逻辑，保证服务端可构建可运行。
export type ChatSummary = { user: string; name: string; count: number; at: string };
export function listChats(): ChatSummary[] {
  return [];
}
export async function refresh(): Promise<void> {}
export function mediaFilePath(_rel: string): string | null {
  return null;
}
export async function avatarFileFor(
  _wxid: string,
): Promise<{ file: string; type: string } | null> {
  return null;
}
