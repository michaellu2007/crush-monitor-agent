import type { Questions } from "@typesafe-ai/sdk";

// 情感文献参考.md D3（Zheng et al. 2024, ICLR：LLM 选择题存在选项位置偏差，须去偏）。
// LLM 路径把候选按插入顺序编号为 c0..cn：若语义键永远占据同一位置
// （如 TARGETS 的 me 恒为 c0），模型的位置偏好会系统性抬升某个固定标签。
// 这里按"候选集合 + 请求盐值"做确定性乱序：
// - 同一请求内同一候选集排列一致 → compileLlmInput 的 definitions 去重仍然生效（零额外 token）；
// - 盐值取自消息集 → 不同会话/不同增量批次的排列无关，位置偏差跨请求抵消；
// - 确定性（无 Math.random）→ 同一请求可复现，A/B 与对比集结果稳定。
// score 题的 criteria 是有序等级数组（decodeLlm 按位次加权求分），乱序会破坏序数语义，保持原序。

const fnv1a = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export function debiasChoiceOrders(
  questions: Questions,
  salt: string,
): Questions {
  const out: Questions = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type !== "choice" || Array.isArray(q.criteria)) {
      out[id] = q;
      continue;
    }
    const keys = Object.keys(q.criteria);
    if (keys.length < 2) {
      out[id] = q;
      continue;
    }
    // mulberry32：小而够用的确定性 PRNG，种子混入键名与盐值。
    let a = (fnv1a([...keys].sort().join("\u0000")) ^ fnv1a(salt)) | 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) | 0;
      const t = Math.imul(a ^ (a >>> 15), 1 | a);
      return (((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ (t >>> 14)) >>> 0) /
        4294967296;
    };
    const order = keys.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    out[id] = {
      ...q,
      criteria: Object.fromEntries(order.map((k) => [k, q.criteria[k]])),
    };
  }
  return out;
}
