import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeTool,
  ADVISOR_TOOLS,
  type ToolDeps,
} from "../server/advisor-tools";
import { createSearchDb, type IndexedMessage } from "../server/history-search";
import type { ContactProfile } from "../shared/profile";

const fakeDeps = (over?: Partial<ToolDeps>): ToolDeps => {
  const db = createSearchDb(":memory:");
  db.indexConversation("conv-a", "contact-a", [
    { id: "a1", sender: "other", text: "上周末去看展了，超棒", timestamp: "2026年10月20日 14:00" },
  ] satisfies IndexedMessage[]);
  return {
    search: (q, contactId, limit) => db.search(q, contactId, limit),
    getProfile: () => null,
    scoreDraft: async (draft) => `回应门槛 30/100，翻车风险 20/100——${draft.slice(0, 5)}`,
    searchKnowledge: () => [],
    ...over,
  };
};

test("工具清单：四个工具、名字唯一、schema 含参数定义", () => {
  assert.equal(ADVISOR_TOOLS.length, 4);
  const names = ADVISOR_TOOLS.map((t) => t.function.name);
  assert.deepEqual([...new Set(names)].sort(), [
    "get_profile",
    "score_draft",
    "search_history",
    "search_knowledge",
  ]);
  for (const t of ADVISOR_TOOLS) {
    assert.equal(t.type, "function");
    assert.ok(t.function.description.length > 10, t.function.name);
  }
});

test("B6 护栏：三个工具的最坏输出 ≤8000 字（工具结果预算，Claude-Code L1 同款）", async () => {
  // 工具结果直接进消息数组，无预算会在未来改动（调大 limit/删截断）时无声撑爆上下文。
  // 现状：search_history limit=8×120 字；get_profile 走 normalizeProfile 全字段钳制
  // （PROFILE_LIMITS：interests 10×30 / boundaries 10×40 / events 20×200）；score_draft 裁 1000。
  const longHits = Array.from({ length: 50 }, (_, i) => ({
    sender: "other",
    timestamp: "2026-01-01 10:00",
    text: "长".repeat(5000) + `#${i}`,
  }));
  const deps = fakeDeps({
    search: () => longHits,
    getProfile: () => ({
      schema: 1,
      contactId: "c",
      interests: Array.from({ length: 500 }, (_, i) => `兴趣${"长".repeat(200)}${i}`),
      boundaries: Array.from({ length: 500 }, (_, i) => `雷区${"长".repeat(200)}${i}`),
      events: Array.from({ length: 500 }, (_, i) => ({ note: "长".repeat(300) + i })),
    }),
    scoreDraft: async (d) => "评审：" + d,
  });
  const ctx = { contactId: "c" };
  const outs = [
    { name: "search_history", out: await executeTool("search_history", '{"query":"随便"}', ctx, deps) },
    { name: "get_profile", out: await executeTool("get_profile", "{}", ctx, deps) },
    { name: "score_draft", out: await executeTool("score_draft", JSON.stringify({ draft: "长".repeat(5000) }), ctx, deps) },
  ];
  for (const { name, out } of outs)
    assert.ok(out.length <= 8000, `${name} 输出 ${out.length} 字超预算 8000`);
});

test("search_history：命中并格式化为可读行；跨联系人查不到（隐私硬约束）", async () => {
  const deps = fakeDeps();
  const hit = await executeTool(
    "search_history",
    '{"query":"看展"}',
    { contactId: "contact-a" },
    deps,
  );
  assert.ok(hit.includes("看展了"));
  assert.ok(hit.includes("对方"));
  const miss = await executeTool(
    "search_history",
    '{"query":"看展"}',
    { contactId: "contact-b" },
    deps,
  );
  assert.ok(miss.includes("没有命中"));
});

test("search_history：query 缺失/参数坏 JSON 返回容错文案不抛", async () => {
  const deps = fakeDeps();
  const noQuery = await executeTool("search_history", "{}", { contactId: "a" }, deps);
  assert.ok(noQuery.includes("query"));
  const bad = await executeTool("search_history", "不是JSON", { contactId: "a" }, deps);
  assert.ok(bad.includes("JSON"));
  await assert.doesNotReject(() =>
    executeTool("search_history", "", { contactId: "a" }, deps),
  );
});

test("get_profile：有画像带守卫句与雷区，无画像给占位", async () => {
  const withProfile: ToolDeps = {
    ...fakeDeps(),
    getProfile: () =>
      ({
        schema: 1,
        contactId: "contact-a",
        interests: ["看展"],
        boundaries: ["前任"],
        events: [],
        updatedAt: new Date().toISOString(),
      }) satisfies ContactProfile,
  };
  const hit = await executeTool("get_profile", "", { contactId: "contact-a" }, withProfile);
  assert.ok(hit.includes("硬约束"));
  assert.ok(hit.includes("前任"));
  const empty = await executeTool("get_profile", "", { contactId: "contact-a" }, fakeDeps());
  assert.ok(empty.includes("暂无长期画像"));
});

test("score_draft：走 deps.scoreDraft（本地判官）", async () => {
  const out = await executeTool(
    "score_draft",
    '{"draft":"周末有个市集，一起去逛？"}',
    { contactId: "a" },
    fakeDeps(),
  );
  assert.ok(out.includes("回应门槛"));
  assert.ok(out.includes("周末有个"));
});

test("未知工具与缺作用域都有兜底文案", async () => {
  const unknown = await executeTool("web_search", "{}", { contactId: "a" }, fakeDeps());
  assert.ok(unknown.includes("未知工具"));
  const noScope = await executeTool("search_history", '{"query":"x"}', { contactId: "" }, fakeDeps());
  assert.ok(noScope.includes("缺少联系人作用域"));
});
