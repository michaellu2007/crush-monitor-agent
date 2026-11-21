/**
 * 输入框实时体检的触发判定（纯函数）：草稿 ≥10 字、非纯空白、与上次已体检内容不同。
 * 判官不可用/请求失败由调用方静默隐藏——实时体检绝不打扰输入。
 */
export function shouldCheck(
  text: string,
  lastChecked: string | null,
): boolean {
  const t = text.trim();
  if (!t) return false;
  if ([...t].length < 10) return false;
  return t !== (lastChecked ?? "");
}
