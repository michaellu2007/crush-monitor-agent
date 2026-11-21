import { ModelSettings } from "./ModelSettings";
import { MODEL_PRESETS, type PublicSettings } from "../shared/model-presets";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  loadConversation,
  saveConversation,
  listConversations,
  getLastConvId,
  setLastConvId,
  type SavedConversation,
  type ConversationSummary,
} from "./storage";
import { INTENTS, topIntents } from "../shared/intents";
import { REPLY_RATINGS, replyRating } from "../shared/ratings";
import { EMOTIONS, TARGETS, topEmotions, topTargets } from "../shared/labels";
import {
  chatWillingness,
  gapMsBetween,
  messageWillingness,
  WILLINGNESS_LABELS,
} from "../shared/willingness";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  Heart,
  MoreHorizontal,
  X,
  ArrowUpRight,
  RotateCcw,
  Settings,
  Sparkles,
  ArrowUp,
  ListChecks,
  Bell,
  Search,
  FolderOpen,
  ArrowRight,
  Send,
  Check,
  Power,
  MessageSquarePlus,
  Archive,
  BookOpen,
  Pencil,
} from "lucide-react";
import { parseChat, toMessages, mergeMessages } from "../shared/parser";
import { parseAdvCommand, ADV_COMMAND_HELP } from "../shared/adv-commands";
import { AdvMarkdown } from "./adv-md";
import { shouldCheck } from "../shared/live-check";
import { MBTI_TYPES } from "../shared/mbti";
import { calibrationSummary } from "../shared/calibration";
import {
  classifyMedia,
  MEDIA_LABELS,
  MEDIA_ICONS,
  MEDIA_PLACEHOLDERS,
  stickerIconFor,
  type MediaInfo,
} from "../shared/media";
import {
  RUBRIC,
  ACTIONS,
  RELATIONS,
  STAGES,
  statusLabel,
  meanQuality,
  type Message,
  type Relation,
  type Parsed,
  type UserProfile,
  type DialogSummary,
} from "../shared/types";
import { exampleText } from "../shared/fixtures";
import { useAnalysis } from "./useAnalysis";
import { currentAction } from "../shared/action";
import { buildAnalysisUnits, buildTopics } from "../shared/segments";
import { computeBaseline, describeBaseline } from "../shared/baseline";
import {
  aggregateValence,
  summarizeValence,
  type ValencePoint,
} from "../shared/valence";

function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),select,textarea,input",
          ) || [],
        );
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="关闭" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

