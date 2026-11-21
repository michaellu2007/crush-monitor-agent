import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { analyze, requestSchema } from "./analysis";
import { ConfigurationError } from "./provider-config";
// 本地 judge 生成大批次 JSON 时长时间不返回首字节，undici 默认 5 分钟
// 响应头超时会先于应用层 600s 超时把请求砍掉（表现为"网络不可达"）。
// 对齐到 judge 上限并留余量；云 API 首字节快，不受影响。
setGlobalDispatcher(new Agent({ headersTimeout: 660_000, bodyTimeout: 660_000 }));
import {
  activeConfig,
  configFingerprint,
  judgeConfig,
  publicSettings,
} from "./model-config";
import { z } from "zod";
import { installLogRing, getLogText } from "./logger";

// 运行日志环形缓冲：越早安装越能收全启动期日志
installLogRing();
import { settingsRouter } from "./settings-api";
import { advise, adviseErrorMessage, checkDraft, compactNow } from "./advise";
import {
  readProfile,
  saveProfile,
  deleteProfile,
} from "./profile-store";
import { extractProfile, inferMbti } from "./profile-extract";
import { getSearchDb, syncHistoryIndex } from "./history-search";
import { buildDecisionTree } from "./decision-tree";
import {
  startBackgroundAnalyze,
  getBackgroundJob,
  cancelBackgroundAnalyze,
} from "./background-analyze";
import {
  addCalibration,
  listCalibration,
  confirmCalibration,
} from "./calibration-store";
import {
  initStorage,
  readConversation,
  writeConversation,
  mergeConversationWrite,
  listConversationIds,
  getLastConvId,
  setLastConvId,
} from "./conv-store";
import { listChats, refresh, mediaFilePath, avatarFileFor } from "./wechat";
import { stickerImageFile } from "./media-store";
import { ProviderError, providerErrorMessage } from "./provider";
import { claim, held, holderIsDesktop, release } from "./page-lock";
import { startWatch, runWatchCycle, readAlerts, ackAlerts } from "./watch";
import { loadKnowledge, saveKnowledge } from "./knowledge-store";
import { archiveCurrent, loadAdv, renameArchived, saveCurrent, deleteAdvFile } from "./adv-store";
const app = express();
app.disable("x-powered-by");
initStorage();
app.use("/api/conversations", express.json({ limit: "64mb" }));
// 顾问会话归档/保存：对话日志可达 200 轮×长回复，512kb 全局上限会 413 静默丢档
app.use("/api/adv", express.json({ limit: "16mb" }));
app.use(express.json({ limit: "512kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});
// Host allowlist prevents a DNS-rebound website from reading the local config token.
app.use("/api", (req, res, next) => {
  const host = req.headers.host || "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    res.status(403).json({ error: "请使用本机地址访问。" });
    return;
  }
  const origin = req.headers.origin;
  const allowed = [
    `http://${host}`,
    "http://127.0.0.1:5178",
    "http://localhost:5178",
  ];
  if (origin && !allowed.includes(origin)) {
    res.status(403).json({ error: "请求来源不允许" });
    return;
  }
  next();
});
app.use("/api/settings", settingsRouter);
app.get("/api/conversations", (_req, res) => {
  const conversations = [];
  for (const id of listConversationIds()) {
    const s: any = readConversation(id);
    // messages 缺失=文件损坏（写入中断残留）：跳过而不是让整个列表接口 500
    if (!s || s.schema !== 1 || !Array.isArray(s.messages)) continue;
    conversations.push({
      id,
      other: s.other,
      contactId: s.contactId,
      relation: s.relation,
      at: s.messages.at(-1)?.timestamp ?? "",
      count: s.messages.length,
      preview: (s.messages.at(-1)?.text ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 32),
    });
  }
  res.json({ conversations });
});
// 顾问会话归档存储（2026-11-18）：data/adv/<convId>.json（current + archived cap10）。
// 取代 saved.adv 双写——服务端磁盘为单一事实源，桌面/网页入口共享。
app.get("/api/adv/:convId", (req, res) => {
  res.json(loadAdv(String(req.params.convId)));
});
app.put("/api/adv/:convId", (req, res) => {
  const body = req.body as any;
  const cur = body?.current;
  if (cur != null && !Array.isArray(cur?.log)) {
    res.status(400).json({ error: "current.log 必须是数组。" });
    return;
  }
  saveCurrent(String(req.params.convId), cur ?? null);
  res.json({ ok: true });
});
app.patch("/api/adv/:convId/archive/:idx", (req, res) => {
  const idx = Number(req.params.idx);
  const title = String((req.body as any)?.title ?? "");
  const ok = renameArchived(String(req.params.convId), idx, title);
  if (!ok) {
    res.status(404).json({ error: "归档条目不存在。" });
    return;
  }
  res.json({ ok: true });
});
app.post("/api/adv/:convId/archive", (req, res) => {
  const body = req.body as any;
  const n = archiveCurrent(String(req.params.convId), body?.current);
  res.json({ ok: true, archived: n });
});
// 用户自配知识库（2026-11-18）：顾问 search_knowledge 工具的数据源，全局作用域。
// GET 读；PUT 整表替换（服务端钳制条数/长度，见 knowledge-store）。
app.get("/api/knowledge", (_req, res) => {
  res.json({ entries: loadKnowledge() });
});
app.put("/api/knowledge", (req, res) => {
  const list = (req.body as any)?.entries;
  if (!Array.isArray(list)) {
    res.status(400).json({ error: "entries 必须是数组。" });
    return;
  }
  res.json({ ok: true, entries: saveKnowledge(list) });
});
app.get("/api/conversations/:id", (req, res) => {
  const s = readConversation(req.params.id);
  if (!s) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(s);
});
app.put("/api/conversations/:id", (req, res) => {
  const id = String(req.params.id);
  if (id.length > 120) {
    res.status(400).json({ error: "id 过长" });
    return;
  }
  // 合并写：前端快照可能落后于服务端（后台分析/同步刚写入的 lines/overview），
  // 直接覆盖会把分析结果抹掉（2026-11-19 bug 审查 P1）
  mergeConversationWrite(id, req.body ?? null);
  res.json({ ok: true });
});
app.delete("/api/conversations/:id", (req, res) => {
  const id = String(req.params.id);
  // 连带清理衍生数据：FTS 索引行 / 顾问对话（含归档）/ 对方画像——
  // 此前删除不清衍生，已删会话仍能被搜索命中原文（2026-11-19 bug 审查 P2）
  const conv = readConversation(id) as { contactId?: string } | undefined;
  const contactId = String(conv?.contactId ?? "");
  writeConversation(id, null);
  try {
    getSearchDb().deleteConversation(id);
  } catch {
    /* 索引清理失败不阻断删除（下次懒同步也不会复活已删会话的索引行） */
  }
  try {
    deleteAdvFile(id);
  } catch {
    /* 同上 */
  }
  if (contactId) {
    try {
      deleteProfile(contactId);
    } catch {
      /* 同上 */
    }
  }
  res.json({ ok: true });
});
app.get("/api/meta/last-conv", (_req, res) => {
  res.json({ lastConvId: getLastConvId() });
});
app.put("/api/meta/last-conv", (req, res) => {
  if (typeof req.body?.lastConvId === "string" && req.body.lastConvId.length <= 120)
    setLastConvId(req.body.lastConvId);
  res.json({ ok: true });
});
// 主动预警：后台定时跑 shared/watch-rules 的确定性规则（零模型调用）；
// 这三个接口是预警的读/已读/手动入口（铃铛「立即检查」与 curl 共用）。
app.get("/api/alerts", (_req, res) => {
  res.json(readAlerts());
});
app.post("/api/alerts/ack", (req, res) => {
  const raw = req.body?.ids;
  const ids = Array.isArray(raw)
    ? raw.filter((x: unknown): x is string => typeof x === "string")
    : undefined;
  const acked = ackAlerts(ids);
  res.json({ ok: true, acked, ...readAlerts() });
});
app.post("/api/alerts/check", (_req, res) => {
  try {
    const r = runWatchCycle({ force: true });
    res.json({ ok: true, checked: r.checked, added: r.added, ...readAlerts() });
  } catch (e) {
    res.status(500).json({ error: `检查失败：${(e as Error).message}` });
  }
});
// 单页面锁：第二个页面拿到 409 后只显示提示、不挂载应用(见 src/main.tsx)。
// 微信式生命周期：托盘是应用的锚,关页面/关窗口不退出;出口 = 托盘右键退出 / 应用内电源按钮 / 停止.bat。
let trayProc: ReturnType<typeof spawn> | null = null;
// 收工:结束 4090 隧道(重启循环的 cmd + 占 11435 的 ssh)和托盘。
// detached 派生让收工脚本在本进程退出后跑完;ollama 刻意不动,模型驻留显存保住热启动。
function killTunnelAndExit() {
  console.log("[exit] 退出应用,服务与隧道已收工。");
  try {
    trayProc?.kill();
    // ponytail: 同步跑完再退,杜绝 detached 子进程被垂死父进程带走的句柄竞态;服务正在退出,阻塞无感
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(dirname(fileURLToPath(import.meta.url)), "../scripts/kill-tunnel.ps1"),
      ],
      { timeout: 8_000, stdio: "ignore" },
    );
  } catch {
    /* 尽力而为:超时/失败也要退出 */
  }
  process.exit(0);
}
function startTray() {
  // ponytail: 不用 detached——托盘本来就该与服务同生共死,且 WinForms 在 detached 无控制台进程里起不来
  trayProc = spawn(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      join(dirname(fileURLToPath(import.meta.url)), "../scripts/crush-tray.ps1"),
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  trayProc.unref();
}
// 退出按钮:页面点了立刻收工。
app.post("/api/shutdown", (req, res) => {
  const origin = req.headers.origin;
  if (origin && origin !== `${req.protocol}://${req.headers.host}`) {
    res.status(403).json({ error: "请求来源不允许" });
    return;
  }
  if (process.env.CRUSH_PAGE_EXIT_STOP !== "1" && process.env.CRUSH_ELECTRON !== "1") {
    res.status(403).json({ error: "仅启动器模式支持退出按钮" });
    return;
  }
  res.json({ ok: true });
  setTimeout(() => killTunnelAndExit(), 300); // 让响应先送达
});
// 托盘「打开应用」:有活页面就调到前台,否则补开一个
app.get("/api/open", (_req, res) => {
  res.json({ ok: true });
  const url = `http://127.0.0.1:${port}/`;
  if (held()) void focusWindow();
  else openBrowser(url);
});
app.get("/api/page", (_req, res) => {
  res.json({
    held: held(),
    uptime: Math.round(process.uptime()),
    desktop: process.env.CRUSH_ELECTRON === "1",
    holderDesktop: holderIsDesktop(),
  });
});
app.post("/api/page", (req, res) => {
  const token = String(req.body?.token ?? "");
  if (!/^[\w-]{1,64}$/.test(token)) {
    res.status(400).json({ error: "无效的页面令牌" });
    return;
  }
  if (req.body?.release) {
    release(token);
    res.json({ ok: true });
    return;
  }
  // 只有桌面壳窗口算"桌面持有者"：main.mjs 用 ?shell=1 打开页面，页面认领时原样回传该标记。
  // 不再用 UA 判 Electron/——OpenCode 等 Electron 系工具的 UA 同样带 Electron/，会冒充桌面窗口
  // 抢走锁，把真桌面窗顶成"已在另一窗口打开"（2026-11-21 实测）
  const desktop = req.body?.shell === true;
  if (!claim(token, Date.now(), desktop)) {
    res.status(409).json({ held: true });
    return;
  }
  res.json({ ok: true });
});
// 日志导出（排障用）：运行日志环形缓冲 + 版本/运行时摘要。模型密钥永不入内
// （publicSettings 脱敏视图只带 hasKey 布尔），聊天原文不进日志环。
const APP_VERSION = (() => {
  try {
    return JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
    ).version as string;
  } catch {
    return "unknown";
  }
})();
app.get("/api/logs", (_req, res) => {
  const ps = publicSettings();
  const text = [
    "Crush Monitor Agent 日志导出",
    "版本: " + APP_VERSION,
    "运行时长: " + Math.round(process.uptime()) + "s",
    "运行环境: " + process.platform + " / node " + process.version,
    "模型配置(脱敏): " +
      JSON.stringify({
        preset: ps.preset,
        baseUrl: ps.baseUrl,
        model: ps.model,
        configured: ps.configured,
        hasKey: ps.hasKey,
        fingerprint: ps.fingerprint,
        judge: ps.judge,
      }),
    "",
    "———— 运行日志（环形缓冲，最近约 2000 条）————",
    getLogText(),
  ].join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="crush-monitor-logs.txt"');
  res.send(text);
});
app.get("/api/health", (_req, res) => {
  const s = publicSettings();
  let fingerprint = s.fingerprint;
  try {
    fingerprint = configFingerprint(judgeConfig() ?? activeConfig());
  } catch {
    /* 未配置模型时保留 publicSettings 的指纹 */
  }
  const judge = judgeConfig();
  res.json({
    configured: s.configured,
    engine: s.protocol === "jev" ? "jev" : "llm",
    provider: s.preset,
    model: s.model,
    fingerprint,
    judge: judge ? { enabled: true, model: judge.model } : { enabled: false },
  });
});
// 本地 judge 状态：模型是否驻留显存、驻留到什么时候（Ollama /api/ps）
app.get("/api/judge/status", async (_req, res) => {
  const judge = judgeConfig();
  if (!judge) return res.json({ enabled: false });
  if (judge.protocol === "jev")
    return res.json({ enabled: true, model: judge.model, reachable: false, jev: true });
  try {
    const r = await fetch(new URL(judge.endpoint).origin + "/api/ps", {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await r.json()) as {
      models?: { name: string; size_vram?: number; expires_at?: string }[];
    };
    res.json({
      enabled: true,
      model: judge.model,
      reachable: r.ok,
      models: (data.models ?? []).map((m) => ({
        name: m.name,
        vramMB: Math.round((m.size_vram ?? 0) / 1048576),
        expiresAt: m.expires_at ?? null,
      })),
    });
  } catch {
    res.json({
      enabled: true,
      model: judge.model,
      reachable: false,
      models: [],
    });
  }
});
// 预热：强制加载模型（num_predict=1），返回加载耗时——分析前点一下，避免冷启动。
// keep_alive="30m"：Ollama 默认只驻留 5 分钟，预热到点"开始分析"间隔一长就白热身；
// 30m 兼顾桌面版显存共存（不 -1 常驻），全局常驻走 OLLAMA_KEEP_ALIVE=-1。
// 策略定稿见 docs/agent上下文设计.md §3.5。
app.post("/api/judge/warmup", async (_req, res) => {
  const judge = judgeConfig();
  if (!judge)
    return res.status(400).json({ ok: false, error: "未启用评估模型" });
  if (judge.protocol === "jev")
    return res
      .status(400)
      .json({ ok: false, error: "Jev 原生判官（systemone 读出服务）无预热接口" });
  const t0 = performance.now();
  try {
    const r = await fetch(new URL(judge.endpoint).origin + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: judge.model,
        prompt: "ok",
        stream: false,
        keep_alive: "30m",
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(judge.timeoutMs ?? 600000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = (await r.json()) as { load_duration?: number };
    res.json({
      ok: true,
      loadMs: Math.round((data.load_duration ?? 0) / 1e6),
      totalMs: Math.round(performance.now() - t0),
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: "预热失败：" + (e instanceof Error ? e.message : "未知错误"),
    });
  }
});
let calls = 0;
let windowAt = Date.now();
let active = 0;
const budgets = new Map<string, { count: number; at: number }>();
const selectionFile = () => join(process.cwd(), "data", "media-export", "contacts.json");
app.get("/api/wechat/selection", (_req, res) => {
  try {
    const raw = readFileSync(selectionFile(), "utf8");
    const wxids = JSON.parse(raw);
    res.json({ wxids: Array.isArray(wxids) ? wxids.map(String) : [] });
  } catch {
    res.json({ wxids: [] });
  }
});
app.put("/api/wechat/selection", (req, res) => {
  const wxids = Array.isArray(req.body?.wxids) ? req.body.wxids : null;
  if (
    !wxids ||
    wxids.length > 500 ||
    wxids.some((x: unknown) => typeof x !== "string" || !x || x.length > 120)
  ) {
    res.status(400).json({ error: "无效的联系人选择" });
    return;
  }
  try {
    mkdirSync(dirname(selectionFile()), { recursive: true });
    writeFileSync(selectionFile(), JSON.stringify(wxids), "utf8");
    res.json({ ok: true, count: wxids.length });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message || e) });
  }
});
app.post("/api/wechat/sync", (_req, res) => {
  // 防重入：全量同步是重活（解密+读消息+图片），并发跑会互相踩
  if ((globalThis as { __wxSyncBusy?: boolean }).__wxSyncBusy) {
    res.status(409).json({ error: "已有一次微信同步在进行中，请等它完成" });
    return;
  }
  (globalThis as { __wxSyncBusy?: boolean }).__wxSyncBusy = true;
  // 统一派生：桌面版下 process.execPath 是 electron.exe，配 ELECTRON_RUN_AS_NODE 转纯 Node；
  // dev 下是 node.exe，该标志被忽略——两种环境同一写法，且不依赖机器装了 npm/npx
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(
    process.execPath,
    [join(here, "../node_modules/tsx/dist/cli.mjs"), join(here, "../scripts/media-export/sync.ts")],
    {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  let out = "";
  const timer = setTimeout(() => child.kill(), 600_000);
  child.stdout?.on("data", (d) => {
    out += String(d);
    if (out.length > 20_000) out = out.slice(-20_000);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
    if (out.length > 20_000) out = out.slice(-20_000);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    (globalThis as { __wxSyncBusy?: boolean }).__wxSyncBusy = false;
    if (code === 0) res.json({ ok: true, output: out.slice(-4000) });
    else res.status(500).json({ error: "同步失败", output: out.slice(-4000) });
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    (globalThis as { __wxSyncBusy?: boolean }).__wxSyncBusy = false;
    res.status(500).json({ error: String(err.message) });
  });
});
app.get("/api/wechat/chats", (_req, res) => {
  try {
    res.json({ chats: listChats() });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message || e) });
  }
});
app.get("/api/wechat/avatar", async (req, res) => {
  // 联系人头像：?u=<wxid>（或 self）→ 解密库 CDN 链接抓取/本地缓存；wxid 必须在联系人表内
  const hit = await avatarFileFor(String(req.query.u ?? ""));
  if (!hit) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", hit.type);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(hit.file);
});

