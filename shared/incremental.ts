import { boundedContext, relevantEvents, type MemoryEvent } from "./memory";
import { buildAnalysisUnits } from "./segments";
import { trivialSkipReason } from "./trivial";
import type {
  Message,
  Relation,
  LineResult,
  AnalysisRequest,
  UserProfile,
} from "./types";
export function incrementalJobs(
  messages: Message[],
  relation: Relation,
  revision: number,
  lines: Record<string, LineResult>,
  events: Record<string, MemoryEvent>,
  changed: boolean,
  scope?: Set<string>,
  userProfile?: UserProfile,
  force?: boolean,
): AnalysisRequest[] {
  // 板块/勾选范围运行不做全局重刷：只补范围内的缺失评级。
  const recentIds = new Set(
    !scope && changed
      ? messages
          .slice(-20)
          .filter((m) => m.sender === "other")
          .map((m) => m.id)
      : [],
  );
  const jobs: AnalysisRequest[] = [];
  if (!scope && changed) {
    const historical = boundedContext(
      messages,
      Math.max(0, messages.length - 100),
      messages.length,
      events,
    );
    for (const e of relevantEvents(messages, events, messages.slice(-20)).slice(
      0,
      4,
    )) {
      if (
        historical.messages.some((m) => m.id === e.id && m.sender === "other")
      )
        jobs.push({
          task: "other_messages",
          targetIds: [e.id],
          ...historical,
          revision,
          relation,
          ...(userProfile ? { userProfile } : {}),
        });
    }
  }

  // 无 scope：只补最近活跃单元（体量自适应），已评级绝不重跑。逐条评分的判官请求
  // ≈ 0.6×消息数，主入口若全量补齐老历史，一次点击就是上千请求（实测 2000 条会话
  // → 402 任务）；更早的未分析消息走消息上的板块按钮或「分析勾选」（scope 无此限制）。
  // scope（话题板块/勾选）：目标限定在该范围，上下文仍取自完整会话（前80/后20），
  // 板块边界不截断语境。
  const units = scope ? null : buildAnalysisUnits(messages);
  const recentStart = units
    ? messages.length - units.at(-1)!.messages.length
    : 0;
  const inScope = (m: Message) => !scope || scope.has(m.id);
  for (let start = recentStart; start < messages.length;) {
    let end = start,
      chars = 0;
    while (end < messages.length && end - start < 10) {
      const n = Array.from(messages[end].text).length;
      if (end > start && chars + n > 1500) break;
      chars += n;
      end++;
    }
    for (const sender of ["other", "self"] as const) {
      const targets = messages
        .slice(start, end)
        .filter(
          (m) =>
            inScope(m) &&
            m.sender === sender &&
            m.kind === "text" &&
            Array.from(m.text).length <= 12000 &&
            !trivialSkipReason(m.text) &&
            (!lines[m.id] || recentIds.has(m.id) || (force && !!scope)),
        );
      if (!targets.length) continue;
      const lastIndex = messages.findIndex((m) => m.id === targets.at(-1)!.id);
      // Revisit counterparts with a little later context; never expose future text to self ratings.
      const contextEnd =
        sender === "self" ? lastIndex + 1 : Math.min(messages.length, end + 20);
      const context = boundedContext(
        messages,
        Math.max(0, start - 80),
        contextEnd,
        events,
        sender === "self",
      );
      // Long contexts may omit early targets. Split those into individual bounded jobs.
      for (const target of targets.filter(
        (m) => !context.messages.some((c) => c.id === m.id),
      )) {
        const i = messages.findIndex((m) => m.id === target.id);
        jobs.push({
          task: sender === "self" ? "self_message" : "other_messages",
          targetIds: [target.id],
          ...boundedContext(messages, Math.max(0, i - 80), i + 1, events, true),
          revision,
          relation,
          ...(userProfile ? { userProfile } : {}),
        });
      }
      const ids = targets
        .filter((m) => context.messages.some((c) => c.id === m.id))
        .map((m) => m.id);
      if (ids.length)
        jobs.push({
          task: sender === "self" ? "self_message" : "other_messages",
          targetIds: ids,
          ...context,
          revision,
          relation,
          ...(userProfile ? { userProfile } : {}),
        });
    }
    start = end;
  }
  return jobs.reverse();
}
export function overviewJob(
  messages: Message[],
  relation: Relation,
  revision: number,
  events: Record<string, MemoryEvent>,
  contextNotes?: string,
  relationLabel?: string,
  userProfile?: UserProfile,
): AnalysisRequest {
  return {
    task: "overview",
    targetIds: [],
    revision,
    relation,
    ...(contextNotes ? { contextNotes } : {}),
    ...(userProfile ? { userProfile } : {}),
    ...(relationLabel ? { relationLabel } : {}),
    ...boundedContext(
      messages,
      Math.max(0, messages.length - 100),
      messages.length,
      events,
    ),
  };
}
