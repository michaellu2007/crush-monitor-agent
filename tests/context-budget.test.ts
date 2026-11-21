import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextTokensForModel,
  transcriptCharBudget,
  transcriptCharBudgetForConfig,
  judgeTranscriptChars,
  stateMessagesBudget,
  condenseMessages,
} from "../server/context-budget";
import { buildRequest } from "../server/analysis";

test("启发式：qwen 8B 档按用户口径 128k", () => {
  assert.equal(contextTokensForModel("Qwen/Qwen3-8B"), 128_000);
  assert.equal(contextTokensForModel("qwen3-4b"), 128_000);
});

test("启发式：常见家族各自落位", () => {
  assert.equal(contextTokensForModel("gemini-2.5-pro"), 900_000);
  assert.equal(contextTokensForModel("glm-4.7-flash"), 120_000);
  assert.equal(contextTokensForModel("deepseek-chat"), 1_000_000);
  assert.equal(contextTokensForModel("deepseek-ai/DeepSeek-R1-0528-Qwen3-8B"), 128_000, "8B 蒸馏一律 128k");
  assert.equal(contextTokensForModel("claude-sonnet"), 180_000);
  assert.equal(contextTokensForModel("kimi-latest"), 200_000);
});

test("启发式：模型名里显式标窗口的变体优先（kimi-32k / qwen-long-10m）", () => {
  assert.equal(contextTokensForModel("moonshot-v1-32k"), 32_000);
  assert.equal(contextTokensForModel("qwen-long-10m"), 10_000_000);
});

test("启发式：未知模型保守 32k（宁小勿大）", () => {
  assert.equal(contextTokensForModel("my-private-model-v2"), 32_000);
});

test("预算换算：tokens − 预留 8k，再 ×1.2 字/token，且不低于 2 万字符", () => {
  const b = transcriptCharBudget("Qwen/Qwen3-8B");
  assert.equal(b, Math.round((128_000 - 8_000) * 1.2));
  const small = transcriptCharBudget("my-private-model-v2");
  assert.ok(small >= 20_000, "最小预算保护");
});

test("显式覆盖：model.json 里 contextTokens 优先于启发式", () => {
  assert.equal(transcriptCharBudget("Qwen/Qwen3-8B", 1_000_000), Math.round((1_000_000 - 8_000) * 1.2));
  assert.equal(transcriptCharBudget("Qwen/Qwen3-8B", 16_000), 20_000);
});

test("config 快捷入口：透传 model 与 contextTokens", () => {
  const b = transcriptCharBudgetForConfig({
    engine: "llm",
    provider: "p",
    name: "n",
    endpoint: "http://x",
    model: "Qwen/Qwen3-8B",
    apiKey: "",
    protocol: "openai",
    jsonMode: true,
    contextTokens: 64_000,
  });
  assert.equal(b, Math.round((64_000 - 8_000) * 1.2));
});

test("判官侧预算：无 20k 下限、无覆盖时按模型名推断并钳 16k", () => {
  // 本地 16k 判官：16384−10000 预留 → ×1.2 字符
  assert.equal(judgeTranscriptChars("jevk5"), Math.round((16_384 - 10_000) * 1.2));
  // 云端 128k 名字也钳到 16k（本地判官窗口通常 16k，宁小勿大）
  assert.equal(judgeTranscriptChars("qwen3-8b"), Math.round((16_384 - 10_000) * 1.2));
  // 显式覆盖优先：判官真有 128k 窗口时填 contextTokens=128000
  assert.equal(
    judgeTranscriptChars("qwen3-8b", 128_000),
    Math.round((128_000 - 10_000) * 1.2),
  );
  // 极小覆盖：不产生负数/零预算
  assert.equal(judgeTranscriptChars("x", 10_000), 2_000);
});