app.get("/api/wechat/media", async (req, res) => {
  // 表情包：?md5= 走 emoticon.db → cdn_url 下载缓存；图片：?f= 走已解密的本地 dat
  const md5 = String(req.query.md5 ?? "");
  if (/^[0-9a-f]{32}$/i.test(md5)) {
    const f = await stickerImageFile(md5);
    if (!f) {
      res.status(404).end();
      return;
    }
    res.sendFile(f);
    return;
  }
  const f = mediaFilePath(String(req.query.f ?? ""));
  if (!f) {
    res.status(404).end();
    return;
  }
  res.sendFile(f);
});
app.post("/api/wechat/refresh", async (_req, res) => {
  try {
    await refresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message || e) });
  }
});
// 发前体检：草稿 → 本地判官三维评分+逐句点评+改写（判官未配置时 available:false）
// 流式顾问对话（2026-11-18）：SSE 推 reasoning/note/delta 增量，done 收尾（与 /api/advise 同构返回）。
// 任何阶段出错都转 error 事件（HTTP 200 + event-stream，前端按事件处理）。
app.post("/api/advise/stream", async (req, res) => {
  const configuration = publicSettings();
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
  };
  try {
    if (!configuration.configured) {
      send("error", { error: "请先打开模型设置，填写 API Key 并检测连接。" });
      res.end();
      return;
    }
    const out = await advise(req.body, send);
    send("done", out);
  } catch (e) {
    send("error", { error: adviseErrorMessage(e) });
  }
  res.end();
});
// /compact 指令后端：立即压缩顾问对话历史，返回新摘要（不生成回答）
app.post("/api/advise/compact", async (req, res) => {
  const configuration = publicSettings();
  if (!configuration.configured) {
    res.status(503).json({ error: "请先打开模型设置，填写 API Key 并检测连接。" });
    return;
  }
  try {
    res.json(await compactNow(req.body));
  } catch (e) {
    const status =
      e instanceof z.ZodError
        ? 400
        : typeof (e as any)?.status === "number"
          ? (e as any).status
          : 500;
    res.status(status).json({ error: adviseErrorMessage(e) });
  }
});
app.post("/api/advise/check", async (req, res) => {
  try {
    res.json(await checkDraft(req.body));
  } catch (e) {
    const status =
      typeof (e as any)?.status === "number" ? (e as any).status : 500;
    res.status(status).json({ error: adviseErrorMessage(e) });
  }
});
// 对方画像 v1：按联系人持久化（data/profiles/）；extract 用顾问模型低频批量抽取
app.get("/api/profile/:contactId", (req, res) => {
  res.json({ profile: readProfile(String(req.params.contactId)) });
});
app.put("/api/profile/:contactId", (req, res) => {
  const id = String(req.params.contactId ?? "");
  if (!id || id.length > 120) {
    res.status(400).json({ error: "contactId 无效" });
    return;
  }
  try {
    res.json({ ok: true, profile: saveProfile(req.body, id) });
  } catch {
    res.status(400).json({ error: "画像格式不正确" });
  }
});
app.post("/api/profile/:contactId/extract", async (req, res) => {
  const id = String(req.params.contactId ?? "");
  if (!id || id.length > 120) {
    res.status(400).json({ error: "contactId 无效" });
    return;
  }
  try {
    const profile = await extractProfile(id);
    if (!profile) {
      res.status(404).json({ error: "找不到该联系人的会话" });
      return;
    }
    res.json({ ok: true, profile });
  } catch (e) {
    const status =
      typeof (e as any)?.status === "number" ? (e as any).status : 500;
    res.status(status).json({ error: adviseErrorMessage(e) });
  }
});
// 后台分析：服务端自己跑增量分析（前端只看进度，期间可随意浏览其他联系人）
app.post("/api/analyze/background", (req, res) => {
  const convId = String(req.body?.convId ?? "");
  if (!convId || convId.length > 120) {
    res.status(400).json({ error: "convId 无效" });
    return;
  }
  const r = startBackgroundAnalyze(convId, Boolean(req.body?.forceAll));
  if (!r.ok) {
    res.status(409).json({ error: r.error });
    return;
  }
  res.json({ ok: true, job: r.job });
});
app.get("/api/analyze/background", (_req, res) => {
  res.json({ job: getBackgroundJob() });
});
app.post("/api/analyze/background/cancel", (_req, res) => {
  res.json({ ok: cancelBackgroundAnalyze() });
});
// MBTI 推测（弱参考）：模型从聊天记录推四维倾向，存入画像 mbti 字段
// body.side: "other"（默认，推测对方）| "self"（用你自己的消息推测你本人）
app.post("/api/profile/:contactId/mbti", async (req, res) => {
  const id = String(req.params.contactId ?? "");
  if (!id || id.length > 120) {
    res.status(400).json({ error: "contactId 无效" });
    return;
  }
  const side = req.body?.side === "self" ? "self" : "other";
  try {
    const profile = await inferMbti(id, side);
    if (!profile) {
      res.status(404).json({ error: "找不到该联系人的会话" });
      return;
    }
    res.json({ ok: true, profile });
  } catch (e) {
    const status =
      typeof (e as any)?.status === "number" ? (e as any).status : 500;
    res.status(status).json({ error: adviseErrorMessage(e) });
  }
});
// 决策树 v1：意图 → 候选动作 → 模拟对方回复 → 判官接球概率（边界模式只出"尊重边界"）
app.post("/api/decision-tree", async (req, res) => {
  try {
    res.json(await buildDecisionTree(req.body));
  } catch (e) {
    const status =
      typeof (e as any)?.status === "number" ? (e as any).status : 500;
    res.status(status).json({ error: adviseErrorMessage(e) });
  }
});
// 闭环校准（任务单 F v0）：树节点标记「实际发出」→ 待确认清单 → 人工确认落定
app.post("/api/decision-tree/feedback", (req, res) => {
  const convId = String(req.body?.convId ?? "");
  const draft = String(req.body?.draft ?? "");
  if (!convId || convId.length > 120 || !draft.trim()) {
    res.status(400).json({ error: "convId 与 draft 必填" });
    return;
  }
  const record = addCalibration({
    convId,
    intent: String(req.body?.intent ?? ""),
    draft,
    actionIndex: Number.isFinite(req.body?.actionIndex)
      ? Number(req.body.actionIndex)
      : 0,
    catchProbability:
      typeof req.body?.catchProbability === "number"
        ? req.body.catchProbability
        : null,
  });
  res.json({ ok: true, record });
});
app.get("/api/decision-tree/feedback", (req, res) => {
  const convId =
    typeof req.query.convId === "string" && req.query.convId
      ? req.query.convId
      : undefined;
  res.json({ records: listCalibration(convId) });
});
app.post("/api/decision-tree/feedback/confirm", (req, res) => {
  const id = String(req.body?.id ?? "");
  const outcome = req.body?.outcome;
  if (!id || (outcome !== "caught" && outcome !== "missed")) {
    res.status(400).json({ error: "id 与 outcome(caught|missed) 必填" });
    return;
  }
  const evidenceMsgId =
    typeof req.body?.evidenceMsgId === "string"
      ? req.body.evidenceMsgId
      : undefined;
  const n = confirmCalibration(id, outcome, evidenceMsgId);
  if (!n) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  const convId =
    typeof req.body?.convId === "string" ? req.body.convId : undefined;
  res.json({ ok: true, records: listCalibration(convId) });
});
// 历史检索（RAG-lite）：q=关键词，contact=联系人（必填——严格单联系人作用域）
app.get("/api/history/search", async (req, res) => {
  const contact = String(req.query.contact ?? "");
  const q = String(req.query.q ?? "").slice(0, 200);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  if (!contact) {
    res.status(400).json({ error: "缺少 contact 参数（检索严格限定单联系人作用域）" });
    return;
  }
  if (!q.trim()) {
    res.json({ results: [], total: 0 });
    return;
  }
  try {
    // 微信同款：纯关键词 FTS（毫秒级）。故意不走向量混合路——每次搜索 embed 查询词
    // 会排在后台全量向量化后面，把"搜索中…"卡成几十秒；语义检索交给顾问对话的 RAG。
    // 先响应后懒同步：syncHistoryIndex 内部是同步重活，放前面会把本请求堵死。
    const results = getSearchDb().search(q, contact, limit);
    res.json({ results, total: results.length });
  } catch (e) {
    res.status(500).json({ error: `检索失败：${(e as Error).message}` });
    return;
  }
  void syncHistoryIndex().catch(() => {}); // 懒同步失败不阻断检索（旧索引仍可用）
});
app.post("/api/analyze", async (req, res) => {
  const origin = req.headers.origin;
  if (
    origin &&
    origin !== `${req.protocol}://${req.headers.host}` &&
    !["http://127.0.0.1:5178", "http://localhost:5178"].includes(origin)
  ) {
    res.status(403).json({ error: "请求来源不允许" });
    return;
  }
  const valid = requestSchema.safeParse(req.body);
  if (!valid.success) {
    res.status(400).json({ error: "聊天结构或长度不符合要求，请校正后重试" });
    return;
  }
  const configuration = publicSettings();
  if (!configuration.configured) {
    res
      .status(503)
      .json({ error: "请先打开模型设置，填写 API Key 并检测连接。" });
    return;
  }
  const now = Date.now();
  if (now - windowAt > 3600000) {
    calls = 0;
    windowAt = now;
    budgets.clear();
  }
  const key = req.ip || "local";
  let entry = budgets.get(key);
  if (!entry || now - entry.at > 60000) {
    entry = { count: 0, at: now };
    budgets.set(key, entry);
  }
  if (entry.count >= 180 || calls >= 3000 || active >= 8) {
    res.setHeader(
      "Retry-After",
      String(
        calls >= 3000
          ? Math.max(1, Math.ceil((windowAt + 3600000 - now) / 1000))
          : Math.max(1, Math.ceil((entry.at + 60000 - now) / 1000)),
      ),
    );
    res.status(429).json({ error: "分析请求较多，已保留进度，请稍后继续" });
    return;
  }
  entry.count++;
  calls++;
  active++;
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const config = judgeConfig() ?? activeConfig();
    const expected = req.get("x-model-fingerprint");
    if (expected && expected !== configFingerprint(config)) {
      res.status(409).json({ error: "模型配置已更改，请重新开始分析。" });
      return;
    }
    const result = await analyze(valid.data, controller.signal, config);
    if (configFingerprint(judgeConfig() ?? activeConfig()) !== configFingerprint(config)) {
      res.status(409).json({ error: "模型配置已更改，请重新开始分析。" });
      return;
    }
    res.json(result);
  } catch (error) {
    const code = Number((error as { status?: number }).status) || 502;
    if (!res.headersSent && !controller.signal.aborted)
      res.status(code >= 400 && code < 600 ? code : 502).json({
        error:
          error instanceof ConfigurationError || error instanceof ProviderError
            ? error.message
            : providerErrorMessage(error),
      });
  } finally {
    active--;
  }
});
const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
app.use(express.static(dist));
app.get("/", (_req, res) => res.sendFile(join(dist, "index.html")));
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res
      .status(
        (err as { type?: string }).type === "entity.too.large" ? 413 : 400,
      )
      .json({ error: "输入格式或体积不受支持" });
  },
);
const port = Number(process.env.PORT || 3178);
const host = process.env.HOST || "127.0.0.1";

const profileDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../data/chrome-profile",
);

function openBrowser(url: string) {
  if (process.env.CRUSH_OPEN_BROWSER === "0") return;
  if (process.platform === "win32") {
    // Prefer Chrome when installed; fall back to the default browser.
    const chrome = [
      join(process.env["ProgramFiles"] ?? "", "Google/Chrome/Application/chrome.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    ].find((p) => p && existsSync(p));
    // --app + 独立 profile：无地址栏/标签页的独立窗口(像桌面应用),也不会混进用户日常浏览的 Chrome 窗口
    if (chrome)
      execFile(
        chrome,
        [
          `--app=${url}`,
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--window-size=1280,900",
        ],
        () => {},
      );
    else execFile("rundll32", ["url.dll,FileProtocolHandler", url], () => {});
  } else {
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
  }
}

// 把已打开的应用窗口调到前台(按页面标题开头匹配);找不到窗口时返回 false。
function focusWindow(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(New-Object -ComObject WScript.Shell).AppActivate('好感监控器')",
      ],
      (err, stdout) => resolve(!err && stdout.trim().toLowerCase() === "true"),
    );
  });
}

// 单实例：端口被占用时视为已在运行——已有活页面就把它调到前台,页面早关掉了才补开一个。
const server = app.listen(port, host, () => {
  const url = `http://127.0.0.1:${port}/`;
  openBrowser(url);
  // 托盘只在赢家(监听成功)进程里存在;失败实例走 EADDRINUSE 路径,不碰托盘
  // 桌面版(CRUSH_ELECTRON)托盘由 Electron 原生接管,不再拉 PowerShell 托盘
  if (process.env.CRUSH_PAGE_EXIT_STOP === "1" && process.env.CRUSH_ELECTRON !== "1") startTray();
  const status = publicSettings();
  console.log(`Crush API: http://${host}:${port}`);
  console.log(
    status.configured
      ? `Model: ${status.preset} · ${status.model} · Key configured (not yet verified)`
      : "请在网页中设置模型和 API Key。",
  );
  startWatch();
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  const url = `http://127.0.0.1:${port}/`;
  console.log("crush-monitor 已在运行。");
  if (process.env.CRUSH_ELECTRON === "1") {
    // 桌面壳 spawn 前已查过端口，走到这里只是毫秒级竞态：直接退，聚焦/开窗都归桌面壳管
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (process.env.CRUSH_OPEN_BROWSER !== "0")
    // ponytail: 静默启动下双击很常见;赢家(刚启动的实例)会自己开页面,
    // 败家只在"对方已运行一段时间且页面确实不在"时才补开,避免两个 Chrome 抢同一 profile、后到窗口闪没
    setTimeout(() => {
      fetch(`http://127.0.0.1:${port}/api/page`)
        .then((r) => r.json() as Promise<{ held?: boolean; uptime?: number; desktop?: boolean }>)
        .then((j) => {
          if (j.desktop) {
            // 桌面版在跑：Electron 窗口与页面标题同名,聚焦即可;绝不补开浏览器窗口
            void focusWindow();
            return true;
          }
          if (j.held) return focusWindow();
          if ((j.uptime ?? 999) < 15) return true; // 对方刚启动,页面由它来开
          return false;
        })
        .then((focused) => {
          if (!focused) openBrowser(url);
        })
        .catch(() => openBrowser(url));
    }, 2000);
  // 异步 spawn 需要时间；立即 exit 会把浏览器的启动一起杀掉
  setTimeout(() => process.exit(0), 3500);
});
