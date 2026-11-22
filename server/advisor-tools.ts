// 顾问 harness 工具层：顾问模型（OpenAI function calling）可按需调用
// search_history（更早历史检索）/ get_profile（长期画像）/ score_draft（判官打分草稿）。
// 隐私硬约束：search_history 与 get_profile 永远以 ctx.contactId 为作用域，
// 不允许跨联系人；score_draft 走本地判官（性能红线）。
// 端点不支持 function calling 时由 advise.ts 回退单发模式，本文件不涉及网络。
import { judgeConfig } from "./model-config";
import { judgeChat, extractJsonObject } from "./judge-chat";
import { readProfile } from "./profile-store";
import { getSearchDb, syncHistoryIndex } from "./history-search";
import { searchKnowledge } from "./knowledge-store";
import { describeProfile, normalizeProfile } from "../shared/profile";
import { z } from "zod";

export type ToolContext = { contactId: string };

export type ToolDeps = {
  search(
    query: string,
    contactId: string,
    limit: number,
  ): { sender: string; timestamp: string | null; text: string }[];
  getProfile(contactId: string): unknown;
  scoreDraft(draft: string): Promise<string>;
  searchKnowledge(
    query: string,
    limit: number,
  ): { id: string; title: string; content: string; updatedAt: string }[];
};

export const ADVISOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_history",
      description:
        "在该联系人的全部历史聊天记录里检索关键词（覆盖比摘选更早的上下文）。用于核实'上次说过什么'类问题。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "检索关键词" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_profile",
      description:
        "读取该联系人的长期画像：兴趣话题、边界雷区（硬约束）、沟通风格、重要事件时间线。无参数。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "检索用户自配的知识库（个人约定、对方偏好、背景资料、自己的经验规则）。涉及『我们的约定』『TA 的喜好』『知识库里』这类问题时必须先查这里。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "关键词" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "score_draft",
      description:
        "用本地判官给一个候选草稿打分（回应门槛/翻车风险）。想比较多个候选时可逐个调用。",
      parameters: {
        type: "object",
        properties: { draft: { type: "string", description: "草稿原文" } },
        required: ["draft"],
      },
    },
  },
] as const;

export const TOOL_LOOP_MAX_ROUNDS = 4;

export function defaultToolDeps(): ToolDeps {
  return {
    search(query, contactId, limit) {
      try {
        void syncHistoryIndex().catch(() => {});
      } catch {
        /* 索引失败不阻断（旧索引可用） */
      }
      return getSearchDb().search(query, contactId, limit);
    },
    getProfile(contactId) {
      return readProfile(contactId);
    },
    searchKnowledge(query, limit) {
      return searchKnowledge(query, limit);
    },
    async scoreDraft(draft) {
      const judge = judgeConfig();
      if (!judge) return "（本地判官未配置，无法打分——请按经验自行评估该候选。）";
      if (judge.protocol === "jev")
        return "（判官为 Jev 原生协议，不支持草稿打分——请按经验自行评估该候选。）";
      const raw = await judgeChat(
        judge,
        '你是聊天草稿评审。对草稿按两个维度打 0-100 分：threshold=回应门槛（对方接话需要付出的努力，越低越容易接）、risk=翻车风险。严格输出 JSON：{"threshold":0,"risk":0,"note":"一句话理由"}',
        `草稿：\n${draft}`,
      );
      const parsed = z
        .object({
          threshold: z.number().min(0).max(100),
          risk: z.number().min(0).max(100),
          note: z.string().max(200).optional(),
        })
        .parse(extractJsonObject(raw));
      return `回应门槛 ${Math.round(parsed.threshold)}/100，翻车风险 ${Math.round(
        parsed.risk,
      )}/100${parsed.note ? `——${parsed.note}` : ""}`;
    },
  };
}

function formatHits(
  hits: { sender: string; timestamp: string | null; text: string }[],
): string {
  if (!hits.length) return "（没有命中更早的历史记录。）";
  return `更早历史检索结果（${hits.length} 条，仅本联系人）：\n${hits
    .map(
      (h) =>
        `- ${h.timestamp ?? "时间不详"} ${h.sender === "self" ? "我" : "对方"}：${h.text.slice(0, 120)}`,
    )
    .join("\n")}`;
}

/** 工具执行：入参容错（模型给的 arguments 是 JSON 字符串），返回拼回上下文的文本。 */
export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext,
  deps: ToolDeps = defaultToolDeps(),
): Promise<string> {
  try {
    // 联系人作用域守卫只拦 search_history/get_profile（隐私硬约束）——
    // search_knowledge 是全局作用域（用户自己的资料），score_draft 走本地判官，
    // 无 contactId 时这两个仍可用（2026-11-18 知识库无 contactId 启用循环的前提）
    let args: Record<string, unknown> = {};
    if (typeof argsJson === "string" && argsJson.trim()) {
      try {
        args = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        return `（参数不是合法 JSON：${argsJson.slice(0, 80)}）`;
      }
    }
    if (name === "search_history") {
      if (!ctx.contactId) return "（工具不可用：缺少联系人作用域。）";
      const query = String(args.query ?? "").trim();
      if (!query) return "（参数错误：query 不能为空。）";
      return formatHits(deps.search(query.slice(0, 100), ctx.contactId, 8));
    }
    if (name === "get_profile") {
      if (!ctx.contactId) return "（工具不可用：缺少联系人作用域。）";
      const profile = normalizeProfile(deps.getProfile(ctx.contactId), ctx.contactId);
      if (!profile) return "（暂无长期画像。）";
      return describeProfile(profile) || "（暂无长期画像。）";
    }
    if (name === "search_knowledge") {
      const query = String(args.query ?? "").trim();
      if (!query) return "（参数错误：query 不能为空。）";
      const hits = deps.searchKnowledge(query.slice(0, 100), 3);
      if (!hits.length) return "（知识库里没有相关条目。）";
      return (
        `用户自配知识库检索结果（${hits.length} 条）：\n` +
        hits.map((h) => `- 【${h.title}】${h.content.slice(0, 1200)}`).join("\n")
      );
    }
    if (name === "score_draft") {
      const draft = String(args.draft ?? "").trim();
      if (!draft) return "（参数错误：draft 不能为空。）";
      return await deps.scoreDraft(draft.slice(0, 1000));
    }
    return `（未知工具：${name}。可用工具：search_history / get_profile / score_draft。）`;
  } catch (e) {
    return `（工具执行失败：${(e as Error).message}。）`;
  }
}
