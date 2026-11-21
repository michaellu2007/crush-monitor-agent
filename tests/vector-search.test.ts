import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rrfFuse, createVectorStore, diffToEmbed } from "../server/history-search";
import { createEmbedder } from "../server/embedding";
import type { IndexedMessage, ShardItem } from "../server/history-search";

test("RRF 融合：两路都命中的排最前，单路命中按名次排", () => {
  const fused = rrfFuse([["a", "b", "c"], ["b", "d"]]);
  assert.equal(fused[0], "b"); // 两路都命中
  assert.ok(fused.indexOf("a") < fused.indexOf("c")); // 名次靠前分高
  assert.ok(fused.includes("d"));
  assert.deepEqual(rrfFuse([]), []);
});

test("向量分片：写读回环、原子写不落 tmp", () => {
  const dir = mkdtempSync(join(tmpdir(), "emb-test-"));
  try {
    const store = createVectorStore(dir);
    const shard: ShardItem[] = [
      { convId: "c", msgId: "m1", sender: "other", timestamp: null, text: "看展", vec: [1, 0] },
    ];
    store.writeShard("contact-x", shard);
    const back = store.readShard("contact-x");
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].vec, [1, 0]);
    assert.equal(store.readShard("contact-y").length, 0);
    assert.equal(
      readdirSync(dir).some((f) => f.endsWith(".tmp")),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("增量判定：只 embed 分片里没有的消息，空文本跳过", () => {
  const shard: ShardItem[] = [
    { convId: "c", msgId: "m1", sender: "other", timestamp: null, text: "旧", vec: [0] },
  ];
  const messages: IndexedMessage[] = [
    { id: "m1", sender: "other", text: "旧", timestamp: null },
    { id: "m2", sender: "other", text: "新的内容", timestamp: null },
    { id: "m3", sender: "other", text: "   ", timestamp: null },
  ];
  const todo = diffToEmbed(shard, messages);
  assert.deepEqual(todo.map((m) => m.id), ["m2"]);
});

test("embedding 客户端：成功返回向量矩阵", async () => {
  const calls: string[][] = [];
  const embedder = createEmbedder(
    { baseUrl: "http://127.0.0.1:9999", model: "bge" },
    async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)).input);
      return new Response(
        JSON.stringify({
          data: JSON.parse(String(init?.body)).input.map((_: string, i: number) => ({
            embedding: [i, 1],
          })),
        }),
        { status: 200 },
      );
    },
  );
  const vecs = await embedder.embed(["一", "二", "三"]);
  assert.deepEqual(vecs, [[0, 1], [1, 1], [2, 1]]);
  assert.equal(calls.length, 1); // 3 条一批
});

test("embedding 客户端：429 退避后成功", async () => {
  let n = 0;
  const embedder = createEmbedder(
    { baseUrl: "http://127.0.0.1:9999", model: "bge" },
    async () => {
      n++;
      if (n === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
        status: 200,
      });
    },
  );
  const vecs = await embedder.embed(["x"]);
  assert.deepEqual(vecs, [[1]]);
  assert.equal(n, 2);
});

test("embedding 客户端：持续 429 → null（降级），400 直接 null", async () => {
  const always429 = createEmbedder(
    { baseUrl: "http://127.0.0.1:9999", model: "bge" },
    async () => new Response("busy", { status: 429 }),
  );
  assert.equal(await always429.embed(["x"]), null);
  const bad400 = createEmbedder(
    { baseUrl: "http://127.0.0.1:9999", model: "bge" },
    async () => new Response("bad request", { status: 400 }),
  );
  assert.equal(await bad400.embed(["x"]), null);
});

test("embedding 客户端：超大批次分批发送", async () => {
  const batches: number[] = [];
  const embedder = createEmbedder(
    { baseUrl: "http://127.0.0.1:9999", model: "bge" },
    async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input;
      batches.push(input.length);
      return new Response(
        JSON.stringify({ data: input.map(() => ({ embedding: [1] })) }),
        { status: 200 },
      );
    },
  );
  const texts = Array.from({ length: 70 }, (_, i) => `文本${i}`);
  const vecs = await embedder.embed(texts);
  assert.equal(vecs?.length, 70);
  assert.deepEqual(batches, [32, 32, 6]);
});
