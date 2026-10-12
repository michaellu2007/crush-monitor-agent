import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { analyze, requestSchema } from "./analysis";
import { ConfigurationError } from "./provider-config";
import {
  activeConfig,
  configFingerprint,
  judgeConfig,
  publicSettings,
} from "./model-config";
import { settingsRouter } from "./settings-api";
import { advise, adviseErrorMessage } from "./advise";
import {
  initStorage,
  readConversation,
  writeConversation,
  listConversationIds,
  getLastConvId,
  setLastConvId,
} from "./conv-store";
import { listChats, getChat, refresh } from "./wechat";
import { ProviderError, providerErrorMessage } from "./provider";
const app = express();
app.disable("x-powered-by");
initStorage();
app.use("/api/conversations", express.json({ limit: "64mb" }));
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
    if (!s || s.schema !== 1) continue;
    conversations.push({
      id,
      other: s.other,
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
  writeConversation(id, req.body ?? null);
  res.json({ ok: true });
});
app.delete("/api/conversations/:id", (req, res) => {
  writeConversation(req.params.id, null);
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
let calls = 0;
let windowAt = Date.now();
let active = 0;
const budgets = new Map<string, { count: number; at: number }>();
app.get("/api/wechat/chats", (_req, res) => {
  try {
    res.json({ chats: listChats() });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message || e) });
  }
});
app.get("/api/wechat/chat", (req, res) => {
  const user = String(req.query.user ?? "");
  if (!user || user.length > 120 || user.includes("@chatroom")) {
    res.status(400).json({ error: "无效的聊天对象" });
    return;
  }
  try {
    res.json({ messages: getChat(user) });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message || e) });
  }
});
app.post("/api/wechat/refresh", async (_req, res) => {
  try {
    await refresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message || e) });
  }
});
app.post("/api/advise", async (req, res) => {
  const configuration = publicSettings();
  if (!configuration.configured) {
    res.status(503).json({ error: "请先打开模型设置，填写 API Key 并检测连接。" });
    return;
  }
  try {
    const text = await advise(req.body);
    res.json({ text });
  } catch (e) {
    const status =
      typeof (e as any)?.status === "number" ? (e as any).status : 500;
    res.status(status).json({ error: adviseErrorMessage(e) });
  }
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

function openBrowser(url: string) {
  if (process.env.CRUSH_OPEN_BROWSER === "0") return;
  if (process.platform === "win32") {
    // Prefer Chrome when installed; fall back to the default browser.
    const chrome = [
      join(process.env["ProgramFiles"] ?? "", "Google/Chrome/Application/chrome.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    ].find((p) => p && existsSync(p));
    if (chrome) execFile(chrome, [url], () => {});
    else execFile("rundll32", ["url.dll,FileProtocolHandler", url], () => {});
  } else {
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
  }
}

// 单实例：端口被占用时视为已在运行，直接打开页面后退出，不再崩出堆栈。
const server = app.listen(port, host, () => {
  const url = `http://127.0.0.1:${port}/`;
  openBrowser(url);
  const status = publicSettings();
  console.log(`Crush API: http://${host}:${port}`);
  console.log(
    status.configured
      ? `Model: ${status.preset} · ${status.model} · Key configured (not yet verified)`
      : "请在网页中设置模型和 API Key。",
  );
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  const url = `http://127.0.0.1:${port}/`;
  console.log("crush-monitor 已在运行，为你打开页面。");
  openBrowser(url);
  process.exit(0);
});
