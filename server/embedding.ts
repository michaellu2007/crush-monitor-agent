// 本地 embedding 客户端（RAG 二期）：走 OpenAI 兼容 /v1/embeddings（llama.cpp/Ollama 均支持），
// 文本不出本机。配置 .runtime/embed.json（zod）——文件缺失=向量层关闭，检索行为与一期逐字一致。
// 批次 ≤32；429/5xx/网络错误退避重试 2 次；任一批最终失败 → 整体返回 null（调用方降级纯 FTS）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const embedConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  dims: z.number().int().positive().optional(),
});
export type EmbedConfig = z.infer<typeof embedConfigSchema>;

export function loadEmbedConfig(
  file = join(process.cwd(), ".runtime", "embed.json"),
): EmbedConfig | null {
  if (!existsSync(file)) return null;
  try {
    return embedConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export type Embedder = {
  /** 批量向量化；任一批次最终失败返回 null（调用方降级）。 */
  embed(texts: string[]): Promise<number[][] | null>;
};

const BATCH = 32;
const RETRIES = 3;
const backoffMs = (attempt: number) => 1500 * (attempt + 1);

export function createEmbedder(
  cfg: EmbedConfig,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return {
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        let vecs: number[][] | null = null;
        for (let attempt = 0; attempt < RETRIES && !vecs; attempt++) {
          try {
            const r = await fetchImpl(
              `${cfg.baseUrl.replace(/\/+$/, "")}/v1/embeddings`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
                },
                body: JSON.stringify({ model: cfg.model, input: batch }),
                signal: AbortSignal.timeout(60_000),
              },
            );
            if (r.status === 429 || r.status >= 500) {
              await new Promise((res) => setTimeout(res, backoffMs(attempt)));
              continue;
            }
            if (!r.ok) return null;
            const data = await r.json();
            const parsed = (data?.data ?? []).map(
              (d: { embedding: unknown }) => d.embedding as number[],
            );
            if (!Array.isArray(parsed) || parsed.length !== batch.length) return null;
            vecs = parsed;
          } catch {
            if (attempt === RETRIES - 1) return null;
            await new Promise((res) => setTimeout(res, backoffMs(attempt)));
          }
        }
        if (!vecs) return null;
        out.push(...vecs);
      }
      return out;
    },
  };
}
