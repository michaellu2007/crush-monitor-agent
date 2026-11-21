// 宽容 JSON 解析层：让画像抽取/候选自审/发前体检/决策树在任何大模型下都能用。
// 原则：结构形态"能捞就捞"（对象数组、字符串数字、中文引号、思考块前后缀都处理），
// 只有完全找不到 JSON 时才抛错——shape 不匹配永远降级为空值/默认值，不报错。

/** 剥掉思考模型的 <think>…</think> 包裹。 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** 从任意文本里提取第一个**配平**的 JSON 对象（忽略字符串内的花括号）。 */
export function extractBalancedObject(text: string): unknown {
  const cleaned = stripThink(text)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("输出里没有 JSON");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = cleaned.slice(start, i + 1);
        // 容忍中文引号/尾逗号（含 ASCII 逗号）等轻度违规
        const repaired = slice
          .replace(/[，、,]\s*[}\]]/g, (m) => m.replace(/[，、,]/g, ""))
          .replace(/[""]/g, '"')
          .replace(/['']/g, '"');
        try {
          return JSON.parse(repaired);
        } catch {
          return JSON.parse(slice); // 修复失败就用原样（让上层抛原生错误）
        }
      }
    }
  }
  throw new Error("输出里没有配平的 JSON 对象");
}

/** 任意值 → 字符串（对象则取最长字符串值；数字转字符串）。 */
export function coerceString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const s = v.trim();
    return s || undefined;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(coerceString).filter(Boolean).join("；") || undefined;
  if (typeof v === "object") {
    let best: string | undefined;
    for (const val of Object.values(v as Record<string, unknown>)) {
      const s = coerceString(val);
      if (s && (!best || s.length > best.length)) best = s;
    }
    return best;
  }
  return undefined;
}

/** 任意值 → 字符串数组：字符串按分隔符拆、对象取字段、嵌套数组摊平。 */
export function coerceStringArray(v: unknown, cap: number): string[] {
  if (v === null || v === undefined) return [];
  const items: string[] = [];
  const push = (x: unknown) => {
    const s = coerceString(x);
    if (s) items.push(s);
  };
  if (typeof v === "string") {
    v.split(/[、，,;；\n]+/).forEach(push);
  } else if (Array.isArray(v)) {
    v.forEach((x) =>
      typeof x === "object" && x !== null && !Array.isArray(x)
        ? // 对象形态：优先常见字段，否则整对象转字符串
          push(
            ((x as Record<string, unknown>).name ??
              (x as Record<string, unknown>).title ??
              (x as Record<string, unknown>).topic ??
              (x as Record<string, unknown>).label ??
              (x as Record<string, unknown>).text ??
              x) as unknown,
          )
        : push(x),
    );
  } else push(v);
  return [...new Set(items)].slice(0, cap);
}

/** 任意值 → 数字（容忍 "65"、65、"65%"；范围钳制可选）。 */
export function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.replace(/％/g, "%").match(/-?\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return undefined;
}

/** 任意值 → 0-1 概率：>1 视作百分数自动 /100。 */
export function coerceProbability(v: unknown): number | null {
  const n = coerceNumber(v);
  if (n === undefined) return null;
  const p = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, Math.round(p * 100) / 100));
}

/** 任意值 → 事件数组（对象取 at/date + note/description；字符串整条当 note）。 */
export function coerceEventArray(
  v: unknown,
  cap: number,
): { at?: string; note: string }[] {
  if (v === null || v === undefined) return [];
  const src = Array.isArray(v) ? v : [v];
  const out: { at?: string; note: string }[] = [];
  for (const x of src) {
    if (x === null || x === undefined) continue;
    if (typeof x === "object" && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      const note =
        coerceString(o.note ?? o.description ?? o.event ?? o.text ?? o.content ?? o.title) ??
        coerceString(o);
      if (note)
        out.push({
          at: coerceString(o.at ?? o.date ?? o.time),
          note: note.slice(0, 200),
        });
    } else {
      const note = coerceString(x);
      if (note) out.push({ note: note.slice(0, 200) });
    }
    if (out.length >= cap) break;
  }
  return out;
}
