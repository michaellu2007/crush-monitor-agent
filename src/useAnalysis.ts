import { useRef, useState } from "react";
import { incrementalJobs, overviewJob } from "../shared/incremental";
import { computeBaseline } from "../shared/baseline";
import {
  collectEvents,
  boundedContext,
  type MemoryEvent,
} from "../shared/memory";
import {
  RUBRIC,
  requestContextKey,
  type Message,
  type Relation,
  type Overview,
  type LineResult,
  type UserProfile,
  type AnalysisRequest,
  type AnalysisResponse,
} from "../shared/types";
import type { SavedConversation, Trend } from "./storage";
import { buildAnalysisUnits } from "../shared/segments";
import { trivialSkipReason } from "../shared/trivial";
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
// 单个分析请求：fetch + 429/529 退避重试 + 版本与上下文哈希校验。run 与 runScope 共用。
async function postJob(
  job: AnalysisRequest,
  fingerprint: string,
  revision: number,
  signal: AbortSignal,
): Promise<AnalysisResponse> {
  let data: AnalysisResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-model-fingerprint": fingerprint,
      },
      body: JSON.stringify(job),
      signal,
    });
    if ([429, 529].includes(response.status) && attempt < 3) {
      await pause(
        Math.min(
          60000,
          Number(response.headers.get("retry-after") || 2 ** attempt) * 1000,
        ),
        signal,
      );
      continue;
    }
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "分析失败");
    data = body;
    break;
  }
  if (!data || data.revision !== revision || data.rubricVersion !== RUBRIC)
    throw new Error("分析版本不匹配，请刷新重试");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestContextKey(job)),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== data.contextHash)
    throw new Error("分析上下文不匹配，请重试");
  return data;
}