// 媒体消息（图片/链接等）加载时归一化：老会话里被当作文本的 [图片] 补上
// kind/media，逐条评分和「全选」等文本过滤器即自动跳过它们。
function normalizeMedia(m: Message): Message {
  if (m.kind !== "text") return m;
  const media = classifyMedia(m.text);
  return media
    ? {
        ...m,
        kind: "unreadable",
        media,
        // 链接/文件保留标题文字（AI 与 UI 都用得上），纯媒体换成短占位符
        text:
          media.type === "link" || media.type === "file"
            ? m.text
            : MEDIA_PLACEHOLDERS[media.type],
      }
    : m;
}
// 媒体占位卡片：微信图片/表情带 md5 时直显真实图片（解密文件就绪后生效，
// 404 时自动回落图标）；链接显示标题并可直接打开；本机路径点击复制。
function MediaBubble({ m }: { m: Message }) {
  const [imgOk, setImgOk] = useState(true);
  const media: MediaInfo | undefined = m.media ?? classifyMedia(m.text) ?? undefined;
  const type = media?.type ?? "unsupported";
  const address = media?.address;
  const md5Only =
    type === "image" || type === "sticker"
      ? (address?.split("/").pop() ?? "")
      : "";
  // 表情包：md5 → emoticon.db 的 cdn_url 下载缓存（服务端）；图片：解密文件路径
  let mediaUrl: string | null = null;
  if (type === "sticker" && /^[0-9a-f]{32}$/i.test(md5Only)) {
    mediaUrl = "/api/wechat/media?md5=" + md5Only;
  } else if (
    (type === "image" || type === "sticker") &&
    address &&
    /^[0-9a-f]{32}\/\d{4}-\d{2}\/[0-9a-f]{32}$/i.test(address)
  ) {
    mediaUrl = "/api/wechat/media?f=" + encodeURIComponent(address);
  }
  const icon = type === "sticker" ? stickerIconFor(md5Only) : MEDIA_ICONS[type];
  const imgHash = /^[0-9a-f]{32}$/i.test(md5Only) ? md5Only.slice(0, 8) : "";
  const linkTitle =
    type === "link" ? m.text.replace(/^\[链接\]\s*/, "").trim() : "";
  const isHttp = /^https?:\/\//i.test(address ?? "");
  return (
    <span className="media-chip">
      {mediaUrl && imgOk ? (
        <img
          className="media-img"
          src={mediaUrl}
          loading="lazy"
          alt={MEDIA_LABELS[type]}
          onError={() => setImgOk(false)}
        />
      ) : (
        <>
          <span aria-hidden>{icon}</span>
          {isHttp ? (
            <a
              className="media-address"
              href={address}
              target="_blank"
              rel="noreferrer noopener"
              title={address}
            >
              {linkTitle || address}
            </a>
          ) : linkTitle || (address && !imgHash) ? (
            <span className="media-title">{linkTitle || address}</span>
          ) : (
            <span>{MEDIA_LABELS[type]}</span>
          )}
          {imgHash && <span className="media-hash">{imgHash}</span>}
        </>
      )}
    </span>
  );
}
// 情绪水位迷你曲线：points 已降采样，viewBox 100×28 由 CSS 拉伸到容器宽。
//  Basline 50 是中性水位；path 用 non-scaling-stroke，拉多宽线都不变形。
function ValenceSpark({ points }: { points: ValencePoint[] }) {
  const w = 100,
    h = 28;
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const y = (level: number) => h - (level / 100) * h;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(2)} ${y(p.level).toFixed(2)}`)
    .join("");
  return (
    <svg
      className="valence-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="对方情绪水位曲线"
    >
      <line x1="0" y1={y(50)} x2={w} y2={y(50)} className="valence-spark-base" />
      <path
        d={d}
        fill="none"
        className="valence-spark-line"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
// 曲线点降采样到 ≤65 个：首尾必留，中间等距取，形状不失真。
function sparkPoints(points: ValencePoint[]): ValencePoint[] {
  if (points.length <= 65) return points;
  const out: ValencePoint[] = [];
  const stride = (points.length - 1) / 64;
  for (let i = 0; i < 64; i++) {
    const idx = Math.round(i * stride);
    if (idx >= points.length - 1) break;
    out.push(points[idx]);
  }
  out.push(points.at(-1)!);
  return out;
}
export default function App() {
  const a = useAnalysis();
  const [modelConfig, setModelConfig] = useState<PublicSettings | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [appExiting, setAppExiting] = useState(false);
  const [judgeHint, setJudgeHint] = useState<
    { baseUrl: string; model: string } | undefined
  >(undefined);
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((s) => {
        setModelConfig(s);
        if (!s.configured) setModelOpen(true);
      })
      .catch(() => setNotice("模型设置读取失败，请确认本机服务运行后刷新。"));
  }, []);
  const [messages, setMessages] = useState<Message[]>([]),
    [input, setInput] = useState(""),
    [self, setSelf] = useState(""),
    [other, setOther] = useState("Crush"),
    [relation, setRelation] = useState<Relation>("crush");
  const [raw, setRaw] = useState(""),
    [parsed, setParsed] = useState<Parsed[]>([]),
    [role, setRole] = useState(""),
    [importing, setImporting] = useState(false),
    [settings, setSettings] = useState(false),
    [detail, setDetail] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [overlap, setOverlap] = useState<Message[] | null>(null);
  const [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState("");
  const convId = useRef("current");
  const contactRef = useRef("");
  const [notes, setNotes] = useState("");
  const [profile, setProfile] = useState<UserProfile>({});
  // 长期画像（data/profiles/<contactId>.json）：切会话时拉取，随顾问请求注入
  const [contactProfile, setContactProfile] = useState<unknown>(null);
  const [relationCustom, setRelationCustom] = useState("");
  const [advLog, setAdvLog] = useState<{role:"user"|"assistant";content:string;ts?:number}[]>([]);
  // D1 摘要冻结：服务端压缩事件产物本地缓存，随下轮请求带回（两次压缩事件之间
  // 消息数组 append-only，GLM 隐式前缀缓存才能命中）；换联系人/清空时一并重置
  const [advSummary, setAdvSummary] = useState<DialogSummary | null>(null);
  // 会话代际守卫：清空/切换联系人/新建都 ++，在途响应回来时代际不匹配就整体丢弃——
  // 防止发送中点"新建"后被旧响应把旧对话连同旧摘要复活（bug 复盘 2026-11-15）
  const advEpoch = useRef(0);
  // 交互模式：manual=勾选记录（默认）；auto=顾问自己用 search_history 检索，不用勾选。
  // 记忆在 localStorage；/mode 指令与状态条点击切换
  const [advMode, setAdvMode] = useState<"manual" | "auto">(() =>
    localStorage.getItem("advMode") === "auto" ? "auto" : "manual",
  );
  // 界面主题（照搬 DeepSeek-Reasonix 外观模型）：底色恒中性（浅=白、深=中性灰黑），
  // 风格只表达在点缀色上，深浅两态共用同一组色相。模式（自动/浅色/深色）× 风格正交；
  // 自动跟随系统 prefers-color-scheme。记忆在 localStorage（themeMode/styleMode），
  // index.html 首帧前挂根属性防闪白，系统深浅切换由下方 matchMedia 监听实时跟手
  const [styleMode, setStyleMode] = useState<"black" | "ink" | "wechat" | "dusk" | "plum" | "amber">(() => {
    const s = localStorage.getItem("styleMode");
    return s === "black" || s === "ink" || s === "wechat" || s === "dusk" || s === "plum" || s === "amber" ? s : "wechat";
  });
  const [themeMode, setThemeMode] = useState<"auto" | "light" | "dark">(() => {
    const m = localStorage.getItem("themeMode");
    if (m === "auto" || m === "light" || m === "dark") return m;
    // 旧版：styleMode=white 即浅色（点缀走默认绿）、深色风格即深色，升级后外观不变；全新用户按自动
    const s = localStorage.getItem("styleMode");
    return s ? (s === "white" ? "light" : "dark") : "auto";
  });
  const THEME_META: {
    id: "black" | "ink" | "wechat" | "dusk" | "plum" | "amber";
    name: string;
    tag: string;
    desc: string;
    accent: string;
  }[] = [
    { id: "black", name: "黑白", tag: "利落", accent: "linear-gradient(120deg, #b3bcb6, #7e858d)", desc: "中性深底配灰阶点缀，零彩色干扰，适合纯文字专注。" },
    { id: "ink", name: "墨绿", tag: "沉稳", accent: "linear-gradient(120deg, #7fc79a, #3f5c4b)", desc: "灰绿点缀：按钮、选中与高亮走灰绿，底色保持中性。" },
    { id: "wechat", name: "微信绿", tag: "经典", accent: "linear-gradient(120deg, #4ade80, #129b56)", desc: "经典微信绿气泡与品牌绿点缀，原来默认的样子。" },
    { id: "dusk", name: "暮蓝", tag: "专注", accent: "linear-gradient(120deg, #7fa7e8, #3d5480)", desc: "蓝色点缀，描边清晰，适合高密度扫读。" },
    { id: "plum", name: "紫罗兰", tag: "温润", accent: "linear-gradient(120deg, #b69ae0, #54406e)", desc: "紫色点缀，温润呼吸感，夜间不刺眼。" },
    { id: "amber", name: "琥珀", tag: "暖阳", accent: "linear-gradient(120deg, #de7a4b, #d4632f)", desc: "琥珀橙点缀，暖而不腻，深浅两态都亮眼。" },
  ];
  const sysDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  const applyAppearance = (m: "auto" | "light" | "dark", style: "black" | "ink" | "wechat" | "dusk" | "plum" | "amber") => {
    const dark = m === "dark" || (m === "auto" && sysDark);
    localStorage.setItem("themeMode", m);
    localStorage.setItem("styleMode", style);
    document.documentElement.dataset.mode = dark ? "dark" : "white";
    document.documentElement.dataset.style = style;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#0c0d10" : "#ffffff");
    setThemeMode(m);
    setStyleMode(style);
  };
  // 自动模式跟随系统深浅切换实时跟手
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (themeMode === "auto") applyAppearance("auto", styleMode);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode, styleMode]);
  // 消息框选模型的供应商筛选（2026-11-19）：先选供应商、再选该家模型；""=跟随当前模型的供应商
  const [advProv, setAdvProv] = useState("");
  // 模型设置里换了顾问模型/供应商 → 筛选切回新模型的供应商，否则下拉停在旧供应商、显示"选择模型…"假性未选
  useEffect(() => {
    setAdvProv("");
  }, [modelConfig?.baseUrl, modelConfig?.model]);
  // /goal 会话目标：随每轮注入 prompt，/goal clear 清除；随会话持久化
  const [advGoal, setAdvGoal] = useState("");
  // 流式接收（2026-11-18）：SSE 增量 reasoning/note/content，done 后并入 advLog
  const [advStream, setAdvStream] = useState<{
    reasoning: string;
    content: string;
    notes: string[];
  } | null>(null);
  // 归档浏览器（2026-11-18 改版）：列表+改名+新建收进头部「对话列表」下拉菜单（advMenu），
  // 消息区只负责回看内容——advViewIdx=null=当前对话，n=第 n 个归档的只读回看
  const [advArchive, setAdvArchive] = useState<
    { title?: string; log: { role: "user" | "assistant"; content: string; ts?: number }[]; summary: DialogSummary | null; goal?: string; at: number; endedAt?: string }[] | null
  >(null);
  const [advViewIdx, setAdvViewIdx] = useState<number | null>(null);
  // 对话列表下拉菜单（对标 agent客户端的会话菜单：新建/归档/改名一个入口收纳）
  const [advMenu, setAdvMenu] = useState(false);
  const [advSel, setAdvSel] = useState<Set<string>>(new Set());
  const [advInput, setAdvInput] = useState("");
  // 指令联想：输入以 / 或 @ 开头时弹出可选指令（此前只能凭记忆敲 /help 才知道有哪些）
  const [advCmdHint, setAdvCmdHint] = useState<string | null>(null);
  const advCmdItems = ADV_COMMAND_HELP.split("\n").map((l) => {
    const [cmd, desc] = l.split(" —— ");
    return { word: cmd.split(" ")[0], full: cmd, desc };
  });
  function fillAdvCmd(full: string) {
    // 带参数占位的指令补全后留空格等输入，其余直接就位
    setAdvInput(full.includes("<") ? full.split(" ")[0] + " " : full.split(" ")[0]);
    setAdvCmdHint(null);
    document.querySelector<HTMLTextAreaElement>(".adv-textarea")?.focus();
  }
  const [advBusy, setAdvBusy] = useState(false);
  const [advOpen, setAdvOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth > 980,
  );
  const [selectMode, setSelectMode] = useState(false);
  // 用户自配知识库（2026-11-18）：聊天设置弹窗内编辑，PUT /api/knowledge 整表保存；
  // 顾问 search_knowledge 工具检索（有条目即启用工具循环，无需勾选聊天记录）
  const [kb, setKb] = useState<
    { id: string; title: string; content: string; updatedAt: string }[] | null
  >(null);
  const [kbBusy, setKbBusy] = useState(false);
  const [kbMsg, setKbMsg] = useState("");
  // 归档默认命名：首问前 40 字（服务端 normalize 同口径兜底）
  function firstQOf(
    log: { role: string; content: string }[],
  ): string {
    return (log.find((d) => d.role === "user")?.content ?? "").slice(0, 40);
  }
  // 微信式整块勾选（2026-11-18）：点消息气泡任意位置切换选中，小框不再是唯一入口
  function toggleAdvSel(id: string) {
    setAdvSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 200) next.add(id);
      return next;
    });
  }
  // 顾问会话：服务端 data/adv/<convId>.json 单一事实源（随自动保存节奏 PUT，恢复时 GET）。
  // 2026-11-18 修复：saveAdvCurrent 此前定义了却从未被调用（死代码）→ 当前对话退出即丢。
  // 两个防洗数据守卫：
  //  ① advLoaded=false（还没成功读到该 convId 的服务端状态）时禁写——否则启动/切换时
  //     会把 current:null 写回磁盘，覆盖掉已有的对话；读取失败也保持禁写（宁可这轮不存）。
  //  ② 切联系人/新聊天必须在 convId.current 改掉**之前**把当前对话存进旧 convId，
  //     否则旧联系人的对话会写进新联系人的文件（跨联系人串档）。
  type AdvSnap = {
    log: { role: "user" | "assistant"; content: string; ts?: number }[];
    summary: DialogSummary | null;
    goal: string;
  };
  const advLoaded = useRef(false);
  const advSaveInFlight = useRef<Promise<void> | null>(null);
  const advArchiving = useRef(false);
  // 最新状态走 ref：pagehide 等 [] 依赖 effect 里也能拿到未过期的对话
  const advStateRef = useRef<AdvSnap>({ log: [], summary: null, goal: "" });
  advStateRef.current = { log: advLog, summary: advSummary, goal: advGoal };
  // 上次成功落盘的快照：只在顾问状态真的变了才 PUT（避免聊天分析的高频 effect 空转写盘）
  const lastSavedAdv = useRef<AdvSnap | null>(null);
  function saveAdvCurrent(target: string = convId.current): Promise<void> {
    if (!advLoaded.current) return Promise.resolve(); // 守卫①
    const snap = advStateRef.current;
    const p = fetch(`/api/adv/${encodeURIComponent(target)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current: snap.log.length
          ? {
              log: snap.log,
              summary: snap.summary,
              goal: snap.goal || undefined,
              at: snap.log[0]?.ts ?? Date.now(),
            }
          : null,
      }),
    })
      .then(() => undefined)
      .catch(() => {});
    advSaveInFlight.current = p;
    return p;
  }
  async function loadAdvState(id: string) {
    const epoch = ++advEpoch.current; // 换会话：在途响应作废（含旧 convId 的迟到响应）
    advLoaded.current = false; // 读到之前禁写（守卫①）
    try {
      if (advSaveInFlight.current) await advSaveInFlight.current; // 同 convId：先等写完再读
      if (epoch !== advEpoch.current) return;
      const r = await fetch(`/api/adv/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error("顾问会话读取失败");
      const b = await r.json();
      if (epoch !== advEpoch.current) return;
      const cur = b.current;
      const snap: AdvSnap = {
        log: cur?.log ?? [],
        summary: cur?.summary ?? null,
        goal: cur?.goal ?? "",
      };
      setAdvLog(snap.log);
      setAdvSummary(snap.summary);
      setAdvGoal(snap.goal);
      lastSavedAdv.current = snap;
      advLoaded.current = id === convId.current; // 迟到的旧会话响应不放行写
    } catch {
      if (epoch !== advEpoch.current) return;
      const empty: AdvSnap = { log: [], summary: null, goal: "" };
      setAdvLog(empty.log);
      setAdvSummary(empty.summary);
      setAdvGoal(empty.goal);
      lastSavedAdv.current = empty;
      // 读取失败保持禁写：不能把 null 写回磁盘覆盖掉没读到的已有对话
      advLoaded.current = false;
    }
  }
  const [renIdx, setRenIdx] = useState<number | null>(null);
  const [renVal, setRenVal] = useState("");
  async function saveRename(i: number) {
    const r = await fetch(
      `/api/adv/${encodeURIComponent(convId.current)}/archive/${i}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: renVal }),
      },
    ).catch(() => null);
    if (r && r.ok) {
      setRenIdx(null);
      openAdvArchive(); // 刷新列表
    } else {
      // 原先写 setKbMsg——那只在知识库弹窗里渲染，用户看到的是"点了没反应"
      setAdvError("归档改名失败，请确认本机服务运行中后重试。");
    }
  }
  function openAdvArchive() {
    fetch(`/api/adv/${encodeURIComponent(convId.current)}`)
      .then((r) => r.json())
      .then((d) => {
        setAdvArchive(d.archived ?? []);
        setRenIdx(null); // 列表刷新后旧的改名行索引会指错条目
      })
      .catch(() => setAdvArchive([]));
  }
  // 知识库：弹窗打开时拉取；编辑在本地副本，保存走 PUT 整表替换
  function openKb() {
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((d) => setKb(d.entries ?? []))
      .catch(() => setKbMsg("知识库读取失败，请确认本机服务运行中。"));
  }
  async function saveKb() {
    if (!kb || kbBusy) return;
    setKbBusy(true);
    setKbMsg("");
    try {
      const r = await fetch("/api/knowledge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: kb }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || "保存失败");
      setKb(b.entries);
      setKbMsg("已保存——顾问涉及约定/偏好类问题会自动检索这里。");
    } catch (e) {
      setKbMsg((e as Error).message);
    } finally {
      setKbBusy(false);
    }
  }
  useEffect(() => {
    if (settings && kb === null) openKb();
  }, [settings, kb]);
  const [delConv, setDelConv] = useState<ConversationSummary | null>(null);
  const [advWidth, setAdvWidth] = useState(460);
  const advDrag = useRef<{ x: number; w: number } | null>(null);
  function startAdvDrag(e: React.MouseEvent) {
    e.preventDefault();
    advDrag.current = { x: e.clientX, w: advWidth };
    const move = (ev: MouseEvent) => {
      if (!advDrag.current) return;
      setAdvWidth(
        Math.min(760, Math.max(360, advDrag.current.w - (ev.clientX - advDrag.current.x))),
      );
    };
    const up = () => {
      advDrag.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  const [wxOpen, setWxOpen] = useState(false);
  const [wxList, setWxList] = useState<
    { user: string; name: string; count: number; last: string }[] | null
  >(null);
  const [wxQuery, setWxQuery] = useState("");
  const [convQuery, setConvQuery] = useState("");
  const [wxBusy, setWxBusy] = useState(false);
  const [wxError, setWxError] = useState("");
  const [wxSel, setWxSel] = useState<Set<string>>(new Set());
  const [wxSyncing, setWxSyncing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hitMsgFlash, setHitMsgFlash] = useState<string | null>(null); // 搜索定位：命中的消息气泡闪绿 2.5s
  const pendingJump = useRef<{ convId: string; msgId: string } | null>(null); // 跨会话跳转：switchTo 完成消息加载后 locateMsg
  function loadWxList() {
    setWxBusy(true);
    setWxError("");
    fetch("/api/wechat/chats")
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) =>
        ok ? setWxList(body.chats) : setWxError(body.error || "读取失败"),
      )
      .catch((e) => setWxError(String(e)))
      .finally(() => setWxBusy(false));
  }
  function openWx() {
    setWxOpen(true);
    if (!wxList) loadWxList();
    fetch("/api/wechat/selection")
      .then((r) => r.json())
      .then((b) =>
        setWxSel(new Set(Array.isArray(b.wxids) ? b.wxids.map(String) : [])),
      )
      .catch(() => {});
  }
  async function syncSelected() {
    if (!wxSel.size) {
      setWxError("先勾选要同步的联系人（可多选）");
      return;
    }
    setWxSyncing(true);
    setWxError("");
    try {
      const w = await fetch("/api/wechat/selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wxids: [...wxSel] }),
      });
      if (!w.ok) throw new Error(((await w.json()).error as string) || "保存选择失败");
      const r = await fetch("/api/wechat/sync", { method: "POST" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || "同步失败");
      setWxOpen(false);
      refreshList();
      if (a.status !== "loading") await reloadCurrentConversation();
      setNotice("已同步 " + wxSel.size + " 个联系人，会话列表已更新");
    } catch (e) {
      setWxError((e as Error).message);
    } finally {
      setWxSyncing(false);
    }
  }
  // ---------- 一键同步微信聊天（含每 5 分钟自动同步开关，与常驻 bat 同节奏） ----------
  const WX_AUTO_KEY = "wx-auto-sync";
  const WX_AUTO_INTERVAL_MS = 5 * 60_000;
  const [syncAllBusy, setSyncAllBusy] = useState(false);
  const [autoSync, setAutoSync] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(WX_AUTO_KEY) === "1",
  );
  const [lastWxSync, setLastWxSync] = useState<string | null>(null);
  const syncAllInFlight = useRef(false);
  async function syncAllWechat(manual: boolean) {
    if (syncAllInFlight.current) return;
    syncAllInFlight.current = true;
    if (manual) setSyncAllBusy(true);
    try {
      const r = await fetch("/api/wechat/sync", { method: "POST" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || "同步失败");
      refreshList();
      setLastWxSync(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      if (manual) setNotice("微信聊天记录已同步，会话已刷新。");
      // 关键：同步更新的是磁盘文件，当前打开的会话不会自己重载——
      // 不刷新的话用户盯着旧消息列表，会以为"同步不到"。
      // 分析进行中不 reload（会 cancel 掉分析）——用 ref 而非闭包里的陈旧 a
      if (!analysisLoadingRef.current) await reloadCurrentConversation();
    } catch (e) {
      const msg = (e as Error).message;
      if (manual) setNotice(`同步失败：${msg}（需要微信处于登录状态）`);
      // 自动同步失败静默——下一轮再试，不打扰
      if (!manual && msg.includes("进行中")) {
        /* 上一次还没跑完，跳过本轮 */
      }
    } finally {
      syncAllInFlight.current = false;
      if (manual) setSyncAllBusy(false);
    }
  }
  /** 从服务器重载当前会话（同步完成后调用）。
   *  与 switchTo 不同：不能 flushSave——那会把同步前的内存旧态写回去覆盖刚同步的文件；
   *  正确顺序是取消防抖保存 → 丢弃 pendingSave → 从磁盘重读 → 触发保存 effect 重建。 */
  async function reloadCurrentConversation() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSave.current = null;
    const rid = convId.current;
    try {
      const saved = await loadConversation(rid);
      // await 期间切了人：旧会话数据写回 UI 会让下一轮 autosave 把 A 的聊天写进 B 的文件（串档）
      if (!saved || saved.schema !== 1 || convId.current !== rid) return;
      contactRef.current = saved.contactId ?? "";
      setNotes(saved.notes ?? "");
      setProfile(saved.userProfile ?? {});
      setRelationCustom(saved.relationLabel ?? "");
      setMessages(saved.messages.map(normalizeMedia));
      setSelf(saved.self ?? "");
      setOther(saved.other);
      setRelation(saved.relation);
      a.cancel();
      a.restore(saved);
      // 同步/重载会用服务端状态覆盖内存里的顾问对话——先把进行中的对话落盘，
      // 否则微信自动同步（每 5 分钟）会把没保存的对话清空（修复 2026-11-18）
      await saveAdvCurrent();
      await loadAdvState(convId.current);
      stay.current = true;
    } catch {
      /* 重载失败静默：下次同步/切换会话会再对齐 */
    }
  }
  // 分析进行中的 ref 镜像：interval 闭包捕获的 a 是陈旧渲染快照，拿它判断是否
  // reload 会砍掉正在跑的分析（2026-11-19 bug 审查 P2）
  const analysisLoadingRef = useRef(false);
  useEffect(() => {
    analysisLoadingRef.current = a.status === "loading";
  }, [a.status]);
  useEffect(() => {
    if (!autoSync) return;
    const t = setInterval(() => void syncAllWechat(false), WX_AUTO_INTERVAL_MS);
    return () => clearInterval(t);
  }, [autoSync]);
  async function wxRefresh() {
    setWxBusy(true);
    setWxError("");
    try {
      const r = await fetch("/api/wechat/refresh", { method: "POST" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || "刷新失败");
      const l = await fetch("/api/wechat/chats");
      const lb = await l.json();
      if (l.ok) setWxList(lb.chats);
    } catch (e) {
      setWxError((e as Error).message);
    } finally {
      setWxBusy(false);
    }
  }
  const [advError, setAdvError] = useState("");
  // 新建顾问对话（2026-11-13）：切联系人/新聊天自动重置之外的手动入口。
  // 上下文模型见 docs/agent对话上下文管理调研.md §6——服务端按 8 轮/70% 窗口预算
  // 自动压缩+段边界切分，这里的"新建"是用户主动放弃当前会话语境的显式手段。
  // 2026-11-18 修复：归档请求此前不看响应状态就清空本地（.catch 静默吞错），
  // 服务端一失败整段对话就无声消失——改为校验 r.ok、成功才清空，失败保留对话并提示。
  async function newAdvSession(): Promise<void> {
    if (advBusy || advArchiving.current) return; // 忙/归档进行中忽略：在途响应带会话代际守卫
    // 创建档案（Electron 无 window.prompt，禁用弹窗输入）：默认命名=首问 40 字，
    // 进面板头部「归档」列表后可随时内联改名（✎ 按钮，PATCH /api/adv/:convId/archive/:idx）
    if (!advLog.length) {
      setAdvViewIdx(null);
      return;
    }
    const payload = {
      current: {
        title: firstQOf(advLog),
        log: advLog,
        summary: advSummary,
        goal: advGoal || undefined,
        at: advLog[0]?.ts ?? Date.now(),
      },
    };
    advArchiving.current = true;
    advEpoch.current++;
    try {
      const r = await fetch(`/api/adv/${encodeURIComponent(convId.current)}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error((b as { error?: string })?.error || `HTTP ${r.status}`);
      }
      setAdvLog([]);
      setAdvSummary(null);
      setAdvGoal("");
      lastSavedAdv.current = { log: [], summary: null, goal: "" }; // 服务端 current 已随归档清空
      setAdvViewIdx(null);
      setRenIdx(null);
      setAdvMenu(false); // 新建即收起菜单；列表若曾打开过则刷新一次，让头部徽标数是新的
      if (advArchive !== null) openAdvArchive();
    } catch (e) {
      setAdvError(`归档失败：${(e as Error).message}。对话仍保留在当前窗口，可稍后重试。`);
    } finally {
      advArchiving.current = false;
    }
  }

  async function sendAdvise(q = advInput.trim()) {
    q = q.trim();
    setAdvCmdHint(null); // 发送后联想弹窗一律收起（回车补全/点按钮/快捷 chip 都走这里）
    if (!q || advBusy) return;
    const cmd = parseAdvCommand(q);
    const note = (text: string) =>
      setAdvLog((prev) => [...prev, { role: "assistant" as const, content: text, ts: Date.now() }]);
    if (cmd.type === "help") {
      note("顾问指令：\n" + ADV_COMMAND_HELP);
      return;
    }
    if (cmd.type === "clear") {
      void newAdvSession();
      return;
    }
    if (cmd.type === "goal") {
      if (cmd.arg === "clear") {
        advEpoch.current++;
        setAdvGoal("");
        note("已清除咨询目标。");
      } else if (cmd.arg) {
        setAdvGoal(cmd.arg);
        note(`目标已设定：${cmd.arg}\n后续回答会围绕它（/goal clear 清除）。`);
      } else note(advGoal ? `当前目标：${advGoal}` : "尚未设定目标（/goal <目标> 设定）。");
      return;
    }
    if (cmd.type === "mode") {
      const next =
        cmd.arg === "auto" || cmd.arg === "manual"
          ? cmd.arg
          : advMode === "auto"
            ? "manual"
            : "auto";
      setAdvMode(next);
      localStorage.setItem("advMode", next);
      note(
        next === "auto"
          ? "已切到自动模式：顾问会自己检索历史聊天，不用勾选记录。"
          : "已切回手动模式：勾选的记录作为上下文（不勾自动带最近 50 条）。",
      );
      return;
    }
    if (cmd.type === "compact") {
      setAdvBusy(true);
      setAdvError("");
      try {
        const r = await fetch("/api/advise/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dialog: advLog,
            ...(advSummary ? { dialogSummary: advSummary } : {}),
          }),
        });
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || "压缩失败");
        if (b.summary) {
          setAdvSummary(b.summary);
          note(`已压缩：早期 ${b.summary.throughCount} 轮并入摘要（上下文更轻了）。`);
        } else note("对话还短（≤8 轮），无需压缩。");
      } catch (e) {
        setAdvError((e as Error).message);
      } finally {
        setAdvBusy(false);
      }
      return;
    }
    const readAll = cmd.type === "readall";
    q = cmd.question;
    const picked = messages
      .filter((m) => advSel.has(m.id))
      .slice(-200)
      .map((m) => ({ sender: m.sender, text: m.text, timestamp: m.timestamp }));
    // 未勾选时自动带上最近 50 条当上下文，少一次手动勾选；
    // auto 模式不喂勾选（顾问自己检索历史，摘选只带最近 10 条作当前语境）；
    // /readall 喂全部（≤200，服务端转写预算再钳）
    const selected = readAll
      ? messages.slice(-200).map((m) => ({
          sender: m.sender,
          text: m.text,
          timestamp: m.timestamp,
        }))
      : advMode === "auto"
        ? messages.slice(-10).map((m) => ({
            sender: m.sender,
            text: m.text,
            timestamp: m.timestamp,
          }))
        : picked.length
          ? picked
          : messages.slice(-50).map((m) => ({
              sender: m.sender,
              text: m.text,
              timestamp: m.timestamp,
            }));
    if (!selected.length) {
      setAdvError("还没有聊天记录可以参考。");
      return;
    }
    setAdvBusy(true);
    setAdvError("");
    const log = [...advLog, { role: "user" as const, content: q, ts: Date.now() }];
    const epoch = advEpoch.current;
    setAdvLog(log);
    setAdvInput("");
    // 打字机状态与停表（catch 里也要能停，声明在 try 外）
    const typer = {
      target: "", shown: 0,
      reasoningTarget: "", reasoningShown: 0,
      finished: false, timer: null as number | null,
    };
    const stopDrain = () => {
      if (typer.timer !== null) {
        clearInterval(typer.timer);
        typer.timer = null;
      }
    };
    try {
      const r = await fetch("/api/advise/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          self: self || "我",
          other,
          relation,
          messages: selected,
          question: q,
          // 交互模式与 /goal 目标（2026-11-18）：auto 注记让顾问先检索历史再答
          mode: advMode,
          ...(advGoal ? { goal: advGoal } : {}),
          // D3：送全量 dialog（本地传输零成本），钳制交给服务端——滑窗丢轮会隐性重写前缀；
          // 兜底 cap 对齐服务端 schema 上限 200，超限即算 hash 不匹配走重摘（低频）；
          // content 硬裁 8000 对齐 schema（R1 长回复进历史后不裁则永久 400，bug 审查 2026-11-17）
          dialog: log
            .slice(0, -1)
            .slice(-200)
            .map((t) => ({ ...t, content: t.content.slice(0, 8000) })),
          // D1：带回冻结摘要，服务端校验覆盖段指纹一致才复用（不重摘、前缀稳定）
          ...(advSummary ? { dialogSummary: advSummary } : {}),
          // 情绪水位摘要（本地聚合，非模型评分）：有曲线才带，省 token
          ...(valenceSummary.points > 0 ? { valenceSummary } : {}),
          // 对方画像（用户标签 + 机器基线）：有内容才带
          ...(profile.mbti || profile.style || profile.recent || baseline
            ? {
                userProfile: {
                  ...(profile.mbti || profile.style || profile.recent
                    ? profile
                    : {}),
                  ...(baseline ? { baseline } : {}),
                },
              }
            : {}),
          // harness 工具作用域：带 contactId 服务端才启用 search_history/get_profile
          ...(contactRef.current ? { contactId: contactRef.current } : {}),
          // 长期画像（data/profiles/，切会话时拉取）
          ...(contactProfile ? { contactProfile } : {}),
        }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error || "顾问调用失败");
      }
      // SSE 读流：reasoning/note/delta 增量渲染，done 落地为正式消息
      // 打字机（2026-11-19）：免费档上游常攒包（整段一次吐出，实测 ernie:free 前等 1.5s 后
      // 11ms 内倒完），本地逐字回放保证任何模型都有流式感；drain 完成才落地正式消息并关流框
      const reader = r.body?.getReader();
      if (!reader) throw new Error("浏览器不支持流式读取，请刷新页面。");
      const decoder = new TextDecoder();
      let buffer = "";
      const acc: { done: { text: string; dialogSummary?: DialogSummary } | null } = { done: null };
      const finalize = () => {
        // 会话代际守卫：发送后用户点了新建/切换联系人 → 本响应作废，不污染新会话
        if (epoch !== advEpoch.current) {
          stopDrain();
          setAdvStream(null);
          return;
        }
        stopDrain();
        setAdvSummary(acc.done?.dialogSummary ?? null);
        if (acc.done)
          setAdvLog([...log, { role: "assistant", content: acc.done.text, ts: Date.now() }]);
        setAdvStream(null);
      };
      const drainTick = () => {
        // 回放速率：小增量按比例跟手；大爆块（免费档整段一次吐）限速 ~160 字/秒
        // 播放，观感接近真流式；上限兜底防超长回复播放过久
        const step = Math.max(1, Math.min(8, Math.ceil((typer.target.length - typer.shown) / 12)));
        const rstep = Math.max(1, Math.min(8, Math.ceil((typer.reasoningTarget.length - typer.reasoningShown) / 12)));
        typer.shown = Math.min(typer.target.length, typer.shown + step);
        typer.reasoningShown = Math.min(typer.reasoningTarget.length, typer.reasoningShown + rstep);
        setAdvStream((s0) => ({
          reasoning: typer.reasoningTarget.slice(0, typer.reasoningShown),
          content: typer.target.slice(0, typer.shown),
          notes: s0?.notes ?? [],
        }));
        if (
          typer.finished &&
          typer.shown >= typer.target.length &&
          typer.reasoningShown >= typer.reasoningTarget.length
        ) {
          finalize();
        }
      };
      const handleEvent = (block: string) => {
        const lines = block.split("\n");
        const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
        const data = lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) return;
        const d = JSON.parse(data);
        if (ev === "reasoning") {
          typer.reasoningTarget += d.text;
          if (typer.timer === null) typer.timer = window.setInterval(drainTick, 50);
        } else if (ev === "note")
          setAdvStream((s0) => ({ reasoning: s0?.reasoning ?? "", content: s0?.content ?? "", notes: [...(s0?.notes ?? []), d.text] }));
        else if (ev === "delta") {
          typer.target += d.text;
          if (typer.timer === null) typer.timer = window.setInterval(drainTick, 50);
        } else if (ev === "done") {
          acc.done = d;
          typer.finished = true;
        } else if (ev === "error") throw new Error(d.error || "顾问调用失败");
      };
      for (;;) {
        const { value, done: rd } = await reader.read();
        if (rd) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          handleEvent(buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
        }
      }
      if (!acc.done) throw new Error("顾问连接中断，未收到完整结果，请重试。");
      typer.finished = true;
      // 上游没吐任何增量（纯工具轮/空回复）时没有 drain 在跑，直接落地
      if (typer.timer === null) finalize();
    } catch (e) {
      stopDrain();
      setAdvStream(null);
      if (epoch === advEpoch.current) setAdvError((e as Error).message);
    } finally {
      setAdvBusy(false);
    }
  }
  // ---------- 后台分析（服务端跑，UI 随便浏览） ----------
  type BgJob = {
    convId: string;
    contactName: string;
    status: "running" | "done" | "error" | "cancelled";
    total: number;
    done: number;
    errors: number;
    error?: string;
    startedAt: string;
    finishedAt?: string;
    lastTickAt?: number;
    current?: number;
  };
  const [bgJob, setBgJob] = useState<BgJob | null>(null);
  const fetchBg = useCallback(() => {
    return fetch("/api/analyze/background")
      .then((r) => r.json())
      .then((d) => setBgJob(d.job ?? null))
      .catch(() => {});
  }, []);
  useEffect(() => {
    void fetchBg();
    const t = setInterval(() => void fetchBg(), 5000);
    return () => clearInterval(t);
  }, [fetchBg]);
  async function startBackground(targetId?: string) {
    const id: string = targetId ?? convId.current;
    try {
      const r = await fetch("/api/analyze/background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ convId: id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "启动失败");
      setBgJob(d.job ?? null);
      setNotice(
        `后台分析已启动：${d.job?.contactName}（${d.job?.total} 个任务）。分析在服务器上跑，你可以随意浏览其他联系人。`,
      );
    } catch (e) {
      setNotice(`后台分析启动失败：${(e as Error).message}`);
    }
  }
  // ---------- 决策树 v1 ----------
  type DtSim = { text: string; valence: string };
  type DtTree = {
    boundary: boolean;
    boundaryReasons: string[];
    intent: string;
    actions: {
      title: string;
      draft: string;
      threshold: string;
      rationale: string;
      catchProbability: number | null;
      note: string;
      simulations: DtSim[];
    }[];
    generatedAt: string;
  };
  const [dtBusy, setDtBusy] = useState(false);
  const [dtTree, setDtTree] = useState<DtTree | null>(null);
  const [dtError, setDtError] = useState("");
  // ---------- 闭环校准（任务单 F v0） ----------
  type CalRecord = {
    id: string;
    convId: string;
    intent: string;
    draft: string;
    actionIndex: number;
    catchProbability: number | null;
    at: string;
    outcome: "caught" | "missed" | null;
    evidenceMsgId?: string;
  };
  const [calRecords, setCalRecords] = useState<CalRecord[]>([]);
  const [dtSentIdx, setDtSentIdx] = useState<Set<number>>(new Set());
  const fetchCal = (cid: string) => {
    if (!cid) return;
    fetch(`/api/decision-tree/feedback?convId=${encodeURIComponent(cid)}`)
      .then((r) => r.json())
      .then((d) => setCalRecords(Array.isArray(d.records) ? d.records : []))
      .catch(() => {});
  };
  async function markSent(a: DtTree["actions"][number], index: number) {
    if (!dtTree || dtSentIdx.has(index)) return;
    try {
      const r = await fetch("/api/decision-tree/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          convId: convId.current,
          intent: dtTree.intent,
          draft: a.draft,
          actionIndex: index + 1,
          catchProbability: a.catchProbability,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "记录失败");
      if (d.record) setCalRecords((prev) => [...prev, d.record]);
      setDtSentIdx((prev) => new Set(prev).add(index));
      setNotice("已记录「实际发出」。对方回复并分析后，会在下方待确认清单里对账。");
    } catch (e) {
      setNotice(`记录失败：${(e as Error).message}`);
    }
  }
  async function confirmCal(id: string, outcome: "caught" | "missed") {
    try {
      const r = await fetch("/api/decision-tree/feedback/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, outcome, convId: convId.current }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "确认失败");
      if (Array.isArray(d.records)) setCalRecords(d.records);
    } catch (e) {
      setNotice(`确认失败：${(e as Error).message}`);
    }
  }
  async function runDecisionTree() {
    if (dtBusy) return;
    const intent = advInput.trim() || "推进一下关系";
    const picked = messages
      .filter((m) => advSel.has(m.id))
      .slice(-200)
      .map((m) => ({ sender: m.sender, text: m.text, timestamp: m.timestamp }));
    const selected = picked.length
      ? picked
      : messages.slice(-50).map((m) => ({
          sender: m.sender,
          text: m.text,
          timestamp: m.timestamp,
        }));
    if (!selected.length) {
      setAdvError("还没有聊天记录可以参考。");
      return;
    }
    // 边界信号：最近 20 条对方消息里 judge 判过 boundary/refuse ≥0.5
    const boundaryDetected = messages
      .filter((m) => m.sender === "other")
      .slice(-20)
      .some((m) => {
        const intents = a.lines[m.id]?.intents ?? {};
        return (intents.boundary ?? 0) >= 0.5 || (intents.refuse ?? 0) >= 0.5;
      });
    setDtBusy(true);
    setDtError("");
    try {
      const r = await fetch("/api/decision-tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          self: self || "我",
          other,
          relation,
          intent,
          messages: selected,
          boundaryDetected,
          ...(contactRef.current ? { contactId: contactRef.current } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "决策树生成失败");
      setDtTree(d);
      setDtSentIdx(new Set());
      fetchCal(convId.current);
    } catch (e) {
      setDtError((e as Error).message);
    } finally {
      setDtBusy(false);
    }
  }
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  // 当前会话的微信 wxid（wx_ 前缀 id 直取；UUID 会话从列表 contactId 查），无则头像走字母
  const wxid = convId.current
    ? convId.current.startsWith("wx_")
      ? convId.current.slice(3)
      : (convs.find((c) => c.id === convId.current)?.contactId ?? null)
    : null;
  const loadContactProfile = (cid: string) => {
    setContactProfile(null);
    if (!cid) return;
    // 竞态守卫：快速切换联系人时，晚到的旧响应不得覆盖新联系人的画像
    fetch(`/api/profile/${encodeURIComponent(cid)}`)
      .then((r) => r.json())
      .then((d) => {
        if (contactRef.current !== cid) return;
        setContactProfile(d.profile ?? null);
      })
      .catch(() => {});
  };
  // ---------- 对方画像面板（设置弹窗）与历史检索（顾问侧栏） ----------
  type ProfileShape = {
    interests?: string[];
    boundaries?: string[];
    styleNote?: string;
    events?: { at?: string; note: string }[];
    mbti?: {
      /** 四轴全判清才有；缺省 = 暂无法判断 */
      type?: string;
      tier?: "high" | "medium" | "low" | "insufficient";
      axes?: {
        dim: string;
        /** 缺省 = 该轴判不准 */
        pick?: string;
        percent: number;
        evidence?: string;
        note?: string;
        status?: "ok" | "weak" | "split" | "insufficient";
        reason?: string;
      }[];
      inferredAt?: string;
      source?: "other" | "self";
      samples?: number;
      note?: string;
    };
  };
  const [profileDraft, setProfileDraft] = useState({
    interests: "",
    boundaries: "",
    styleNote: "",
    events: "",
  });
  /** 当前联系人（state 版，仅供画像面板重渲染；写入判定仍用 contactRef） */
  const [activeCid, setActiveCid] = useState("");
  /** 当前草稿属于哪个联系人——与 activeCid 不一致时禁止保存（防串写） */
  const draftOwnerRef = useRef("");
  const [extracting, setExtracting] = useState(false);
  const [mbtiBusy, setMbtiBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState("");
  const [histQuery, setHistQuery] = useState("");
  const [histBusy, setHistBusy] = useState(false);
  const [histResults, setHistResults] = useState<
    {
      convId: string;
      msgId: string;
      sender: string;
      timestamp: string | null;
      text: string;
    }[] | null
  >(null);
  useEffect(() => {
    if (!settings) return;
    const p = (contactProfile ?? {}) as ProfileShape;
    setProfileDraft({
      interests: (p.interests ?? []).join("，"),
      boundaries: (p.boundaries ?? []).join("，"),
      styleNote: p.styleNote ?? "",
      events: (p.events ?? [])
        .map((e) => (e.at ? `${e.at} ${e.note}` : e.note))
        .join("\n"),
    });
    draftOwnerRef.current = activeCid;
    // activeCid 必须进依赖：联系人变了但画像恰好都是 null 时，
    // 仅靠 contactProfile 的变化不会重渲染，草稿会留在上一个联系人身上。
  }, [settings, contactProfile, activeCid]);
  async function saveProfileDraft(keepMbti = true) {
    const cid = contactRef.current;
    if (!cid) return;
    // 串味守卫：草稿的归属联系人必须就是当前联系人（防止把 A 的画像存进 B）
    if (draftOwnerRef.current !== cid) {
      setProfileMsg("已切换联系人——当前显示的不是 TA 的画像，已重新载入，请确认后再保存。");
      loadContactProfile(cid);
      return;
    }
    const parse = (s: string) =>
      s.split(/[，,、]/).map((x) => x.trim()).filter(Boolean);
    const events = profileDraft.events
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (!t) return null;
        const m = t.match(/^(\S+)\s+(.+)$/);
        return m ? { at: m[1], note: m[2] } : { note: t };
      })
      .filter(Boolean);
    const mb = keepMbti
      ? ((contactProfile ?? {}) as ProfileShape).mbti
      : undefined;
    setProfileMsg("");
    try {
      const r = await fetch(`/api/profile/${encodeURIComponent(cid)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interests: parse(profileDraft.interests),
          boundaries: parse(profileDraft.boundaries),
          styleNote: profileDraft.styleNote || undefined,
          events,
          ...(mb?.type ? { mbti: mb } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "保存失败");
      if (contactRef.current !== cid) return; // 已切到其他联系人：放弃本次回显
      setContactProfile(d.profile);
      setProfileMsg("已保存。");
    } catch (e) {
      if (contactRef.current === cid)
        setProfileMsg(`保存失败：${(e as Error).message}`);
    }
  }
  async function inferMbtiNow(side: "other" | "self" = "other") {
    const cid = contactRef.current;
    if (!cid || mbtiBusy) return;
    setMbtiBusy(true);
    setProfileMsg(
      side === "self"
        ? "正在用你自己的消息推测 MBTI（分块并行推测，约 1-2 分钟）…"
        : "正在推测 TA 的 MBTI（分块并行推测，约 1-2 分钟）…",
    );
    try {
      const r = await fetch(`/api/profile/${encodeURIComponent(cid)}/mbti`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "推测失败");
      if (contactRef.current !== cid) return; // 已切走：放弃回显
      setContactProfile(d.profile);
      setProfileMsg(
        `已更新推测 MBTI：${d.profile?.mbti?.type ?? ""}（基于${side === "self" ? "你" : "TA"}的消息）`,
      );
    } catch (e) {
      if (contactRef.current === cid)
        setProfileMsg(`推测失败：${(e as Error).message}`);
    } finally {
      setMbtiBusy(false);
    }
  }
  async function extractProfileNow() {
    const cid = contactRef.current;
    if (!cid || extracting) return;
    setExtracting(true);
    setProfileMsg("正在从聊天记录抽取画像（免费档模型约 1-2 分钟）…");
    try {
      const r = await fetch(`/api/profile/${encodeURIComponent(cid)}/extract`, {
        method: "POST",
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "抽取失败");
      if (contactRef.current !== cid) return; // 已切走：放弃回显
      setContactProfile(d.profile);
      setProfileMsg("已更新画像。");
    } catch (e) {
      if (contactRef.current === cid)
        setProfileMsg(`抽取失败：${(e as Error).message}`);
    } finally {
      setExtracting(false);
    }
  }
  async function searchHistoryNow() {
    const q = histQuery.trim();
    const cid = contactRef.current;
    if (!q || !cid || histBusy) return;
    setHistBusy(true);
    try {
      const r = await fetch(
        `/api/history/search?q=${encodeURIComponent(q)}&contact=${encodeURIComponent(
          cid,
        )}&limit=20`,
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "检索失败");
      // 切人守卫：await 期间用户切了联系人，迟到的旧联系人结果不能回填（串显）
      if (contactRef.current !== cid) return;
      setHistResults(d.results ?? []);
    } catch (e) {
      if (contactRef.current === cid) {
        setNotice(`历史检索失败：${(e as Error).message}`);
        setHistResults([]);
      }
    } finally {
      setHistBusy(false);
    }
  }
  // 命中消息定位：滚到该行并把气泡闪绿 2.5 秒（微信式"点击搜索结果跳到聊天"）
  function locateMsg(msgId: string) {
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    stay.current = false;
    virtual.scrollToIndex(idx, { align: "center" });
    setHitMsgFlash(msgId);
    window.setTimeout(() => setHitMsgFlash(null), 2500);
  }
  function jumpToHist(h: { convId: string; msgId: string }) {
    setSearchOpen(false); // 微信式：点结果收起搜索抽屉
    if (h.convId !== convId.current) {
      pendingJump.current = { convId: h.convId, msgId: h.msgId }; // 其他会话的命中：先切换，消息加载完由 effect 自动定位
      void switchTo(h.convId);
      return;
    }
    locateMsg(h.msgId);
  }
  // 跨会话跳转的落点：switchTo 完成 setMessages 后触发一次；
  // convId 校验防 switchTo 中途失败/取消后残留的 pending 在别的会话里错位消费
  useEffect(() => {
    const pj = pendingJump.current;
    if (!pj || pj.convId !== convId.current || !messages.length) return;
    pendingJump.current = null;
    requestAnimationFrame(() => locateMsg(pj.msgId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);
  // 搜索结果里的关键词标绿（首个命中；FTS 按子串匹配，大小写不敏感）
  function markHit(text: string, q: string) {
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark className="hist-mark">{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    );
  }
  const refreshList = () =>
    listConversations()
      .then(setConvs)
      .catch(() => {});
  async function switchTo(id: string) {
    if (id === convId.current) return;
    if (a.status === "loading") {
      const ok = window.confirm(
        "正在分析中，切换联系人会停止本次分析（已分析的部分会保留，切回后可点「继续分析」接着跑）。确定切换？",
      );
      if (!ok) {
        pendingJump.current = null; // 切换取消：跨会话跳转意图作废
        return;
      }
    }
    flushSave();
    // 守卫②：先把当前顾问对话存进**旧** convId——convId.current 一改，
    // 自动保存就会把这份对话写进新联系人的文件（跨联系人串档）
    await saveAdvCurrent();
    try {
      const saved = await loadConversation(id);
      if (!saved || saved.schema !== 1) {
        pendingJump.current = null; // 加载失败：同上作废，防残留错位消费
        return;
      }
      convId.current = id;
      contactRef.current = saved.contactId ?? "";
      setActiveCid(contactRef.current);
      loadContactProfile(contactRef.current);
      setAdvSel(new Set());
      // 归档浏览器是按 convId 的：不重置会继续显示上一个联系人的归档列表/详情
      setAdvArchive(null);
      setAdvViewIdx(null);
      // 搜索抽屉的结果是按联系人检索的：切人必须清掉，避免展示上一个联系人的命中
      setHistResults(null);
      setHistQuery("");
      setRenIdx(null);
      setAdvMenu(false);
      a.cancel();
      setNotes(saved.notes ?? "");
      setProfile(saved.userProfile ?? {});
      setRelationCustom(saved.relationLabel ?? "");
      setMessages(saved.messages.map(normalizeMedia));
      setSelf(saved.self ?? "");
      setOther(saved.other);
      setRelation(saved.relation);
      setInput("");
      void loadAdvState(id);
      setNotice("");
      setDetail(null);
      stay.current = true;
      a.restore(saved);
      refreshList();
    } catch {
      setStorageError("切换会话读取失败。");
    }
  }
  // ---------- 关系提醒（主动预警） ----------
  type WatchAlertItem = {
    id: string;
    convId: string;
    rule: string;
    title: string;
    detail: string;
    at: string;
    acked: boolean;
  };
  const [watchAlerts, setWatchAlerts] = useState<WatchAlertItem[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [watchChecking, setWatchChecking] = useState(false);
  const lastUnreadRef = useRef<number | null>(null);
  const watchUnread = useMemo(
    () => watchAlerts.filter((a) => !a.acked),
    [watchAlerts],
  );
  const applyAlerts = useCallback((list: WatchAlertItem[]) => {
    setWatchAlerts(list);
    const unread = list.filter((a) => !a.acked).length;
    if (lastUnreadRef.current !== null && unread > lastUnreadRef.current) {
      const newest = list.find((a) => !a.acked);
      if (newest) setNotice(`新提醒：${newest.title} — ${newest.detail}`);
    }
    lastUnreadRef.current = unread;
  }, []);
  const fetchAlerts = useCallback(() => {
    return fetch("/api/alerts")
      .then((r) => r.json())
      .then((d) => applyAlerts(Array.isArray(d.alerts) ? d.alerts : []))
      .catch(() => {});
  }, [applyAlerts]);
  useEffect(() => {
    void fetchAlerts();
    const t = setInterval(() => void fetchAlerts(), 60_000);
    return () => clearInterval(t);
  }, [fetchAlerts]);
  async function runWatchCheck() {
    setWatchChecking(true);
    try {
      const r = await fetch("/api/alerts/check", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "检查失败");
      applyAlerts(Array.isArray(d.alerts) ? d.alerts : []);
      setNotice(
        d.added > 0
          ? `检查了 ${d.checked} 个会话，新增 ${d.added} 条提醒`
          : `检查了 ${d.checked} 个会话，没有新提醒`,
      );
    } catch (e) {
      setNotice(`检查失败：${(e as Error).message}`);
    } finally {
      setWatchChecking(false);
    }
  }
  async function ackWatchAlert(id?: string) {
    try {
      const r = await fetch("/api/alerts/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { ids: [id] } : {}),
      });
      const d = await r.json();
      if (r.ok) applyAlerts(Array.isArray(d.alerts) ? d.alerts : []);
    } catch {
      /* 已读失败不致命，下次轮询会再对齐 */
    }
  }
  function jumpToAlert(a: WatchAlertItem) {
    void ackWatchAlert(a.id).then(() => {
      setAlertsOpen(false);
      if (a.convId !== convId.current) void switchTo(a.convId);
    });
  }
  const convName = (id: string) =>
    convs.find((c) => c.id === id)?.other || "会话";
  const fmtAlertTime = (iso: string) => {
    const d = new Date(iso);
    return isNaN(+d)
      ? ""
      : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  // ---------- 输入框实时体检（里程碑 5） ----------
  type LiveCheckResult = {
    threshold: number;
    warmth: string;
    risk: number;
    riskNote: string;
    comments: { quote: string; note: string }[];
    rewrite: string;
  };
  const [liveCheck, setLiveCheck] = useState<LiveCheckResult | null>(null);
  const liveCheckTimer = useRef<number | null>(null);
  const liveCheckAbort = useRef<AbortController | null>(null);
  const lastCheckedRef = useRef<string | null>(null);
  function scheduleLiveCheck(text: string) {
    if (liveCheckTimer.current) clearTimeout(liveCheckTimer.current);
    if (!shouldCheck(text, lastCheckedRef.current)) {
      if (!text.trim()) setLiveCheck(null);
      return;
    }
    liveCheckTimer.current = window.setTimeout(() => {
      liveCheckAbort.current?.abort();
      const ac = new AbortController();
      liveCheckAbort.current = ac;
      fetch("/api/advise/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: text.trim() }),
        signal: ac.signal,
      })
        .then((r) => r.json())
        .then((d) => {
          if (d?.available) {
            setLiveCheck(d.check);
            lastCheckedRef.current = text.trim();
          } else {
            setLiveCheck(null); // 判官未配置：整条隐藏，绝不打扰输入
          }
        })
        .catch(() => {
          /* 请求失败静默：实时体检不打扰输入 */
        });
    }, 1500);
  }
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 150,
    getItemKey: useCallback((i: number) => messages[i].id, [messages]),
    overscan: 8,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 100,
  });
  useEffect(() => {
    let live = true;
    const refreshList = () =>
      listConversations()
        .then((list) => live && setConvs(list))
        .catch(() => {});
    const apply = (saved: SavedConversation) => {
      contactRef.current = saved.contactId ?? "";
      setActiveCid(contactRef.current);
      loadContactProfile(contactRef.current);
      setNotes(saved.notes ?? "");
      setProfile(saved.userProfile ?? {});
      setRelationCustom(saved.relationLabel ?? "");
      setMessages(saved.messages.map(normalizeMedia));
      setSelf(saved.self ?? "");
      setOther(saved.other);
      setRelation(saved.relation);
      a.restore(saved);
    };
    void (async () => {
        if (!live) return;
        const last = await getLastConvId();
        // 无上次会话：空界面起步（列表里点开即可）——不再回退到假 id "current"，
        // 否则 flushSave 会把假 id 写进 meta.lastConvId，之后每次启动都加载失败（白屏感）
        if (last) {
          const saved = await loadConversation(last);
          if (!live) return;
          if (saved?.schema === 1) {
            convId.current = last;
            apply(saved);
            void loadAdvState(last);
          }
        }
        refreshList();
        setReady(true);
      })().catch(() => {
        if (live) {
          setStorageError("记录读取失败，请确认本机服务已启动后刷新页面。");
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);
  const pendingSave = useRef<SavedConversation | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    lastSavedMessages = useRef<Message[] | null>(null);
  const flushSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    void saveConversation(convId.current, pendingSave.current)
      .then(() => setLastConvId(convId.current))
      .then(() => refreshList())
      .catch(() =>
        setStorageError(
          "本机保存失败，可能存储空间不足。当前页面仍可使用，请勿刷新以免丢失未保存记录。",
        ),
      );
  };
  useEffect(() => {
    if (!ready || storageError) return;
    pendingSave.current = messages.length
      ? {
          schema: 1,
          rubric: RUBRIC,
          messages,
          self,
          other,
          relation,
          lines: a.lines,
          events: a.events,
          overview: a.overview,
          trend: a.trend,
          analyzedCount: a.analyzedCount,
          completed: a.status === "complete",
          modelFingerprint: a.modelFingerprint,
          notes,
          userProfile:
            profile.mbti || profile.style || profile.recent
              ? profile
              : undefined,
          relationLabel: relationCustom,
          contactId: contactRef.current || undefined,
        }
      : null;
    if (lastSavedMessages.current !== messages || a.status !== "loading") {
      lastSavedMessages.current = messages;
      flushSave();
    } else if (!saveTimer.current)
      saveTimer.current = setTimeout(flushSave, 750);
    // 顾问对话随同一节奏落盘（修复：saveAdvCurrent 此前是死代码，退出/刷新即丢）。
    // 只在顾问状态真的变了才 PUT——本 effect 也会被聊天分析高频触发，不能每次都写盘。
    if (
      advLoaded.current &&
      (lastSavedAdv.current?.log !== advLog ||
        lastSavedAdv.current?.summary !== advSummary ||
        lastSavedAdv.current?.goal !== advGoal)
    ) {
      lastSavedAdv.current = { log: advLog, summary: advSummary, goal: advGoal };
      void saveAdvCurrent();
    }
  }, [
    ready,
    messages,
    self,
    other,
    relation,
    a.lines,
    a.events,
    a.overview,
    a.trend,
    a.analyzedCount,
    a.status,
    a.modelFingerprint,
    advLog,
    advSummary,
    advGoal,
  ]);
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) flushSave();
      void saveAdvCurrent(); // 关页面/切后台：顾问对话也立即落盘（走 ref，闭包不过期）
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);
  const stay = useRef(true);
  useEffect(() => {
    if (messages.length && stay.current)
      virtual.scrollToIndex(messages.length - 1, { align: "end" });
  }, [messages.length]);
  const busy = a.status === "loading",
    ov = a.overview,
    value = ov?.affinity.value,
    quality = meanQuality(messages, a.lines);
  // 情绪水位曲线：纯本地从 messages + lines 聚合（shared/valence.ts），零模型调用；
  // 不落盘—— restored 会话由 messages/lines 重新算出，改参数算法可全量回放。
  const valence = useMemo(
    () => aggregateValence(messages, a.lines),
    [messages, a.lines],
  );
  const valenceSummary = useMemo(() => summarizeValence(valence), [valence]);
  // 对方行为基线：纯本地从全量 messages 统计（短回复占比/间隔中位数/主动开聊率），
  // 展示在聊天设置面板，并随分析与顾问请求下发——"哦/嗯嗯"是常态还是异常由数据说话。
  const baseline = useMemo(() => computeBaseline(messages), [messages]);
  // 话题板块：点未分析消息 = 分析它所在的整个板块。lines 变化自动重算——
  // 分析结果里的 mode/change 信号落盘后板块随之细化（自适应收敛），零额外调用。
  const topicOf = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const u of buildTopics(messages, a.lines))
      for (const m of u.messages) map.set(m.id, u.messages);
    return map;
  }, [messages, a.lines]);
  const [busyElapsed, setBusyElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setBusyElapsed(0);
      return;
    }
    const t = setInterval(() => setBusyElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy, a.progress.done]);
  const actionOverview = currentAction(ov, messages, a.overviewFresh);
  const actionLabel = actionOverview
    ? ACTIONS[actionOverview.action]?.label
    : busy
      ? "正在更新…"
      : messages.length
        ? "建议待更新"
        : "等你导入聊天";
  const last = a.trend.at(-1),
    previous = a.trend.at(-2);
  const delta =
    a.status === "complete" && last?.value != null && previous?.value != null
      ? last.value - previous.value
      : null;
  function start(ms: Message[]) {
    setMessages(ms);
    setInput("");
    if (!modelConfig?.configured) {
      setModelOpen(true);
      return;
    }
    const units = buildAnalysisUnits(ms);
    const recent = units.at(-1)?.messages.length ?? 0;
    const skipped = ms.length - recent;
    setNotice(
      skipped > 0
        ? `本次聚焦最近的活跃期（${recent} 条）；更早的 ${skipped} 条点消息上的分析按钮按话题板块分析，或多选勾选后「分析勾选」`
        : "",
    );
    a.run(ms, relation, notes, relationCustom, profile);
  }
  function add(ms: Message[], mode: "auto" | "append" | "skip" = "auto") {
    const m = mergeMessages(messages, ms, mode);
    if (m.ambiguous) {
      setOverlap(ms);
      return;
    }
    if (!m.added) {
      setNotice("没有新增消息，这段已经分析过了。");
      setInput("");
      return;
    }
    setNotice("");
    start(m.messages);
  }
  function prepare(text: string) {
    if (!text.trim()) return;
    if (text.length > 250000) {
      setNotice("这次粘贴超过25万字符，请分几次追加；历史记录不会被截断。");
      return;
    }
    const p = parseChat(text);
    const names = [...new Set(p.messages.map((x) => x.speaker))];
    if (
      messages.length &&
      self &&
      !p.warnings.length &&
      names.every((n) => n === self || n === other)
    ) {
      add(toMessages(p.messages, self));
      return;
    }
    setRaw(text);
    setParsed(p.messages);
    setRole(names.includes(self) ? self : names.includes("我") ? "我" : "");
    setImporting(true);
  }
  function confirmImport() {
    const names = [...new Set(parsed.map((x) => x.speaker))];
    setSelf(role);
    setOther(names.find((n) => n !== role) || "Crush");
    setImporting(false);
    add(toMessages(parsed, role));
  }
  function clear() {
    a.reset();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingSave.current = null;
    // 旧会话保留在列表里，"新聊天"只是开一个新 id，不再删除存储。
    // 顾问对话同理：先存进旧 convId（切回该会话时可恢复），不随"新聊天"丢弃。
    void saveAdvCurrent();
    convId.current =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : String(Date.now());
    setMessages([]);
    setInput("");
    setSelf("");
    setOther("Crush");
    setNotice("");
    setNotes("");
    setProfile({});
    setRelationCustom("");
    advEpoch.current++;
    setAdvLog([]);
    setAdvSummary(null);
    setAdvGoal("");
    setAdvSel(new Set());
    // 归档浏览器按 convId 隔离：新聊天后必须重置，否则显示的是旧会话的归档
    setAdvArchive(null);
    setAdvViewIdx(null);
    setRenIdx(null);
    setAdvMenu(false);
    // 新 convId 还没读过 → 禁写直到 GET 返回（避免把旧状态写进新文件）
    advLoaded.current = false;
    void loadAdvState(convId.current);
    setSettings(false);
    setDetail(null);
    refreshList();
  }
  const names = [...new Set(parsed.map((x) => x.speaker))];
  const chosen = messages.find((m) => m.id === detail),
    result = detail ? a.lines[detail] : undefined;
  // 配置归设置,选择归界面:顾问下拉两级(供应商→模型)在顾问面板输入框旁,评估下拉平铺在页头
  // 通道开关（2026-11-20）：停用的供应商/模型从下拉隐藏；当前正在用的永远可见（停用不影响已选通道）
  const isCurChan = (baseUrl: string, model?: string) =>
    baseUrl === modelConfig?.baseUrl &&
    (model === undefined || model === modelConfig?.model);
  const configuredModels = (modelConfig?.providers ?? []).flatMap((p) =>
    p.models
      .filter((m) => p.enabled !== false || isCurChan(p.baseUrl))
      .filter((m) => isCurChan(p.baseUrl, m) || !(p.disabledModels ?? []).includes(m))
      .map((m) => ({
        value: p.baseUrl + "::" + m,
        baseUrl: p.baseUrl,
        preset: p.preset,
        protocol: p.protocol,
        model: m,
      })),
  );
  const judge = modelConfig?.judge;
  const advisorSelValue = modelConfig?.baseUrl + "::" + modelConfig?.model;
  // 消息框选模型（2026-11-19）：先选供应商、再选该家的模型——多供应商时平铺一列表分不清来源。
  // 当前配置不在登记簿里（旧配置/手填）时补一个虚拟供应商，当前模型照常可见、可切回。
  // 没存 Key 的供应商不进消息框下拉(配 Key 去模型设置);当前供应商兜底保留,选中的模型永远可见
  const provList = (modelConfig?.providers ?? []).filter(
    (p) =>
      (p.hasKey || p.baseUrl === modelConfig?.baseUrl) &&
      (p.enabled !== false || p.baseUrl === modelConfig?.baseUrl),
  );
  const advProvs =
    modelConfig?.model && !provList.some((p) => p.baseUrl === modelConfig.baseUrl)
      ? [...provList, { baseUrl: modelConfig.baseUrl, preset: modelConfig.preset, protocol: modelConfig.protocol, models: [modelConfig.model] }]
      : provList;
  const advProvBase =
    advProv && advProvs.some((p) => p.baseUrl === advProv)
      ? advProv
      : (advProvs.find((p) => p.baseUrl === modelConfig?.baseUrl)?.baseUrl ?? advProvs[0]?.baseUrl ?? "");
  const provLabel = (p: { preset: string; baseUrl: string }) =>
    MODEL_PRESETS.find((x) => x.id === p.preset)?.name ||
    p.preset ||
    p.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const advModelOpts = advProvs
    .filter((p) => p.baseUrl === advProvBase)
    .flatMap((p) =>
      p.models
        .filter(
          (m) =>
            (p.baseUrl + "::" + m === advisorSelValue ||
              !(modelConfig?.providers?.find((x) => x.baseUrl === p.baseUrl)
                ?.disabledModels ?? []
              ).includes(m)),
        )
        .map((m) => ({ value: p.baseUrl + "::" + m, model: m })),
    );
  const advModelValue = advModelOpts.some((m) => m.value === advisorSelValue) ? advisorSelValue : "";
  const judgeSelValue = !judge?.enabled
    ? "off"
    : judge.baseUrl + "::" + judge.model;
  async function switchModel(role: "advisor" | "judge", value: string) {
    if (value === "more") {
      setModelOpen(true);
      return;
    }
    const mc = modelConfig;
    if (!mc) return;
    const picked = configuredModels.find((p) => p.value === value);
    if (!picked) return;
    const main = {
      preset: picked.preset,
      protocol: picked.protocol,
      baseUrl: picked.baseUrl,
      model: picked.model,
      apiKey: "", // 留空沿用登记簿里的 Key
    };
    const judgeNew =
      role === "judge"
        ? { enabled: true, baseUrl: picked.baseUrl, model: picked.model, apiKey: "" }
        : mc.judge
          ? { ...mc.judge, apiKey: "" }
          : undefined;
    try {
      const r = await fetch("/api/settings/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-config-token": mc.token,
        },
        body: JSON.stringify({
          ...main,
          jsonMode: mc.jsonMode,
          judge: judgeNew,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || "保存失败");
      setModelConfig(
        (await fetch("/api/settings").then((x) => x.json())) as PublicSettings,
      );
      if (role === "judge") a.reset(); // 评估换了,打分口径变了,旧指纹作废
    } catch (e) {
      // 切换失败(常见=该供应商还没填 Key):弹出的设置里预填好目标,用户只补 Key
      if (role === "judge")
        setJudgeHint({ baseUrl: picked.baseUrl, model: picked.model });
      setNotice(
        (e as Error).message + "；已在模型设置里预选好，填好 Key 保存即可。",
      );
      setModelOpen(true);
    }
  }
  if (appExiting)
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "var(--bg)",
          color: "var(--muted)",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          lineHeight: 2,
        }}
      >
        <p>
          应用已退出,本机服务与隧道已关闭。
          <br />
          本窗口可以关闭了;再次使用请双击 启动.bat。
        </p>
      </div>
    );
  return (
    <main className="app">
      <div className="workspace">
          <nav className="chat-rail" aria-label="聊天工具">
              <button
                className={
                  "rail-model" +
                  (!modelConfig?.configured ? " rail-model-unset" : "")
                }
                aria-label="模型设置"
                title={`模型设置 · ${modelConfig?.model || "未配置"}`}
                onClick={() => setModelOpen(true)}
              >
                <Settings size={22} />
              </button>
            <button
              className="rail-exit"
              aria-label="退出应用（关闭本机服务与隧道）"
              title="退出应用（关闭本机服务与隧道）"
              onClick={() => {
                void fetch("/api/shutdown", { method: "POST" }).catch(
                  () => {},
                );
                setAppExiting(true);
                window.close();
              }}
            >
              <Power size={22} />
            </button>
          </nav>
        <aside className="conv-list" aria-label="会话列表">
          <div className="conv-head">
            <input
              className="conv-search"
              value={convQuery}
              onChange={(e) => setConvQuery(e.target.value)}
              placeholder="搜索"
            />
            <button
              className="conv-add"
              aria-label="导入微信聊天记录"
              title="导入微信聊天记录"
              onClick={openWx}
            >
              <FolderOpen size={17} />
            </button>
          </div>
          <div className="wx-quick-sync">
            <button
              className="secondary"
              disabled={syncAllBusy || wxSyncing}
              onClick={() => void syncAllWechat(true)}
              title="一键同步微信聊天记录（解密→读取→写入会话，保留分析结果；需要微信处于登录状态）"
            >
              {syncAllBusy ? "同步中…" : "同步微信聊天"}
            </button>
            <label className="wx-auto" title="开启后每 5 分钟自动同步一次（需微信保持登录）">
              <input
                type="checkbox"
                checked={autoSync}
                onChange={(e) => {
                  setAutoSync(e.target.checked);
                  localStorage.setItem(WX_AUTO_KEY, e.target.checked ? "1" : "0");
                }}
              />
              自动
            </label>
          </div>
          {(syncAllBusy || lastWxSync) && (
            <small className="wx-sync-state">
              {syncAllBusy ? "正在同步（可能需要几分钟）…" : lastWxSync ? `上次同步 ${lastWxSync}` : ""}
            </small>
          )}
          {!convs.filter((c) => !convQuery.trim() || c.other.includes(convQuery.trim())).length && (
            <p className="conv-empty">暂无会话。点右上角 ⊕ 导入微信聊天，或在中间粘贴记录。</p>
          )}
          {convs
            .filter((c) => !convQuery.trim() || c.other.includes(convQuery.trim()))
            .map((c) => (
            <div key={c.id} className={"conv-item" + (c.id === convId.current ? " active" : "")}>
              <button
                className="conv-row"
                onClick={() => switchTo(c.id)}
                title={`${c.other} · ${c.count}条`}
              >
                <span className="conv-avatar">
                  {(c.contactId ?? (c.id.startsWith("wx_") ? c.id.slice(3) : null)) && (
                    <img
                      className="avatar-img"
                      src={`/api/wechat/avatar?u=${encodeURIComponent(
                        c.contactId ?? c.id.slice(3),
                      )}`}
                      alt=""
                      onError={(e) => (e.currentTarget.style.display = "none")}
                    />
                  )}
                  {c.other.slice(0, 1)}
                </span>
                <span className="conv-meta">
                  <span className="conv-top">
                    <span className="conv-name">{c.other}</span>
                    <small className="conv-time">{c.at.replace(/^\d{4}年/, "")}</small>
                  </span>
                  <span className="conv-prev">{c.preview || `${c.count} 条记录`}</span>
                </span>
              </button>
              <button
                className="conv-del"
                aria-label={`删除与 ${c.other} 的会话`}
                onClick={(e) => {
                  e.stopPropagation();
                  setDelConv(c);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </aside>
        <section className="wechat" aria-label="微信聊天">
          {busy && (
            <div
              className={"analysis-progress" + (a.progress.total ? "" : " indeterminate")}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={a.progress.total || 100}
              aria-valuenow={a.progress.done}
            >
              <div
                className="analysis-progress-fill"
                style={{
                  width: a.progress.total
                    ? `${Math.round((a.progress.done / a.progress.total) * 100)}%`
                    : "35%",
                }}
              />
            </div>
          )}
          <header className="chat-head">
            <div className="chat-head-left">
            <div className="contact-title">
              <h2>{messages.length ? other : "微信聊天"}</h2>
              <span>{relationCustom.trim() || RELATIONS[relation]}</span>
            </div>
            <button
              className="header-affinity"
              onClick={() => setDetail("overview")}
              aria-label="查看好感度详情"
            >
              <span>好感度</span>
              <strong key={value} className="affinity-number">
                {value ?? "—"}
              </strong>
              {value != null && (
                <span className="affinity-hearts" aria-hidden="true">
                  <Heart className="affinity-heart heart-one" size={12} />
                  <Heart className="affinity-heart heart-two" size={9} />
                  <Heart className="affinity-heart heart-three" size={7} />
                </span>
              )}
              {delta != null && delta !== 0 && (
                <small>
                  {delta > 0 ? "+" : ""}
                  {delta}
                </small>
              )}
            </button>
            </div>
            <div className="header-tools">
              <div className="alerts-wrap">
                <button
                  className={"icon" + (alertsOpen ? " rail-conv-on" : "")}
                  aria-label="关系提醒"
                  title="关系提醒：后台每 5 分钟自动检查最新聊天记录"
                  onClick={() => setAlertsOpen((v) => !v)}
                >
                  <Bell size={20} />
                  {watchUnread.length > 0 && (
                    <span className="alerts-badge">
                      {watchUnread.length > 9 ? "9+" : watchUnread.length}
                    </span>
                  )}
                </button>
                {alertsOpen && (
                  <div className="alerts-panel" role="dialog" aria-label="关系提醒列表">
                    <div className="alerts-panel-head">
                      <span>关系提醒</span>
                      <div className="alerts-panel-actions">
                        <button
                          className="secondary"
                          disabled={watchChecking}
                          onClick={() => void runWatchCheck()}
                        >
                          {watchChecking ? "检查中…" : "立即检查"}
                        </button>
                        {watchUnread.length > 0 && (
                          <button className="secondary" onClick={() => void ackWatchAlert()}>
                            全部已读
                          </button>
                        )}
                      </div>
                    </div>
                    {watchUnread.length === 0 ? (
                      <div className="alerts-empty">
                        暂无未读提醒。后台每 5 分钟自动检查一遍最新聊天记录，也可以手动立即检查。
                      </div>
                    ) : (
                      <ul className="alerts-list">
                        {watchUnread.map((a) => (
                          <li key={a.id}>
                            <button
                              className="alerts-item"
                              onClick={() => jumpToAlert(a)}
                              title="点击查看对应会话"
                            >
                              <span className="alerts-item-head">
                                <strong>{a.title}</strong>
                                <span className="alerts-meta">
                                  {convName(a.convId)} · {fmtAlertTime(a.at)}
                                </span>
                              </span>
                              <span className="alerts-detail">{a.detail}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <select
                className="model-quick"
                aria-label="评估模型"
                title="评估：逐条情绪/意图/评分用哪个模型"
                value={judgeSelValue}
                disabled={!modelConfig}
                onChange={(e) => void switchModel("judge", e.target.value)}
              >
                {judgeSelValue === "off" && (
                  <option value="off">评估：关（用顾问模型）</option>
                )}
                {configuredModels.map((p) => (
                  <option key={p.value} value={p.value}>
                    评估：{p.model}
                  </option>
                ))}
                {judgeSelValue !== "off" &&
                  !configuredModels.some((p) => p.value === judgeSelValue) && (
                    <option value={judgeSelValue}>评估：当前配置</option>
                  )}
                {judgeSelValue !== "off" && (
                  <option value="off">评估：关（用顾问模型）</option>
                )}
                <option value="more">模型设置…</option>
              </select>
              <button
                className={"icon" + (selectMode ? " rail-conv-on" : "")}
                aria-label="多选聊天记录"
                aria-pressed={selectMode}
                onClick={() => {
                  setSelectMode((v) => !v);
                  setAdvSel(new Set());
                }}
              >
                <ListChecks size={20} />
              </button>
              <button
                className="icon"
                aria-label="搜索聊天记录"
                onClick={() => setSearchOpen((v) => !v)}
              >
                <Search size={20} />
              </button>
              <button
                className="icon"
                aria-label="更多聊天设置"
                onClick={() => setSettings(true)}
              >
                <MoreHorizontal size={24} />
              </button>
            </div>
          </header>
          {bgJob?.status === "running" && (
            <div className="bg-chip" role="status">
              <span>
                ⚙ 后台分析「{bgJob.contactName}」{bgJob.done}/{bgJob.total}
                {bgJob.errors ? `（失败 ${bgJob.errors}）` : ""}
                {bgJob.lastTickAt
                  ? ` · 当前这批已等 ${Math.max(
                      0,
                      Math.round((Date.now() - bgJob.lastTickAt) / 1000),
                    )}s（思考型判官单批较慢）`
                  : ""}
                —— 期间可自由浏览其他联系人
              </span>
              <span className="bg-chip-actions">
                {bgJob.convId !== convId.current && (
                  <button
                    className="secondary"
                    onClick={() => void switchTo(bgJob.convId)}
                  >
                    去查看
                  </button>
                )}
                <button
                  className="secondary"
                  onClick={async () => {
                    await fetch("/api/analyze/background/cancel", {
                      method: "POST",
                    });
                    void fetchBg();
                  }}
                >
                  停止
                </button>
              </span>
            </div>
          )}
          {bgJob?.status === "done" && bgJob.convId === convId.current && (
            <div className="bg-chip bg-done" role="status">
              <span>
                ✅ 后台分析完成：{bgJob.done} 个任务
                {bgJob.errors ? `，${bgJob.errors} 个失败` : ""}——已写入记录
              </span>
              <button
                className="secondary"
                onClick={() => {
                  void fetchBg();
                  void (async () => {
                    const saved = await loadConversation(convId.current);
                    if (saved?.schema === 1) a.restore(saved);
                    setBgJob(null);
                  })();
                }}
              >
                载入结果
              </button>
            </div>
          )}
          {watchUnread.length > 0 && (
            <div className="alerts-banner" role="status">
              <span className="alerts-banner-text">
                🔔 <strong>{watchUnread[0].title}</strong>
                <span className="alerts-banner-detail"> — {watchUnread[0].detail}</span>
              </span>
              <span className="alerts-banner-actions">
                <button className="secondary" onClick={() => jumpToAlert(watchUnread[0])}>
                  查看
                </button>
                <button
                  className="icon"
                  aria-label="知道了"
                  onClick={() => void ackWatchAlert(watchUnread[0].id)}
                >
                  <X size={14} />
                </button>
              </span>
            </div>
          )}
          {searchOpen && (
            <div className="chat-search">
              <div className="chat-search-bar">
                <input
                  autoFocus
                  value={histQuery}
                  onChange={(e) => setHistQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchHistoryNow();
                    if (e.key === "Escape") setSearchOpen(false);
                  }}
                  placeholder="搜索全部聊天记录，回车搜索"
                />
                <button
                  className="secondary"
                  disabled={histBusy || !histQuery.trim()}
                  onClick={() => void searchHistoryNow()}
                >
                  {histBusy ? "搜索中…" : "搜索"}
                </button>
              </div>
              {histResults && (
                <div className="hist-results chat-search-results">
                  {histResults.length === 0 ? (
                    <small>没有命中。</small>
                  ) : (
                    histResults.map((h) => (
                      <button
                        key={h.msgId}
                        className="hist-hit"
                        onClick={() => jumpToHist(h)}
                        title="点击定位到该消息"
                      >
                        <span className="hist-meta">
                          {h.timestamp ?? "时间不详"} ·{" "}
                          {h.sender === "self" ? "我" : "对方"}
                          {h.convId !== convId.current ? " · 其他会话" : ""}
                        </span>
                        <span className="hist-text">
                          {markHit(h.text, histQuery.trim())}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <div
            ref={scroller}
            className="chat-scroll"
            onScroll={(e) => {
              const el = e.currentTarget;
              stay.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
          >
            {!messages.length ? (
              <div className="empty">
                <h2>粘贴聊天记录</h2>
                <p>支持微信、QQ 复制记录及 WhatsApp 文本导出</p>
                <button
                  className="text-button"
                  onClick={() => prepare(exampleText(0))}
                >
                  用一段示例试试 <ArrowUpRight size={16} />
                </button>
              </div>
            ) : (
              <div
                style={{
                  height: virtual.getTotalSize(),
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtual.getVirtualItems().map((row) => {
                  const i = row.index,
                    m = messages[i];
                  const r = a.lines[m.id];

                  return (
                    <div
                      key={m.id}
                      data-index={row.index}
                      ref={virtual.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${row.start}px)`,
                      }}
                      id={`message-${m.id}`}
                      className={
                        `message ${m.sender}` +
                        (selectMode ? " selecting" : "") +
                        (advSel.has(m.id) ? " picked" : "") +
                        (hitMsgFlash === m.id ? " flash" : "")
                      }
                      onClick={
                        selectMode
                          ? (e) => {
                              const target = e.target as HTMLElement;
                              // 只跳过真正的交互元素；整行 100% 宽，点头像/空白/气泡外都算勾选
                              if (target.closest("input, button, a")) return;
                              toggleAdvSel(m.id);
                            }
                          : undefined
                      }
                      role={selectMode ? "button" : undefined}
                      aria-pressed={selectMode ? advSel.has(m.id) : undefined}
                      title={selectMode ? "点击整行勾选/取消" : undefined}
                    >
                      {(i === 0 || m.timestamp !== messages[i - 1].timestamp) &&
                        m.timestamp && (
                          <div className="timestamp">
                            {m.timestamp.replace(/^\d{4}年/, "")}
                          </div>
                        )}
                      {/* 微信式整行勾选：点击行内任意非交互区域（头像/空白处/气泡）都能切换选中。
                          交互元素（checkbox/按钮/链接）自己处理点击，冒泡到此处时跳过，避免误勾选。 */}
                      <div className="message-row">
                        {selectMode && (
                          <input
                            type="checkbox"
                            className="msg-check"
                            checked={advSel.has(m.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleAdvSel(m.id)}
                          />
                        )}
                        <div
                          className={`avatar ${m.sender === "self" ? "mine" : ""}`}
                        >
                          {wxid && (
                            <img
                              className="avatar-img"
                              src={`/api/wechat/avatar?u=${
                                m.sender === "self" ? "self" : encodeURIComponent(wxid)
                              }`}
                              alt=""
                              onError={(e) => (e.currentTarget.style.display = "none")}
                            />
                          )}
                          {(m.sender === "self" ? self : other).slice(0, 1)}
                        </div>
                        <div className="message-content">
                          <div
                            className={`bubble${advSel.has(m.id) ? " selected" : ""}`}
                          >
                            {m.kind === "unreadable" ? (
                              <MediaBubble m={m} />
                            ) : (
                              m.text
                            )}
                          </div>
                          {m.kind === "text" && (
                            <div className={`message-tags ${m.sender}`}>
                              {r?.skipped ? (
                                <span className="pending-tag">{r.skipped}</span>
                              ) : m.sender === "other" ? (
                                <>
                                  <div className="analysis-row emotion-row">
                                    <span className="analysis-row-label">
                                      情绪
                                    </span>
                                    {r?.emotions ? (
                                      topEmotions(r.emotions).map((emotion) => (
                                        <button
                                          key={emotion.key}
                                          className={`emotion-tag emotion-${emotion.key}`}
                                          onClick={() => setDetail(m.id)}
                                          aria-label={`${emotion.label} ${emotion.percent}，查看情绪分析：${m.text}`}
                                        >
                                          <span>{emotion.label}</span>
                                          <b>{emotion.percent}</b>
                                        </button>
                                      ))
                                    ) : (
                                      <button
                                        className="pending-tag"
                                        disabled={busy}
                                        title="分析整个话题板块（含前后上下文，不只这一条）"
                                        onClick={() =>
                                          a.runScope(messages, relation, topicOf.get(m.id) ?? [m])
                                        }
                                      >
                                        {busy ? (a.progress.active?.includes(m.id) ? "分析中" : "排队中") : "分析情绪"}
                                      </button>
                                    )}
                                  </div>
                                  <div className="analysis-row target-row">
                                    <span className="analysis-row-label">
                                      指向
                                    </span>
                                    {r?.targets ? (
                                      topTargets(r.targets).map((target) => (
                                        <button
                                          key={target.key}
                                          className={`target-tag target-${target.key}`}
                                          onClick={() => setDetail(m.id)}
                                          aria-label={`${target.label} ${target.percent}，查看指向分析：${m.text}`}
                                        >
                                          <span>{target.label}</span>
                                          <b>{target.percent}</b>
                                        </button>
                                      ))
                                    ) : (
                                      <button
                                        className="pending-tag"
                                        disabled={busy}
                                        title="分析整个话题板块（含前后上下文，不只这一条）"
                                        onClick={() =>
                                          a.runScope(messages, relation, topicOf.get(m.id) ?? [m])
                                        }
                                      >
                                        {busy ? (a.progress.active?.includes(m.id) ? "分析中" : "排队中") : "分析指向"}
                                      </button>
                                    )}
                                  </div>
                                  <div className="analysis-row intent-row">
                                    <span className="analysis-row-label">
                                      意图
                                    </span>
                                    {r?.intents ? (
                                      topIntents(r.intents).map((intent) => (
                                        <button
                                          key={intent.key}
                                          className="intent-tag"
                                          onClick={() => setDetail(m.id)}
                                          aria-label={`${intent.label} ${intent.percent}，查看意图分析：${m.text}`}
                                        >
                                          <span>{intent.label}</span>
                                          <b>{intent.percent}</b>
                                        </button>
                                      ))
                                    ) : (
                                      <button
                                        className="pending-tag"
                                        disabled={busy}
                                        title="分析整个话题板块（含前后上下文，不只这一条）"
                                        onClick={() =>
                                          a.runScope(messages, relation, topicOf.get(m.id) ?? [m])
                                        }
                                      >
                                        {busy ? (a.progress.active?.includes(m.id) ? "分析中" : "排队中") : "分析意图"}
                                      </button>
                                    )}
                                    {(() => {
                                      const will = messageWillingness(
                                        r,
                                        gapMsBetween(
                                          messages[i - 1]?.timestamp ?? null,
                                          m.timestamp,
                                        ),
                                      );
                                      return will !== null && will < 0.35 ? (
                                        <button
                                          className="will-tag"
                                          onClick={() => setDetail(m.id)}
                                          aria-label={`接话意愿低，查看分析：${m.text}`}
                                        >
                                          {WILLINGNESS_LABELS.low}
                                        </button>
                                      ) : null;
                                    })()}
                                    <button
                                      className="rerun-tag"
                                      disabled={busy}
                                      title="重新分析这一条（覆盖现有结果，不影响其他消息）"
                                      aria-label={`重新分析：${m.text}`}
                                      onClick={() =>
                                        a.runScope(messages, relation, [m], true)
                                      }
                                    >
                                      <RotateCcw size={12} />
                                    </button>
                                  </div>
                                </>
                              ) : r ? (
                                <>
                                  <button
                                    className="reply-tag"
                                    onClick={() => setDetail(m.id)}
                                    aria-label={`${r.mode === "initiate" ? "查看发起评价" : "查看回复评价"}：${m.text}`}
                                  >
                                    <span>
                                      {r.mode === "initiate"
                                        ? "发起评级："
                                        : "回复评级："}
                                    </span>
                                    <b>
                                      {replyRating(r.score.value)?.label ??
                                        "待判断"}
                                    </b>
                                  </button>
                                  <button
                                    className="rerun-tag"
                                    disabled={busy}
                                    title="重新分析这一条（覆盖现有结果，不影响其他消息）"
                                    aria-label={`重新分析：${m.text}`}
                                    onClick={() =>
                                      a.runScope(messages, relation, [m], true)
                                    }
                                  >
                                    <RotateCcw size={12} />
                                  </button>
                                </>
                              ) : (
                                <button
                                  className="pending-tag"
                                  disabled={busy}
                                  title="分析整个话题板块（含前后上下文，不只这一条）"
                                  onClick={() =>
                                    a.runScope(messages, relation, topicOf.get(m.id) ?? [m])
                                  }
                                >
                                  {busy ? (a.progress.active?.includes(m.id) ? "分析中" : "排队中") : "评价回复"}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {selectMode && (
            <div className="select-bar">
              <span>已选 {advSel.size} 条</span>
              <button
                className="text-button"
                onClick={() =>
                  setAdvSel(
                    new Set(
                      messages
                        .filter((m) => m.kind === "text")
                        .slice(-200)
                        .map((m) => m.id),
                    ),
                  )
                }
              >
                全选(最近200)
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setSelectMode(false);
                  setAdvSel(new Set());
                }}
              >
                取消
              </button>
              <span className="adv-flex" />
              <button
                className="text-button"
                disabled={!advSel.size}
                onClick={() => {
                  a.runScope(
                    messages,
                    relation,
                    messages.filter((m) => advSel.has(m.id)),
                  );
                  setSelectMode(false);
                  setAdvSel(new Set());
                }}
              >
                分析勾选
              </button>
              <button
                className="text-button"
                disabled={!advSel.size}
                onClick={() => {
                  a.runScope(
                    messages,
                    relation,
                    messages.filter((m) => advSel.has(m.id)),
                    true,
                  );
                  setSelectMode(false);
                  setAdvSel(new Set());
                }}
              >
                重新分析勾选
              </button>
              <button
                className="primary"
                style={{ width: "auto", marginTop: 0, padding: "6px 16px" }}
                disabled={!advSel.size}
                onClick={() => {
                  setAdvOpen(true);
                  setSelectMode(false);
                }}
              >
                发给顾问 →
              </button>
            </div>
          )}
          <div className="chat-insights">
            <button
              className="reply-summary"
              onClick={() => setDetail("performance")}
            >
              <span>我的发挥</span>
              <strong>{replyRating(quality)?.label ?? "—"}</strong>
              {quality != null && <span>{quality}分</span>}
            </button>
            <span className="insight-divider" />
            <button
              className="action-summary"
              onClick={() => setDetail("action")}
            >
              <span>下一步</span>
              <strong>{actionLabel}</strong>
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="composer">
            <textarea
              aria-label="粘贴聊天记录"
              disabled={!ready}
              placeholder={
                messages.length
                  ? "粘贴新的聊天，自动合并重复记录"
                  : "在这里粘贴聊天记录…"
              }
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                scheduleLiveCheck(e.target.value);
              }}
              onPaste={(e) => {
                const t = e.clipboardData.getData("text");
                if (t.trim()) {
                  e.preventDefault();
                  setInput(t);
                  prepare(t);
                }
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                  prepare(input);
              }}
            />
            <div className="composer-bottom">
              {liveCheck && (
                <div
                  className="live-check"
                  role="status"
                  title={liveCheck.comments
                    .map((c) => `${c.quote}：${c.note}`)
                    .join("\n")}
                >
                  <span className="live-check-scores">
                    体检 · 门槛 <strong>{liveCheck.threshold}</strong>/100 · 风险{" "}
                    <strong>{liveCheck.risk}</strong>/100
                    {liveCheck.riskNote ? ` —— ${liveCheck.riskNote}` : ""}
                  </span>
                  {liveCheck.rewrite && (
                    <span className="live-check-rewrite">
                      改写：{liveCheck.rewrite}
                    </span>
                  )}
                </div>
              )}
              <div className="composer-feedback">
                <span role="status">{storageError || notice}</span>{" "}
                {busy && (
                  <div
                    className={
                      "composer-progress" +
                      (a.progress.total ? "" : " indeterminate")
                    }
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={a.progress.total || 100}
                    aria-valuenow={a.progress.done}
                  >
                    <div
                      className="composer-progress-fill"
                      style={{
                        width: a.progress.total
                          ? `${Math.max(4, Math.round((a.progress.done / a.progress.total) * 100))}%`
                          : "30%",
                      }}
                    />
                  </div>
                )}
                <div className="analysis-status" aria-live="polite">
                  {busy ? (
                    <>
                      <span className="working" />
                      正在分析 {a.progress.done}/{a.progress.total}
                      {busyElapsed > 0 && ` · 已 ${busyElapsed} 秒`}
                      <button onClick={a.cancel}>停止</button>
                    </>
                  ) : a.status === "error" ? (
                    <>
                      <span>分析未完成</span>
                      <button onClick={() => a.run(messages, relation)}>
                        <RotateCcw size={14} />
                        重试
                      </button>
                    </>
                  ) : a.status === "complete" ? (
                    <span className="completed">
                      <Check size={14} />
                      分析完成
                      <button onClick={() => setDetail("overview")}>
                        娱乐参考
                      </button>
                    </span>
                  ) : messages.length ? (
                    <>
                      <span>分析已暂停</span>
                      <button onClick={() => a.run(messages, relation)}>
                        继续分析
                      </button>
                    </>
                  ) : null}
                </div>
                {a.error && <span className="error">{a.error}</span>}
              </div>
              <button
                className="send"
                disabled={!input.trim()}
                onClick={() => prepare(input)}
              >
                <Send size={15} />
                分析聊天
              </button>
              <button
                className="bg-analyze"
                disabled={bgJob?.status === "running" || !messages.length}
                title="在服务器后台分析本会话的新消息——期间可以随意查看其他联系人"
                onClick={() => void startBackground()}
              >
                {bgJob?.status === "running" && bgJob.convId === convId.current
                  ? `后台分析中 ${bgJob.done}/${bgJob.total}`
                  : "后台分析"}
              </button>
            </div>
          </div>
        </section>
      {advOpen && (
        <aside className="advisor" style={{ width: advWidth }}>
          <div className="adv-drag" onMouseDown={startAdvDrag} aria-hidden="true" />
          <div className="adv-head">
            <strong>顾问</strong>
            <span className="adv-head-tools">
              <button
                className="icon"
                aria-label="编辑知识库"
                title="编辑知识库：写个人约定、TA 的偏好、经验规则——顾问回答相关问题时会自动检索"
                onClick={() => setSettings(true)}
              >
                <BookOpen size={16} />
              </button>
              <span className="adv-menu-wrap">
                <button
                  className="icon"
                  aria-label="对话列表"
                  aria-expanded={advMenu}
                  title="对话列表：新建对话、归档回看与改名（一个入口收纳）"
                  onClick={() => {
                    if (!advMenu) openAdvArchive(); // 打开时才拉最新列表
                    setAdvMenu((v) => !v);
                  }}
                >
                  <Archive size={16} />
                  {advArchive !== null && advArchive.length > 0 && (
                    <span className="adv-badge">{advArchive.length}</span>
                  )}
                </button>
                {advMenu && (
                  <>
                    <div className="adv-menu-backdrop" onClick={() => setAdvMenu(false)} />
                    <div className="adv-menu" role="menu">
                      <button
                        className="adv-menu-new"
                        disabled={advBusy}
                        title="归档当前对话并开一个空对话（对话不丢，在归档里回看）"
                        onClick={() => void newAdvSession()}
                      >
                        <MessageSquarePlus size={14} />
                        新建对话{advLog.length ? " · 当前对话自动归档" : ""}
                      </button>
                      <div className="adv-menu-title">
                        归档{advArchive ? ` · ${advArchive.length}` : ""}
                      </div>
                      {advArchive === null ? (
                        <small className="adv-menu-empty">加载中…</small>
                      ) : advArchive.length === 0 ? (
                        <small className="adv-menu-empty">
                          还没有归档。点「新建对话」时当前对话会自动归档，之后在这里回看、改名。
                        </small>
                      ) : (
                        advArchive.map((s, i) =>
                          renIdx === i ? (
                            <div key={s.at} className="adv-arc-row">
                              <input
                                value={renVal}
                                autoFocus
                                maxLength={60}
                                onChange={(e) => setRenVal(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void saveRename(i);
                                  if (e.key === "Escape") setRenIdx(null);
                                }}
                              />
                              <button className="text-button" onClick={() => void saveRename(i)}>
                                ✓
                              </button>
                            </div>
                          ) : (
                            <div key={s.at} className="adv-menu-row">
                              <button
                                className="adv-menu-item"
                                onClick={() => {
                                  setAdvViewIdx(i);
                                  setAdvMenu(false);
                                }}
                                title={s.title ?? "未命名"}
                              >
                                <span className="adv-menu-item-title">{s.title || "未命名"}</span>
                                <span className="adv-menu-item-meta">
                                  {new Date(s.at).toLocaleString("zh-CN", {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}{" "}
                                  · {s.log.filter((d) => d.role === "user").length} 问
                                </span>
                              </button>
                              <button
                                className="icon"
                                aria-label={`重命名归档 ${s.title ?? i}`}
                                title="重命名"
                                onClick={() => {
                                  setRenIdx(i);
                                  setRenVal(s.title ?? "");
                                }}
                              >
                                <Pencil size={14} />
                              </button>
                            </div>
                          ),
                        )
                      )}
                    </div>
                  </>
                )}
              </span>
              <button className="icon" aria-label="收起顾问" onClick={() => setAdvOpen(false)}>
                <X size={16} />
              </button>
            </span>
          </div>
          <div className="adv-session" role="status">
            {/* 模式切换移到输入框工具条（紧挨发送）——各家 agent 的惯例位置，见下方 adv-toolbar */}
            {advGoal && (
              <span title={advGoal}>
                🎯 {advGoal.length > 16 ? advGoal.slice(0, 16) + "…" : advGoal}
              </span>
            )}
            {advLog.length > 0 && (
              <span>
                {advLog.filter((d) => d.role === "user").length} 问
                {advSummary ? " · 早期对话已压缩进摘要" : ""}
              </span>
            )}
            {advLog.length > 24 && (
                <button
                  className="text-button"
                  disabled={advBusy}
                  title="对话很长时，新建对话能让顾问更聚焦（服务端已在自动压缩早期轮次）"
                  onClick={newAdvSession}
                >
                  对话已很长 · 建议新建
                </button>
              )}
          </div>
          <div className="adv-chips">
            {["给我3个具体的回复选项", "TA 现在怎么看我？", "下一步怎么走？"].map((q) => (
              <button key={q} className="text-button" disabled={advBusy || advViewIdx !== null} onClick={() => sendAdvise(q)}>
                {q}
              </button>
            ))}
            <button
              className="text-button"
              disabled={advBusy || dtBusy || advViewIdx !== null}
              onClick={() => void runDecisionTree()}
              title="根据当前上下文生成候选动作树：模拟对方回复 + 判官接球概率；输入框内容作为目标（留空=推进关系）"
            >
              {dtBusy ? "推演中…" : "生成决策树"}
            </button>
          </div>
          <div className="adv-msgs">
            {advViewIdx !== null && advArchive?.[advViewIdx] ? (
              <div className="adv-archive-view">
                <div className="adv-archive-bar">
                  <button className="text-button" onClick={() => setAdvViewIdx(null)}>
                    ← 返回当前对话
                  </button>
                  <span
                    className="adv-archive-name"
                    title={advArchive[advViewIdx]?.title ?? "未命名"}
                  >
                    {advArchive[advViewIdx]?.title || "未命名"} · 只读回看
                  </span>
                </div>
                {(advArchive[advViewIdx]?.log ?? []).map((d, i) => (
                  <p key={i} className={d.role === "user" ? "adv-user" : "adv-ai"}>
                    <strong>{d.role === "user" ? "我" : "顾问"}</strong>
                    {d.role === "assistant" ? <AdvMarkdown text={d.content} /> : d.content}
                  </p>
                ))}
              </div>
            ) : advLog.length ? (
              advLog.map((d, i) => (
                <p key={i} className={d.role === "user" ? "adv-user" : "adv-ai"}>
                  <strong>{d.role === "user" ? "我" : "顾问"}</strong>
                  {d.role === "assistant" ? <AdvMarkdown text={d.content} /> : d.content}
                </p>
              ))
            ) : (
              <p>勾选聊天记录后提问；不勾选则自动带上最近 50 条当上下文。</p>
            )}
            {advStream && (
              <div className="adv-ai adv-streaming">
                <strong>顾问</strong>
                {advStream.notes.map((n, i) => (
                  <div key={i} className="adv-note">🔧 {n}</div>
                ))}
                {advStream.reasoning && (
                  <div className="adv-reasoning">
                    💭 思考中
                    <div className="adv-reasoning-text">{advStream.reasoning.slice(-800)}</div>
                  </div>
                )}
                {advStream.content && <AdvMarkdown text={advStream.content} />}
                <span className="adv-cursor">▍</span>
              </div>
            )}
            {advBusy && <p className="segment-hint">顾问思考中…</p>}
            {advError && <p className="segment-error">{advError}</p>}
            {dtTree && (
              <div className="dt-tree" role="region" aria-label="决策树">
                <div className="dt-head">决策树 · 目标：{dtTree.intent}</div>
                {dtTree.boundary ? (
                  <div className="dt-branch dt-boundary">
                    <div className="dt-branch-head">
                      <strong>尊重边界</strong>
                      <span className="dt-prob">不推进</span>
                    </div>
                    <div className="dt-reasons">{dtTree.boundaryReasons.join("；")}</div>
                    <div className="dt-draft">{dtTree.actions[0].draft}</div>
                  </div>
                ) : (
                  dtTree.actions.map((a, i) => (
                    <div key={i} className="dt-branch">
                      <div className="dt-branch-head">
                        <strong>{a.title}</strong>
                        <span className="dt-prob">
                          {a.catchProbability == null
                            ? "未校准"
                            : `接球 ${Math.round(a.catchProbability * 100)}%`}
                        </span>
                        <span className="dt-threshold">门槛 {a.threshold}</span>
                      </div>
                      <div className="dt-draft">{a.draft}</div>
                      {a.simulations.map((s, j) => (
                        <div key={j} className={"dt-sim " + (s.valence === "积极" ? "dt-sim-pos" : "dt-sim-neg")}>
                          模拟{a.simulations.length > 1 ? j + 1 : ""}（{s.valence}）：{s.text}
                        </div>
                      ))}
                      {(a.note || a.rationale) && (
                        <div className="dt-reasons">{[a.note, a.rationale].filter(Boolean).join("；")}</div>
                      )}
                      <button
                        className="secondary cal-sent"
                        disabled={dtSentIdx.has(i)}
                        onClick={() => void markSent(a, i)}
                        title="标记这条你实际发出去了——对方回复并分析后可对账「预测 vs 实际」"
                      >
                        {dtSentIdx.has(i) ? "已记录发出" : "✔ 实际发了这条"}
                      </button>
                    </div>
                  ))
                )}
                {(() => {
                  const summary = calibrationSummary(calRecords);
                  const pending = calRecords
                    .filter((r) => r.outcome === null && r.convId === convId.current)
                    .slice(-5);
                  return (
                    <div className="cal-block">
                      <div className="cal-summary">
                        校准：已确认 {summary.n} 条 · 接住 {summary.caught} 条
                        {summary.rate != null
                          ? ` · 预测接球率 ${summary.rate}%`
                          : summary.n > 0
                            ? " · 样本不足 5 条，暂不出校准率"
                            : " · 暂无已确认样本"}
                      </div>
                      {pending.length > 0 && (
                        <div className="cal-pending">
                          <small>待确认（对方回复分析后对账）：「预测 vs 实际」</small>
                          {pending.map((r) => (
                            <div key={r.id} className="cal-pending-item">
                              <span className="hist-text">
                                {r.draft.slice(0, 50)}
                                {r.catchProbability != null
                                  ? `（预测接球 ${Math.round(r.catchProbability * 100)}%）`
                                  : ""}
                              </span>
                              <span className="cal-pending-actions">
                                <button className="secondary" onClick={() => void confirmCal(r.id, "caught")}>
                                  接住了
                                </button>
                                <button className="secondary" onClick={() => void confirmCal(r.id, "missed")}>
                                  没接
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
            {dtError && <p className="segment-error">{dtError}</p>}
          </div>
          <div className="adv-composer">
            {advCmdHint !== null &&
              (() => {
                const hit = advCmdItems.filter((i) =>
                  i.word.slice(1).toLowerCase().startsWith(advCmdHint),
                );
                return (
                  <div className="adv-cmd-pop" role="listbox" aria-label="可用指令">
                    {hit.length === 0 ? (
                      <small className="adv-menu-empty">没有匹配的指令，回车按普通问题发送</small>
                    ) : (
                      hit.map((i) => (
                        <button
                          key={i.word}
                          className="adv-cmd-item"
                          role="option"
                          onClick={() => fillAdvCmd(i.full)}
                        >
                          <code>{i.word}</code>
                          <span>{i.desc}</span>
                        </button>
                      ))
                    )}
                  </div>
                );
              })()}
            <textarea
              className="adv-textarea"
              value={advInput}
              rows={1}
              onChange={(e) => {
                setAdvInput(e.target.value);
                // 以 / 或 @ 开头且还没出现空格 → 保持联想；其余收起
                setAdvCmdHint(
                  /^[/@][\w/-]*$/i.test(e.target.value) ? e.target.value.slice(1).toLowerCase() : null,
                );
                e.target.style.height = "auto";
                e.target.style.height = Math.min(150, e.target.scrollHeight) + "px";
              }}
              disabled={advBusy || advViewIdx !== null}
              onKeyDown={(e) => {
                if (advCmdHint !== null && e.key === "Escape") {
                  setAdvCmdHint(null);
                  return;
                }
                if (advCmdHint !== null && e.key === "Enter" && !e.shiftKey) {
                  const first = advCmdItems.find((i) =>
                    i.word.slice(1).toLowerCase().startsWith(advCmdHint),
                  );
                  if (first) {
                    e.preventDefault(); // 联想开着且回车有命中 → 补全不发送
                    fillAdvCmd(first.full);
                    return;
                  }
                  // 没命中（如 /etc/hosts）→ 落到下方发送分支，按普通问题发出
                }
                if (e.key === "Enter" && !e.shiftKey && !advBusy && advViewIdx === null) {
                  e.preventDefault();
                  sendAdvise();
                }
              }}
              placeholder="问顾问：下一步怎么走？"
              maxLength={4000}
            />
            <div className="adv-toolbar">
              <button
                className="adv-tool"
                title="在聊天记录中勾选上下文"
                onClick={() => {
                  setAdvOpen(false);
                  setSelectMode(true);
                }}
              >
                已选 {advSel.size} 条 · 去勾选
              </button>
              <span className="adv-flex" />
              <select
                className="adv-model-select adv-prov-select"
                aria-label="模型供应商"
                title="先选模型供应商，再在右边选该供应商的模型"
                value={advProvBase}
                disabled={!modelConfig}
                onChange={(e) => setAdvProv(e.target.value)}
              >
                {!advProvs.length && <option value="">未配置模型</option>}
                {advProvs.map((p) => (
                  <option key={p.baseUrl} value={p.baseUrl}>
                    {provLabel(p)}
                  </option>
                ))}
              </select>
              <select
                className="adv-model-select"
                aria-label="顾问模型"
                title="顾问模型：总览与回复建议用哪个模型"
                value={advModelValue}
                disabled={!modelConfig}
                onChange={(e) => void switchModel("advisor", e.target.value)}
              >
                {!advModelValue && (
                  <option value="">{advModelOpts.length ? "选择模型…" : "未配置模型"}</option>
                )}
                {advModelOpts.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.model}
                  </option>
                ))}
                <option value="more">模型设置…</option>
              </select>
              {/* 模式切换贴发送键（agent 客户端惯例位置）：自动=顾问自己检索历史；手动=用勾选记录作上下文 */}
              <button
                className={"adv-mode" + (advMode === "auto" ? " adv-mode-on" : "")}
                aria-pressed={advMode === "auto"}
                title="自动模式：顾问自己检索历史聊天，不用勾选记录；手动模式：勾选记录作上下文（点击切换，/mode 指令同效）"
                onClick={() => {
                  const next = advMode === "auto" ? "manual" : "auto";
                  setAdvMode(next);
                  localStorage.setItem("advMode", next);
                }}
              >
                {advMode === "auto" ? "自动" : `手动${advSel.size ? ` · ${advSel.size}` : ""}`}
              </button>
              <button
                className="adv-send"
                aria-label="发送"
                disabled={advBusy || advViewIdx !== null || !advInput.trim()}
                onClick={() => sendAdvise()}
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </div>
        </aside>
      )}
      {/* 右边缘滑轨：呼出/收起按钮贴在面板本体侧，收起时是常驻可点的竖条（2026-11-13 交互修正：
          原开关在左侧导航栏，与右侧面板物理割裂；移到这里，面板收起后仍有可见入口） */}
      <button
        className={"adv-rail" + (advOpen ? " adv-rail-on" : "")}
        aria-label="顾问面板开关"
        title={advOpen ? "收起顾问面板" : "打开顾问面板"}
        aria-pressed={advOpen}
        onClick={() => setAdvOpen((v) => !v)}
      >
        <Sparkles size={14} />
        <span className="adv-rail-label">顾问</span>
      </button>
      </div>
      {importing && (
        <Modal title="确认聊天里的你" close={() => setImporting(false)}>
          <div className="role-options">
            {names
              .filter((n) => n !== "未分配")
              .map((n) => (
                <button
                  className={role === n ? "selected" : ""}
                  key={n}
                  onClick={() => setRole(n)}
                >
                  {n}
                </button>
              ))}
            {names.length === 1 && (
              <button
                className={role === "__self_absent__" ? "selected" : ""}
                onClick={() => setRole("__self_absent__")}
              >
                这些都是对方的话
              </button>
            )}
          </div>
          <label className="field">
            识别到 {parsed.length} 条聊天
            <textarea
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setParsed(parseChat(e.target.value).messages);
              }}
            />
          </label>
          {(names.length > 2 || names.includes("未分配")) && (
            <p className="error">
              请保留两个人的聊天，可改成「我：内容」「对方：内容」。
            </p>
          )}
          <button
            className="primary"
            disabled={
              !role ||
              !parsed.length ||
              names.length > 2 ||
              names.includes("未分配") ||
              (!names.includes(role) && role !== "__self_absent__")
            }
            onClick={confirmImport}
          >
            开始分析
          </button>
        </Modal>
      )}
      {modelOpen && modelConfig && (
        <Modal title="模型设置" close={() => setModelOpen(false)}>
          <ModelSettings
            initial={modelConfig}
            judgeHint={judgeHint}
            saved={(s) => {
              setJudgeHint(undefined);
              const changed = s.fingerprint !== modelConfig.fingerprint;
              setModelConfig(s);
              setModelOpen(false);
              if (changed) a.reset();
              if (messages.length && (changed || a.status !== "complete"))
                void a.run(messages, relation);
              setNotice(messages.length ? "" : "连接成功，模型设置已保存。");
            }}
          />
        </Modal>
      )}
      {settings && (
        <Modal title="聊天设置" close={() => setSettings(false)}>
          <div className="field">
            <span>主题</span>
            <div className="theme-seg">
              {(["auto", "light", "dark"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={themeMode === m ? "on" : ""}
                  onClick={() => applyAppearance(m, styleMode)}
                >
                  {m === "auto" ? "自动" : m === "light" ? "浅色" : "深色"}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>视觉风格</span>
            <div className="theme-card-grid">
              {THEME_META.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={"theme-card" + (styleMode === t.id ? " on" : "")}
                  onClick={() => applyAppearance(themeMode, t.id)}
                >
                  <span className="theme-card__head">
                    <span className="theme-card__name">{t.name}</span>
                    <span className="theme-card__tag">{t.tag}</span>
                  </span>
                  <span className="theme-card__swatches">
                    <span className="theme-card__swatch theme-card__swatch--bg" />
                    <span className="theme-card__swatch theme-card__swatch--surface" />
                    <span className="theme-card__swatch" style={{ background: t.accent }} />
                  </span>
                  <span className="theme-card__desc">{t.desc}</span>
                  {styleMode === t.id && <span className="theme-card__check">✓</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>运行日志</span>
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                const r = await fetch("/api/logs");
                const text = await r.text();
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
                a.download = "crush-monitor-logs-" + new Date().toISOString().slice(0, 10) + ".txt";
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              导出运行日志（排障用；不含聊天内容与密钥）
            </button>
          </div>
          <div className="field-row">
            <label className="field">
              TA 的 MBTI（自测标签，弱参考）
              <input
                value={profile.mbti ?? ""}
                maxLength={4}
                placeholder="如 ENFP"
                onChange={(e) =>
                  setProfile({ ...profile, mbti: e.target.value.toUpperCase() })
                }
                onBlur={() => {
                  if (messages.length) {
                    a.run(messages, relation, notes, relationCustom, profile);
                  }
                }}
              />
            </label>
            <label className="field">
              TA 的沟通风格
              <select
                value={profile.style ?? ""}
                onChange={(e) => {
                  const style = e.target.value as UserProfile["style"];
                  setProfile({
                    ...profile,
                    style: style || undefined,
                  });
                  if (messages.length) {
                    a.run(messages, relation, notes, relationCustom, {
                      ...profile,
                      style: style || undefined,
                    });
                  }
                }}
              >
                <option value="">不确定</option>
                <option value="secure">安全型：节奏与内容一致</option>
                <option value="anxious">焦虑型：常高频长消息</option>
                <option value="avoidant">回避型：常慢回短回</option>
              </select>
            </label>
          </div>
          {baseline && (
            <div className="field">
              <span>TA 的实测行为基线（机器从聊天记录统计）</span>
              <div
                style={{
                  border: "1px solid var(--line-soft)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  lineHeight: 1.7,
                  background: "var(--panel-soft)",
                }}
              >
                {describeBaseline(baseline)}
                <br />
                <small style={{ color: "var(--muted)" }}>
                  分析和顾问会自动带上这份基线："哦/嗯嗯"这类短回复是 TA
                  的常态还是异常，由这份数据校准，不靠词面猜。
                </small>
              </div>
            </div>
          )}
          <div className="field">
            <span>对方画像（长期：兴趣 / 边界雷区 / 风格 / 事件）</span>
            <div
              style={{
                border: "1px solid var(--line-soft)",
                borderRadius: 6,
                padding: "10px 12px",
                lineHeight: 1.7,
                background: "var(--panel-soft)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {!contactRef.current ? (
                <small style={{ color: "var(--muted)" }}>
                  本会话没有关联联系人 ID（微信导入的会话才有），画像不可用。
                </small>
              ) : (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <small>兴趣话题（顿号/逗号分隔 · 弱参考）</small>
                    <input
                      value={profileDraft.interests}
                      onChange={(e) =>
                        setProfileDraft({ ...profileDraft, interests: e.target.value })
                      }
                      placeholder="看展， 咖啡， 爬山"
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <small style={{ color: "#b44545" }}>
                      边界雷区（硬约束：任何候选不得提及或试探）
                    </small>
                    <input
                      value={profileDraft.boundaries}
                      onChange={(e) =>
                        setProfileDraft({ ...profileDraft, boundaries: e.target.value })
                      }
                      placeholder="前任， 工资"
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <small>沟通风格（一句话）</small>
                    <input
                      value={profileDraft.styleNote}
                      onChange={(e) =>
                        setProfileDraft({ ...profileDraft, styleNote: e.target.value })
                      }
                      placeholder="偏短句，爱用表情包"
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <small>重要事件（每行一条：「时间 备注」，时间可空）</small>
                    <textarea
                      value={profileDraft.events}
                      rows={2}
                      onChange={(e) =>
                        setProfileDraft({ ...profileDraft, events: e.target.value })
                      }
                      placeholder={"11月 期末周\n3月 生日"}
                    />
                  </label>
                  {(() => {
                    const p = (contactProfile ?? {}) as ProfileShape;
                    const mb = p.mbti;
                    // TA 自测标签沿用 userProfile.mbti（「TA 的 MBTI（自测标签）」输入框，随分析注入）
                    const declared = (profile.mbti ?? "").toUpperCase();
                    if (!mb?.type && !mb?.axes?.length && !/^[IE][SN][TF][JP]$/.test(declared))
                      return null;
                    const info = MBTI_TYPES[mb?.type ?? declared];
                    const TIER_LABEL: Record<string, string> = {
                      high: "高可信",
                      medium: "中等可信",
                      low: "低可信",
                      insufficient: "证据不足",
                    };
                    // 冲突只对 TA 推测（source=other）比对自测标签；测我本人没有自测字段，不比对
                    const conflict =
                      mb?.type != null &&
                      mb.source !== "self" &&
                      /^[IE][SN][TF][JP]$/.test(declared) &&
                      declared !== mb.type;
                    return (
                      <div
                        style={{
                          border: "1px solid var(--line)",
                          borderRadius: 6,
                          padding: "8px 10px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          background: "var(--panel-soft)",
                        }}
                      >
                        {declared && (
                          <div>
                            <strong>TA 自测：{declared}</strong>
                            {MBTI_TYPES[declared] ? `（${MBTI_TYPES[declared].label}）` : ""}{" "}
                            <small style={{ color: "var(--muted)" }}>以此为准</small>
                          </div>
                        )}
                        {mb && (
                          <div>
                            <strong>
                              {mb.type
                                ? `推测 MBTI：${mb.type}`
                                : "推测 MBTI：暂无法判断"}
                            </strong>
                            {mb.type && info && !declared ? `（${info.label}）` : ""}{" "}
                            {mb.tier && (
                              <span
                                style={{
                                  color:
                                    mb.tier === "high" || mb.tier === "medium"
                                      ? "#4a8a5e"
                                      : "#b08a3e",
                                }}
                              >
                                [{TIER_LABEL[mb.tier] ?? mb.tier}]
                              </span>
                            )}{" "}
                            <small style={{ color: "var(--muted)" }}>
                              {mb.samples != null
                                ? `基于${mb.source === "self" ? "你" : "TA"}的 ${mb.samples} 条文本 · `
                                : ""}
                              {mb.inferredAt
                                ? new Date(mb.inferredAt).toLocaleString("zh-CN", {
                                    month: "numeric",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : ""}
                            </small>
                          </div>
                        )}
                        {conflict && (
                          <small style={{ color: "#b08a3e" }}>
                            ⚠️ 与 TA 自测 {declared} 冲突：以自测为准，此推测仅作参考。
                          </small>
                        )}
                        {mb?.type && !conflict && declared && (
                          <small style={{ color: "#4a8a5e" }}>
                            ✓ 与 TA 自测一致（{declared}）
                          </small>
                        )}
                        {(mb?.axes ?? []).map((a) => (
                          <small key={a.dim}>
                            {a.dim.split(/[-/（(]/)[0]}：
                            {a.pick ? (
                              <strong>
                                {a.pick} {a.percent}%
                              </strong>
                            ) : (
                              <strong style={{ color: "#b08a3e" }}>未判清</strong>
                            )}
                            {a.reason && !a.pick ? `（${a.reason}）` : ""}
                            {a.evidence ? ` — 依据「${a.evidence}」` : ""}
                            {a.note ? (
                              <span style={{ color: "#b08a3e" }}>（{a.note}）</span>
                            ) : null}
                          </small>
                        ))}
                        {mb?.note && (
                          <small style={{ color: "#b08a3e" }}>⚠️ {mb.note}</small>
                        )}
                        {mb && (
                          <small style={{ color: "var(--muted)" }}>
                            模型推测，弱参考：仅校准语气节奏，自测类型优先
                            {mb.type ? "。" : "；证据不足的轴宁可不猜。"}
                          </small>
                        )}
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="secondary" onClick={() => void saveProfileDraft()}>
                      保存画像
                    </button>
                    <button
                      className="secondary"
                      disabled={extracting}
                      onClick={() => void extractProfileNow()}
                    >
                      {extracting ? "抽取中…" : "从聊天记录更新画像"}
                    </button>
                    <button
                      className="secondary"
                      disabled={mbtiBusy}
                      onClick={() => void inferMbtiNow("other")}
                      title="模型只看 TA 自己的消息推测四维倾向（弱参考，仅校准语气）"
                    >
                      {mbtiBusy ? "推测中…" : "推测 TA 的 MBTI"}
                    </button>
                    <button
                      className="secondary"
                      disabled={mbtiBusy}
                      onClick={() => void inferMbtiNow("self")}
                      title="模型只看你自己的消息推测你的 MBTI（弱参考）"
                    >
                      {mbtiBusy ? "推测中…" : "测我本人"}
                    </button>
                  </div>
                  {profileMsg && <small style={{ color: "var(--muted)" }}>{profileMsg}</small>}
                </>
              )}
            </div>
          </div>
          <label className="field">
            场外信息（近况、现实事件、TA 的性格等，仅作为分析背景）
            <textarea
              value={notes}
              rows={4}
              maxLength={2000}
              placeholder="例如：上周一起看过展；TA 最近在准备考试，压力很大；生日是 3 月……"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (messages.length) a.run(messages, relation, notes);
              }}
            />
          </label>
          <label className="field">
            你们的关系
            <select
              value={relation}
              onChange={(e) => {
                const r = e.target.value as Relation;
                setRelation(r);
                const label = r === relation ? relationCustom : "";
              if (messages.length) a.run(messages, r, notes, label);
              }}
            >
              {Object.entries(RELATIONS).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            自定义关系描述（可选，填写后优先于上面的选择发给模型）
            <input
              value={relationCustom}
              maxLength={120}
              placeholder="例如：分手后的暧昧期 / 网友 / 同事以上恋人未满…"
              onChange={(e) => setRelationCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && messages.length)
                  a.run(messages, relation, notes, relationCustom);
              }}
              onBlur={() => {
                if (messages.length)
                  a.run(messages, relation, notes, relationCustom);
              }}
            />
          </label>
          <button
            className="secondary"
            disabled={!messages.length}
            onClick={() => {
              const ms = messages.map((m) => ({
                ...m,
                sender:
                  m.sender === "self" ? ("other" as const) : ("self" as const),
              }));
              setSelf(other);
              setOther(self === "__self_absent__" ? "我" : self);
              setMessages(ms);
              a.reset();
              a.run(ms, relation, notes, relationCustom, profile);
              setSettings(false);
            }}
          >
            交换双方身份
          </button>
          <button className="secondary danger" onClick={clear}>
            清空聊天，重新开始
          </button>
          <div className="kb-block">
            <div className="kb-head">
              <strong>知识库（你的私人资料，顾问会自动检索）</strong>
              <button
                className="text-button"
                onClick={() =>
                  setKb([
                    ...(kb ?? []),
                    { id: "", title: "", content: "", updatedAt: "" },
                  ])
                }
              >
                ＋新增条目
              </button>
            </div>
            {kb === null ? (
              <small>读取中…</small>
            ) : (
              <>
                {kb.length === 0 && (
                  <small>
                    还没有条目。写个人约定、TA 的偏好、你的经验规则——顾问回答相关问题时会先查这里。
                  </small>
                )}
                {kb.map((e, i) => (
                  <div key={e.id || `new-${i}`} className="kb-entry">
                    <input
                      value={e.title}
                      maxLength={60}
                      placeholder="标题（如：我们的约定）"
                      onChange={(ev) =>
                        setKb(
                          kb.map((x, j) =>
                            j === i ? { ...x, title: ev.target.value } : x,
                          ),
                        )
                      }
                    />
                    <textarea
                      value={e.content}
                      maxLength={2000}
                      rows={3}
                      placeholder="内容（≤2000 字）"
                      onChange={(ev) =>
                        setKb(
                          kb.map((x, j) =>
                            j === i ? { ...x, content: ev.target.value } : x,
                          ),
                        )
                      }
                    />
                    <button
                      className="secondary danger"
                      onClick={() => setKb(kb.filter((_, j) => j !== i))}
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  className="primary"
                  disabled={kbBusy}
                  onClick={() => void saveKb()}
                >
                  {kbBusy ? "保存中…" : "保存知识库"}
                </button>
                {kbMsg && <small>{kbMsg}</small>}
              </>
            )}
          </div>
          <p>
            已保存 {messages.length.toLocaleString()}{" "}
            条聊天。记录保存在本机浏览器，刷新后可继续；分析时只发送所需片段给模型服务。清空会删除本机记录。
          </p>
        </Modal>
      )}
      {wxOpen && (
        <Modal title="从微信同步聊天记录" close={() => setWxOpen(false)}>
          <div className="wx-bar">
            <input
              value={wxQuery}
              onChange={(e) => setWxQuery(e.target.value)}
              placeholder="搜索联系人…"
            />
            <button className="secondary" disabled={wxBusy || wxSyncing} onClick={wxRefresh}>
              {wxBusy ? "处理中…" : "重新解密并刷新"}
            </button>
          </div>
          {wxError && <p className="segment-error">{wxError}</p>}
          <div className="wx-list">
            {wxList === null && <p className="segment-hint">读取中…</p>}
            {wxList?.length === 0 && <p className="segment-hint">没有可导入的记录，先跑一次导出或刷新。</p>}
            {wxList
              ?.filter((c) => !wxQuery.trim() || c.name.includes(wxQuery.trim()))
              .map((c) => (
                <label key={c.user} className="wx-row">
                  <input
                    type="checkbox"
                    className="wx-check"
                    checked={wxSel.has(c.user)}
                    disabled={wxSyncing}
                    onChange={(e) => {
                      const next = new Set(wxSel);
                      if (e.target.checked) next.add(c.user);
                      else next.delete(c.user);
                      setWxSel(next);
                    }}
                  />
                  <span className="wx-avatar">{c.name.slice(0, 1)}</span>
                  <span className="wx-name">{c.name}</span>
                  <small>{c.count} 条 · {c.last}</small>
                </label>
              ))}
          </div>
          <div className="wx-actions">
            <button
              className="secondary"
              disabled={wxSyncing || !wxList?.length}
              onClick={() =>
                setWxSel(
                  new Set(
                    (wxList ?? [])
                      .filter((c) => !wxQuery.trim() || c.name.includes(wxQuery.trim()))
                      .map((c) => c.user),
                  ),
                )
              }
            >
              全选当前
            </button>
            <button className="secondary" disabled={wxSyncing} onClick={() => setWxSel(new Set())}>
              清空
            </button>
            <button
              className="primary"
              disabled={wxSyncing || wxSel.size === 0}
              onClick={syncSelected}
            >
              {wxSyncing ? "同步中…" : `同步选中（${wxSel.size} 位）`}
            </button>
          </div>
          <p className="segment-hint">
            勾选后点「同步选中」：只同步这些联系人，未选中的自动会话会被清理（已有分析结果的保留）。已选联系人保存在本机，下次打开仍生效。
          </p>
        </Modal>
      )}
      {delConv && (
        <Modal title={`删除与 ${delConv.other} 的会话？`} close={() => setDelConv(null)}>
          <p>
            将删除 {delConv.count} 条聊天记录和全部分析结果，不可恢复。
          </p>
          <button
            className="primary"
            onClick={() => {
              const id = delConv.id;
              const isCurrent = id === convId.current;
              setDelConv(null);
              saveConversation(id, null)
                .then(refreshList)
                .catch(() => setStorageError("删除失败，请重试。"));
              if (isCurrent) {
                a.reset();
                setMessages([]);
                setInput("");
                setNotes("");
                setProfile({});
                setRelationCustom("");
                advEpoch.current++;
                // 禁写守卫①复位：不复位的话 autosave 立即把 current:null PUT 回
                // 已删会话的 adv 文件（空壳复活）（2026-11-19 bug 审查 P2）
                advLoaded.current = false;
                setAdvLog([]);
                setAdvSummary(null);
                setAdvGoal("");
                setAdvSel(new Set());
                setNotice("");
              }
            }}
          >
            删除
          </button>
          <button className="secondary" onClick={() => setDelConv(null)}>
            取消
          </button>
        </Modal>
      )}
      {detail && (
        <Modal
          title={
            detail === "overview"
              ? "好感度"
              : detail === "action"
                ? "下一步"
                : detail === "performance"
                  ? "我的发挥"
                  : chosen?.sender === "other"
                    ? "情绪、指向与意图"
                    : result?.mode === "initiate"
                      ? "发起评价"
                      : "回复评价"
          }
          close={() => setDetail(null)}
        >
          {detail === "overview" ? (
            <>
              <p>
                0—100 是模型对这段聊天的好感信号评分，不是「对方喜欢你的概率」。
              </p>
              <p>
                根据近期对话和相关历史原话评分，旧分数不参与计算。证据少时仍保留分数供娱乐参考。
              </p>
              {!!ov?.memoryEvidenceIds?.length && (
                <details>
                  <summary>参考的历史原话</summary>
                  {[...new Set(ov.memoryEvidenceIds)].map((id) => {
                    const m = messages.find((m) => m.id === id);
                    return m ? (
                      <blockquote key={id}>
                        {m.sender === "self" ? self : other}：{m.text}
                      </blockquote>
                    ) : null;
                  })}
                </details>
              )}
              {ov?.affinityDimensions && (
                <div className="affinity-breakdown">
                  {ov.affinityDimensions.map((d) => (
                    <div key={d.key}>
                      <span>{d.label}</span>
                      <meter
                        min="0"
                        max="100"
                        value={d.judgment.value ?? 0}
                        aria-label={`${d.label} ${d.judgment.value} 分`}
                      />
                      <strong>{d.judgment.value}</strong>
                      <small>
                        占 {d.weight}% · {statusLabel(d.judgment)}
                      </small>
                    </div>
                  ))}
                </div>
              )}
              {ov?.boundaryApplied && (
                <p>
                  对方表达了明确且仍有效的拒绝边界。综合原分{" "}
                  {ov.affinityRawValue}，最终好感度最多显示 25 分。
                </p>
              )}
              {(() => {
                const will = chatWillingness(messages, a.lines);
                if (will.value === null) return null;
                return (
                  <div className="will-block">
                    <p>
                      聊天意愿：<strong>{WILLINGNESS_LABELS[will.level!]}</strong>{" "}
                      · {will.value}/100
                      {will.lowStreak > 0 &&
                        ` · 最近连续 ${will.lowStreak} 条低意愿`}
                    </p>
                    {will.comfortHint && (
                      <p>
                        最近的负面情绪主要指向外部事件（工作、他人），这时候更适合先安慰，而不是退开或追问。
                      </p>
                    )}
                  </div>
                );
              })()}
              {(() => {
                if (valence.points.length)
                  return (
                    <div className="valence-block">
                      <p>
                        对方情绪水位：
                        <strong>{valence.level}</strong>/100
                        {valenceSummary.change7d != null && (
                          <span>
                            {" "}
                            · 近 7 天{valenceSummary.change7d > 0 ? "+" : ""}
                            {valenceSummary.change7d}
                          </span>
                        )}
                      </p>
                      <ValenceSpark points={sparkPoints(valence.points)} />
                      <p className="valence-hint">
                        逐条判断按半衰期 10 天衰减、单条上限 ±1
                        分聚合而成：单条误判推不动曲线，持续负向才会拉低水位。它反映对方的情绪节奏，不是好感度。
                      </p>
                      {!!valence.negatives.length && (
                        <details>
                          <summary>
                            负信号 {valence.negatives.length}{" "}
                            条（指向你或词面明确的负面）
                          </summary>
                          {[...valence.negatives]
                            .reverse()
                            .slice(0, 20)
                            .map((n) => {
                              const m = messages.find((m) => m.id === n.id);
                              return m ? (
                                <blockquote key={n.id}>
                                  {other}：{m.text}
                                </blockquote>
                              ) : null;
                            })}
                        </details>
                      )}
                    </div>
                  );
                if (messages.some((m) => m.sender === "other" && m.kind === "text"))
                  return (
                    <p className="valence-hint">
                      完成逐条分析后，这里会显示对方情绪水位曲线（本地聚合，不经过模型）。
                    </p>
                  );
                return null;
              })()}
              {ov && (
                <p>
                  本轮判断：{statusLabel(ov.affinity)}。综合确定度{" "}
                  {Math.round(ov.affinity.confidence * 100)}%。
                </p>
              )}
              <div className="segment-history">
                <div className="segment-head">
                  <strong>分段回溯</strong>
                  <button
                    className="text-button"
                    disabled={busy || a.history.running || !messages.length}
                    onClick={() => a.runSegments(messages, relation)}
                  >
                    {a.history.running
                      ? `回溯中 ${a.history.done}/${a.history.total}`
                      : "按月回溯全部历史"}
                  </button>
                </div>
                {a.history.error && <p className="segment-error">{a.history.error}</p>}
                {!!a.history.points.length && (
                  <div className="segment-list">
                    {[...a.history.points].reverse().map((p) => (
                      <div key={p.label + p.count} className="segment-row">
                        <span className="segment-time">{p.label}</span>
                        <strong>{p.affinity ?? "—"}</strong>
                        <span>{STAGES[p.stage] ?? p.stage}</span>
                        <span>{ACTIONS[p.action]?.label ?? p.action}</span>
                        <small>{p.count}条</small>
                      </div>
                    ))}
                  </div>
                )}
                <p className="segment-hint">
                  按月分段、每段独立评分，从最近一个月往前回溯；段内按时间正序阅读，消息间隔会作为节奏证据。
                </p>
              </div>
            </>
          ) : detail === "action" ? (
            <>
              <h3>{actionLabel}</h3>
              <p>
                {actionOverview
                  ? ACTIONS[actionOverview.action]?.detail
                  : busy
                    ? "正在根据最新聊天更新建议。"
                    : messages.length
                      ? "最新聊天的建议尚未更新，请重新分析。"
                      : "导入后生成建议。"}
              </p>
              {actionOverview?.actionEvidenceId && (
                <blockquote>
                  {
                    messages.find(
                      (m) => m.id === actionOverview.actionEvidenceId,
                    )?.text
                  }
                </blockquote>
              )}
              {!actionOverview && !busy && !!messages.length && (
                <button onClick={() => a.run(messages, relation, notes, relationCustom)}>
                  重新分析
                </button>
              )}
            </>
          ) : detail === "performance" ? (
            <>
              <div className="detail-score">
                {quality ?? "—"}
                <span>/100</span>
              </div>
              <p>
                已完成分析的我方回复平均分。模型
                根据发出时的前文评价表达质量，再按固定分数区间显示评级。
              </p>
              <div className="reply-guide">
                {REPLY_RATINGS.map((v) => (
                  <p key={v.label}>
                    <strong>
                      {v.label} · {v.range} 分
                    </strong>
                    ：{v.description}
                  </p>
                ))}
              </div>
            </>
          ) : (
            <>
              <blockquote>{chosen?.text}</blockquote>
              {chosen?.sender === "other" ? (
                <>
                  <h3>情绪</h3>
                  <div className="emotion-distribution">
                    {Object.entries(result?.emotions || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, p]) => (
                        <div key={key}>
                          <span>
                            {EMOTIONS[key as keyof typeof EMOTIONS]?.label ||
                              key}
                          </span>
                          <div className="probability-track">
                            <i style={{ width: `${p * 100}%` }} />
                          </div>
                          <b>
                            {p > 0 && p < 0.005
                              ? "<1%"
                              : `${Math.round(p * 100)}%`}
                          </b>
                        </div>
                      ))}
                  </div>
                  <h3 className="intent-detail-heading">指向</h3>
                  <div className="intent-distribution">
                    {Object.entries(result?.targets || {})
                      .filter(([key, p]) => key in TARGETS && p > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, p]) => (
                        <div key={key} className="intent-detail-item">
                          <div>
                            <strong>
                              {TARGETS[key as keyof typeof TARGETS].label}
                            </strong>
                            <b>
                              {p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`}
                            </b>
                          </div>
                          <p>{TARGETS[key as keyof typeof TARGETS].criteria}</p>
                        </div>
                      ))}
                    {!result?.targets && <p>指向尚未分析。</p>}
                  </div>
                  <h3 className="intent-detail-heading">意图</h3>
                  <div className="intent-distribution">
                    {Object.entries(result?.intents || {})
                      .filter(([key, p]) => key in INTENTS && p > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, p]) => (
                        <div key={key} className="intent-detail-item">
                          <div>
                            <strong>
                              {INTENTS[key as keyof typeof INTENTS].label}
                            </strong>
                            <b>
                              {p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`}
                            </b>
                          </div>
                          <p>{INTENTS[key as keyof typeof INTENTS].criteria}</p>
                        </div>
                      ))}
                    {!result?.intents && <p>意图尚未分析。</p>}
                  </div>
                  <p>
                    三行分别展示主要情绪、情绪指向与主要沟通意图的候选解读，不代表测量真实内心。保留原始概率，不重新凑成
                    100%。
                  </p>
                </>
              ) : (
                <>
                  <h3 className="reply-verdict">
                    {result?.mode === "initiate" ? "发起评级：" : "回复评级："}
                    {replyRating(result?.score.value)?.label ?? "待判断"}
                  </h3>
                  <p>
                    {replyRating(result?.score.value)?.description ??
                      "当前语境不足以判断表达质量"}
                  </p>
                  <p>
                    表达评分 {result?.score.value ?? "—"} / 100 ·{" "}
                    {result && statusLabel(result.score)}
                  </p>
                </>
              )}
              <p>结合当前已导入的上下文判断，不代表对方真实想法。</p>
            </>
          )}
        </Modal>
      )}
      {overlap && (
        <Modal title="这段可能重复了" close={() => setOverlap(null)}>
          <p>相同内容也可能是新消息，请选择如何合并。</p>
          <button
            className="primary"
            onClick={() => {
              add(overlap, "skip");
              setOverlap(null);
            }}
          >
            跳过重合部分
          </button>
          <button
            className="secondary"
            onClick={() => {
              add(overlap, "append");
              setOverlap(null);
            }}
          >
            作为新消息追加
          </button>
        </Modal>
      )}
    </main>
  );
}