test("state 预算：纯 API 口径按启发式不钳 16k，小窗口模型触下限保护", () => {
  // 未知名保守 32k → 28.8k 字 > 总闸 12000：对云判官实际 no-op
  assert.equal(stateMessagesBudget("jevk5"), Math.round((32_000 - 8_000) * 1.2));
  // 8B 云判官 128k → 144k 字：多选/长消息请求不再被本地口径误钳
  assert.equal(stateMessagesBudget("Qwen/Qwen3-8B"), Math.round((128_000 - 8_000) * 1.2));
  // 小窗口 API 模型（8k）：触 2000 下限兜底
  assert.equal(stateMessagesBudget("moonshot-v1-8k"), 2_000);
  // 显式覆盖优先；极小覆盖（≤预留8k+零头）触 2000 下限，不产生负数/零预算
  assert.equal(stateMessagesBudget("x", 10_000), 2_400, "10000−8000 → ×1.2");
  assert.equal(stateMessagesBudget("x", 8_192), 2_000, "8192−8000=230 → 下限兜底");
});

test("keep-recent 压缩器：保尾部与被判目标、丢最旧、至少保最后一条", () => {
  const mk = (n: number, len: number) =>
    Array.from({ length: n }, (_, i) => ({ id: String(i), text: "字".repeat(len) }));
  const c = condenseMessages(mk(10, 100), 500);
  assert.equal(c.messages.length, 5);
  assert.equal(c.omitted, 5);
  assert.equal(c.messages[0].id, "5", "丢弃的是最旧的头");
  // 预算内：原样返回零丢弃
  const fit = condenseMessages(mk(3, 100), 500);
  assert.equal(fit.omitted, 0);
  assert.equal(fit.messages.length, 3);
  // 单条超预算：仍保留最后一条作锚点
  const one = condenseMessages([{ id: "0", text: "字".repeat(2000) }], 500);
  assert.deepEqual(one, { messages: [{ id: "0", text: "字".repeat(2000) }], omitted: 0 });
  // keepIds 保护：被判目标在最旧处也不丢（不计入是否超预算的取舍）
  const guarded = condenseMessages(mk(10, 100), 500, new Set(["0"]));
  assert.equal(guarded.messages[0].id, "0");
  assert.equal(guarded.omitted, 4, "保住目标后丢 4 条（500 恰装 5 条）");
});

test("buildRequest 接预算：超限 keep-recent，id 保持原索引供证据回指", () => {
  const msgs = [
    { id: "t0", sender: "other" as const, text: "怎么回事？", timestamp: null, kind: "text" as const },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: String(i + 1),
      sender: "self" as const,
      text: "补".repeat(700),
      timestamp: null,
      kind: "text" as const,
    })),
  ];
  const budget = stateMessagesBudget("jevk5", 16_384); // 显式 16k 覆盖 ≈10060 字
  const req = {
    revision: 1,
    relation: "crush" as const,
    task: "other_messages" as const,
    targetIds: ["30"],
    messages: msgs,
  };
  const { state } = buildRequest(req, budget);
  const kept = state.messages as { id: string }[];
  assert.ok(kept.length < 31, "超预算被钳制");
  assert.ok("messagesNote" in state, "钳制附注记告知判官");
  // state.id 是 input.messages 的原索引（compact 约定）：判官证据回指
  // input.messages[Number(id)] 不串位——t0 映射成 "0"，尾部 "17".."30" 原样
  for (const m of kept) {
    const idx = Number(m.id);
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < msgs.length, `索引合法 ${m.id}`);
  }
  assert.equal(kept.at(-1)!.id, "30");
  // 被判目标 t30 在最旧处也不丢（keepIds 保护）；小体积的开场消息在预算剩余内保留
  assert.ok(kept.some((m) => m.id === "30"));
  assert.ok(kept.some((m) => m.id === "0"), "msgs[0]=t0 的索引 0 被保留");
  // 无预算：行为与原先一致
  const full = buildRequest(req);
  assert.equal((full.state.messages as unknown[]).length, 31);
  assert.ok(!("messagesNote" in full.state));
});
