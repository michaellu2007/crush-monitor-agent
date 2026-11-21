// 顾问回复的最小 markdown 渲染（2026-11-18）：模型输出 ###/列表/**加粗**/`code`，
// 此前当纯文本画，格式符号原文漏出。约束子集够用不引库；React 节点无 dangerouslySetInnerHTML，
// 模型输出里的 HTML 字符自然转义，无注入面。
import type { ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**"))
      out.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AdvMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(<ul key={`ul-${blocks.length}`}>{list}</ul>);
      list = [];
    }
  };
  for (const [idx, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      flush();
      blocks.push(<div key={idx} className="adv-md-h">{inline(h[1], `h${idx}`)}</div>);
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+[.)、])\s+(.*)$/);
    if (li) {
      list.push(<li key={idx}>{inline(li[1], `l${idx}`)}</li>);
      continue;
    }
    flush();
    blocks.push(<p key={idx}>{inline(line, `p${idx}`)}</p>);
  }
  flush();
  return <div className="adv-md">{blocks}</div>;
}