export function useAnalysis() {
  const [modelFingerprint, setModelFingerprint] = useState("");
  const modelRef = useRef("");
  const [overview, setOverview] = useState<Overview | null>(null),
    [overviewFresh, setOverviewFresh] = useState(false),
    [lines, setLines] = useState<Record<string, LineResult>>({}),
    [events, setEvents] = useState<Record<string, MemoryEvent>>({}),
    [trend, setTrend] = useState<Trend[]>([]),
    [status, setStatus] = useState<"idle" | "loading" | "complete" | "error">(
      "idle",
    ),
    [error, setError] = useState(""),
    [progress, setProgress] = useState({
      done: 0,
      total: 0,
      active: [] as string[],
    }),
    [latency, setLatency] = useState(0),
    [analyzedCount, setAnalyzedCount] = useState(0);
  const [history, setHistory] = useState<{
    points: {
      label: string;
      count: number;
      affinity: number | null;
      stage: string;
      action: string;
    }[];
    done: number;
    total: number;
    running: boolean;
    error: string;
  }>({ points: [], done: 0, total: 0, running: false, error: "" });
  const notesRef = useRef("");
  const labelRef = useRef("");
  const profileRef = useRef<UserProfile | undefined>(undefined);
  const rev = useRef(0),
    controller = useRef<AbortController | null>(null),
    base = useRef<{ messages: Message[]; relation: Relation } | null>(null),
    savedLines = useRef(lines),
    savedEvents = useRef(events),
    processed = useRef(0);
  function cancel() {
    rev.current++;
    controller.current?.abort();
    setHistory((h) => (h.running ? { ...h, running: false } : h));
    setStatus("idle");
  }
  function reset() {
    cancel();
    base.current = null;
    savedLines.current = {};
    savedEvents.current = {};
    processed.current = 0;
    setLines({});
    setEvents({});
    setTrend([]);
    setOverview(null);
    setOverviewFresh(false);
    setHistory({ points: [], done: 0, total: 0, running: false, error: "" });
    setError("");
    setLatency(0);
    setAnalyzedCount(0);
  }
  function restore(s: SavedConversation) {
    reset();
    base.current = { messages: s.messages, relation: s.relation };
    if (s.rubric !== RUBRIC) return;
    modelRef.current = s.modelFingerprint || "";
    setModelFingerprint(modelRef.current);
    savedLines.current = s.lines;
    savedEvents.current = s.events;
    processed.current = s.analyzedCount;
    setLines(s.lines);
    setEvents(s.events);
    setTrend(s.trend);
    setOverview(s.overview);
    setOverviewFresh(s.completed);
    setAnalyzedCount(s.analyzedCount);
    setStatus(s.completed ? "complete" : "idle");
  }
  // Segmented history backfill: newest month first, chronological within each
  // segment; per-segment overview is judged standalone (no cross-segment memory).
  async function runSegments(messages: Message[], relation: Relation) {
    const revision = ++rev.current;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setStatus("loading");
    setError("");
    let fingerprint = "";
    try {
      const response = await fetch("/api/health", { signal: ctrl.signal });
      const health = await response.json();
      if (!response.ok || !health.configured)
        throw new Error("请先在模型设置中填写 Key 并检测连接。");
      if (rev.current !== revision) return;
      fingerprint = health.fingerprint;
    } catch (e) {
      if (rev.current === revision) {
        setStatus("error");
        setError((e as Error).message);
      }
      return;
    }
    const chunks = buildAnalysisUnits(messages);
    const points: {
      label: string;
      count: number;
      affinity: number | null;
      stage: string;
      action: string;
    }[] = [];
    const empty = { points, done: 0, total: chunks.length, running: true, error: "" };
    setHistory(empty);
    for (const seg of [...chunks].reverse()) {
      if (rev.current !== revision) return;
      const job = overviewJob(seg.messages, relation, revision, {});
      try {
        let data: AnalysisResponse | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          const response = await fetch("/api/analyze", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-model-fingerprint": fingerprint,
            },
            body: JSON.stringify(job),
            signal: ctrl.signal,
          });
          if ([429, 529].includes(response.status) && attempt < 3) {
            await pause(
              Math.min(
                60000,
                Number(response.headers.get("retry-after") || 2 ** attempt) *
                  1000,
              ),
              ctrl.signal,
            );
            continue;
          }
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "分析失败");
          data = body;
          break;
        }
        if (!data || data.rubricVersion !== RUBRIC)
          throw new Error("分析版本不匹配，请刷新重试");
        const o = data.overview;
        points.push({
          label: seg.label,
          count: seg.messages.length,
          affinity: o?.affinity.value ?? null,
          stage: o?.stage ?? "unknown",
          action: o?.action ?? "insufficient",
        });
      } catch (e) {
        if (!ctrl.signal.aborted) {
          const msg = (e as Error).message;
          setHistory((h) => ({ ...h, running: false, error: msg }));
          setStatus("error");
          setError(msg);
        }
        return;
      }
      setHistory({
        points: [...points],
        done: points.length,
        total: chunks.length,
        running: true,
        error: "",
      });
    }
    setHistory((h) => ({ ...h, running: false }));
    setStatus("complete");
  }
  async function run(
    messages: Message[],
    relation: Relation,
    notes?: string,
    relationLabel?: string,
    profile?: UserProfile,
  ) {
    if (notes !== undefined) notesRef.current = notes;
    if (relationLabel !== undefined) labelRef.current = relationLabel;
    // 实测基线：每次 run 用全量 messages 现算（纯函数、可重算、不落盘），
    // 并进画像随所有任务下发——逐条任务里"嗯嗯/哈哈"类短消息的题目要引用它。
    const { baseline: staleBaseline, ...profileRest } =
      profile !== undefined ? profile : (profileRef.current ?? {});
    const freshBaseline = computeBaseline(messages);
    profileRef.current =
      Object.keys(profileRest).length || freshBaseline
        ? { ...profileRest, ...(freshBaseline ? { baseline: freshBaseline } : {}) }
        : undefined;
    const revision = ++rev.current;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const started = performance.now();
    setStatus("loading");
    setError("");
    setOverviewFresh(false);
    let fingerprint = "",
      llm = false;
    try {
      const response = await fetch("/api/health", { signal: ctrl.signal });
      const health = await response.json();
      if (!response.ok || !health.configured)
        throw new Error("请先在模型设置中填写 Key 并检测连接。");
      if (rev.current !== revision) return;
      fingerprint = health.fingerprint;
      llm = health.engine === "llm";
      // 模型变更（如本地/云端切换）不再清空已有分析：旧结果保留，新分析用新模型继续。
      modelRef.current = fingerprint;
      setModelFingerprint(fingerprint);
    } catch (e) {
      if (rev.current === revision) {
        setStatus("error");
        setError((e as Error).message);
      }
      return;
    }
    const previous = base.current;
    const append =
      !!previous &&
      previous.relation === relation &&
      previous.messages.length <= messages.length &&
      previous.messages.every(
        (m, i) =>
          m.id === messages[i].id &&
          m.sender === messages[i].sender &&
          m.text === messages[i].text &&
          m.timestamp === messages[i].timestamp,
      );
    const changed = !append || messages.length !== processed.current;
    let nextLines: Record<string, LineResult> = append
      ? { ...savedLines.current }
      : {};
    let nextEvents: Record<string, MemoryEvent> = append
      ? { ...savedEvents.current }
      : {};
    if (!append) {
      setTrend([]);
      setOverview(null);
      processed.current = 0;
      setAnalyzedCount(0);
    }
    savedEvents.current = nextEvents;
    setEvents(nextEvents);
    base.current = { messages, relation };
    for (const m of messages) {
      if (m.kind !== "text") continue;
      if (Array.from(m.text).length > 12000) {
        nextLines[m.id] = {
          id: m.id,
          skipped: "单条超过12,000字，已保存，请拆分后分析",
          score: {
            value: null,
            confidence: 0,
            status: "insufficient",
            probabilities: {},
          },
        };
        continue;
      }
      const trivial = trivialSkipReason(m.text);
      if (trivial)
        nextLines[m.id] = {
          id: m.id,
          skipped: trivial,
          score: {
            value: null,
            confidence: 0,
            status: "insufficient",
            probabilities: {},
          },
        };
    }
    setLines(nextLines);
    savedLines.current = nextLines;
    const jobs = incrementalJobs(
      messages,
      relation,
      revision,
      nextLines,
      nextEvents,
      changed,
      undefined,
      profileRef.current,
    );
    if (!append) jobs.reverse();
    const first = overviewJob(
      messages,
      relation,
      revision,
      nextEvents,
      notesRef.current,
      labelRef.current,
      profileRef.current,
    );
    if (!first.messages.length) {
      setStatus("error");
      setError("记录已保存，但没有可分析的文字。单条过长的消息请拆分。");
      return;
    }
    let failed = 0,
      done = 0;
    // 双 worker 并发时追踪所有在算的消息，供 UI 区分"分析中/排队中"
    const inflight = new Map<string, number>();
    setProgress({ done: 0, total: jobs.length + (llm ? 1 : 2), active: [] });
    async function execute(job: AnalysisRequest) {
      const data = await postJob(job, fingerprint, revision, ctrl.signal);
      if (rev.current !== revision) return;
      if (data.overview) {
        setOverview(data.overview);
        setLatency(Math.round(performance.now() - started));
      }
      const added = Object.fromEntries(
        (data.lines ?? []).map((l) => [l.id, l]),
      );
      nextLines = { ...nextLines, ...added };
      nextEvents = collectEvents(added, nextEvents);
      for (const update of data.memoryUpdates ?? []) {
        const old = nextEvents[update.id];
        if (old)
          nextEvents[update.id] = {
            ...old,
            status: update.status,
            resolvedBy:
              update.status === "resolved"
                ? (update.evidenceId ?? undefined)
                : update.status === "uncertain"
                  ? old.resolvedBy
                  : undefined,
          };
      }
      savedLines.current = nextLines;
      savedEvents.current = nextEvents;
      setLines(nextLines);
      setEvents(nextEvents);
      return data;
    }
    async function safely(job: AnalysisRequest) {
      for (const id of job.targetIds)
        inflight.set(id, (inflight.get(id) ?? 0) + 1);
      if (rev.current === revision)
        setProgress((p) => ({ ...p, active: [...inflight.keys()] }));
      try {
        return await execute(job);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          failed++;
          setError((e as Error).message);
        }
      } finally {
        for (const id of job.targetIds) {
          const n = (inflight.get(id) ?? 1) - 1;
          if (n <= 0) inflight.delete(id);
          else inflight.set(id, n);
        }
        done++;
        if (rev.current === revision)
          setProgress((p) => ({
            ...p,
            done,
            active: [...inflight.keys()],
          }));
      }
    }
    // Initial overview is provisional until historical event extraction completes.
    if (!llm) await safely(first);
    async function worker() {
      while (jobs.length && rev.current === revision) {
        const job = jobs.shift()!;
        // Refresh retrieved evidence as earlier chunks finish extracting events.
        const positions = job.targetIds.map((id) =>
          messages.findIndex((m) => m.id === id),
        );
        const firstTarget = Math.min(...positions),
          lastTarget = Math.max(...positions);
        const revised = boundedContext(
          messages,
          Math.max(0, firstTarget - 80),
          job.task === "self_message"
            ? lastTarget + 1
            : Math.min(messages.length, lastTarget + 21),
          nextEvents,
          job.task === "self_message",
        );
        // Keep deliberately retrieved distant corrections paired with the newest context.
        if (job.memory?.some((e) => job.targetIds.includes(e.id)))
          await safely(job);
        else if (
          job.targetIds.every((id) => revised.messages.some((m) => m.id === id))
        )
          await safely({ ...job, ...revised });
        else await safely(job);
      }
    }
    await Promise.all([worker(), worker()]);
    if (rev.current !== revision) return;
    const final = await safely(
      overviewJob(
        messages,
        relation,
        revision,
        nextEvents,
        notesRef.current,
        labelRef.current,
        profileRef.current,
      ),
    );
    if (rev.current !== revision) return;
    setOverviewFresh(!!final?.overview && !failed);
    setStatus(failed ? "error" : "complete");
    if (final?.overview && !failed) {
      processed.current = messages.length;
      setAnalyzedCount(messages.length);
      setTrend((old) => {
        const point = {
          at: new Date().toISOString(),
          value: final.overview!.affinity.value,
          count: messages.length,
        };
        return old.at(-1)?.count === point.count
          ? [...old.slice(0, -1), point]
          : [...old, point];
      });
    }
  }
  // 板块/勾选范围分析：只补范围内未评级的消息；评分上下文仍取完整会话（前80/后20）。
  // force=true 时绕过"已分析跳过"，强制覆盖指定消息的现有结果（重新分析）。
  // 不动总览/趋势/analyzedCount——范围运行只增逐条结果，结束恢复原状态。
  async function runScope(
    messages: Message[],
    relation: Relation,
    scopeMessages: Message[],
    force = false,
  ) {
    const revision = ++rev.current;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const prevStatus = status === "error" ? "idle" : status;
    setStatus("loading");
    setError("");
    let fingerprint = "";
    try {
      const response = await fetch("/api/health", { signal: ctrl.signal });
      const health = await response.json();
      if (!response.ok || !health.configured)
        throw new Error("请先在模型设置中填写 Key 并检测连接。");
      if (rev.current !== revision) return;
      fingerprint = health.fingerprint;
    } catch (e) {
      if (rev.current === revision) {
        setStatus("error");
        setError((e as Error).message);
      }
      return;
    }
    if (!base.current) base.current = { messages, relation };
    const scope = new Set(scopeMessages.map((m) => m.id));
    const jobs = incrementalJobs(
      messages,
      relation,
      revision,
      savedLines.current,
      savedEvents.current,
      false,
      scope,
      profileRef.current,
      force,
    );
    setProgress({ done: 0, total: jobs.length, active: [] });
    let done = 0;
    const inflight = new Set<string>();
    for (const job of jobs) {
      if (rev.current !== revision) return;
      for (const id of job.targetIds) inflight.add(id);
      setProgress((p) => ({ ...p, active: [...inflight] }));
      try {
        const data = await postJob(job, fingerprint, revision, ctrl.signal);
        if (rev.current !== revision) return;
        const added = Object.fromEntries(
          (data.lines ?? []).map((l) => [l.id, l]),
        );
        const nextLines = { ...savedLines.current, ...added };
        savedLines.current = nextLines;
        setLines(nextLines);
        const nextEvents = collectEvents(added, savedEvents.current);
        savedEvents.current = nextEvents;
        setEvents(nextEvents);
      } catch (e) {
        if (!ctrl.signal.aborted) setError((e as Error).message);
      } finally {
        for (const id of job.targetIds) inflight.delete(id);
        done++;
        setProgress((p) => ({ ...p, done, active: [...inflight] }));
      }
    }
    if (rev.current !== revision) return;
    setStatus(prevStatus);
  }
  return {
    modelFingerprint,
    overview,
    overviewFresh,
    lines,
    events,
    trend,
    status,
    error,
    progress,
    analyzedCount,
    history,
    run,
    runScope,
    runSegments,
    cancel,
    reset,
    restore,
  };
}
