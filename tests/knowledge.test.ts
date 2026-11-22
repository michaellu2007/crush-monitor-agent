// 用户自配知识库（2026-11-18）：存储钳制 + 检索评分 + 工具输出预算。
// cwd 决定 data/knowledge.json 路径——测试在仓库根跑，注意别污染真实数据（用后清理）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import {
  loadKnowledge,
  saveKnowledge,
  searchKnowledge,
  KNOWLEDGE_LIMITS,
} from "../server/knowledge-store";
import { executeTool } from "../server/advisor-tools";

const FILE = "data/knowledge.json";
const hadFile = existsSync(FILE);
const backup = hadFile ? loadKnowledge() : null;

function cleanup() {
  if (hadFile) saveKnowledge(backup as never[]);
  else if (existsSync(FILE)) unlinkSync(FILE);
}

test("钳制：超量条目截断、超长内容裁剪、全空条目丢弃", () => {
  const junk = Array.from({ length: 60 }, (_, i) => ({
    id: `k${i}`,
    title: `条目${i}`,
    content: "长".repeat(3000),
    updatedAt: "",
  }));
  junk.push({ id: "", title: "", content: "   ", updatedAt: "" });
  const saved = saveKnowledge(junk);
  try {
    assert.equal(saved.length, KNOWLEDGE_LIMITS.entries, "50 条上限");
    assert.ok(
      saved.every((e) => e.content.length <= KNOWLEDGE_LIMITS.content),
      "内容 ≤2000",
    );
    assert.ok(saved.every((e) => e.title || e.content), "全空条目被丢弃");
    const reloaded = loadKnowledge();
    assert.equal(reloaded.length, KNOWLEDGE_LIMITS.entries, "落盘回读一致");
  } finally {
    cleanup();
  }
});

test("检索：标题命中权重高于正文；无命中返回空", () => {
  saveKnowledge([
    { id: "a", title: "我们的约定", content: "每周至少一次约会", updatedAt: "" },
    { id: "b", title: "TA 的偏好", content: "不喜欢叫外卖，喜欢自己做饭；讨厌香菜", updatedAt: "" },
    { id: "c", title: "无关条目", content: "记账习惯", updatedAt: "" },
  ]);
  try {
    const hits = searchKnowledge("香菜 偏好");
    assert.equal(hits[0]?.id, "b", "标题+正文双命中排第一");
    assert.equal(hits.length, 1);
    assert.deepEqual(searchKnowledge("完全无关词xyz"), []);
    assert.deepEqual(searchKnowledge("   "), []);
  } finally {
    cleanup();
  }
});

test("工具：search_knowledge 命中返回条目、miss 返回提示、输出 ≤8000（B6 护栏）", async () => {
  const deps = {
    search: () => [],
    getProfile: () => null,
    scoreDraft: async () => "x",
    searchKnowledge: (q: string, limit: number) =>
      q.includes("约定")
        ? [{ id: "a", title: "我们的约定", content: "长".repeat(1300), updatedAt: "" }]
        : [],
  };
  const hit = await executeTool(
    "search_knowledge",
    '{"query":"我们的约定"}',
    { contactId: "" },
    deps,
  );
  assert.ok(hit.includes("【我们的约定】"), "命中带标题");
  assert.ok(hit.length <= 8000, `命中输出 ${hit.length} ≤8000`);
  const miss = await executeTool(
    "search_knowledge",
    '{"query":"无关节词"}',
    { contactId: "" },
    deps,
  );
  assert.ok(miss.includes("没有相关条目"));
  const bad = await executeTool("search_knowledge", '{"query":""}', { contactId: "" }, deps);
  assert.ok(bad.includes("参数错误"));
  assert.ok(hit.length <= 8000 && !hit.includes("长".repeat(1300)), "单条内容裁 1200");
});
