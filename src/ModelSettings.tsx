import {
  preferredModel,
  modelLabel,
  isTextAnalysisModel,
} from "../shared/model-selection";
import { useState, useRef, useEffect } from "react";
import {
  MODEL_PRESETS,
  type ModelSettings as Settings,
  type PublicSettings,
} from "../shared/model-presets";
export function ModelSettings({
  initial,
  saved,
  judgeHint,
}: {
  initial: PublicSettings;
  saved: (s: PublicSettings) => void;
  judgeHint?: { baseUrl: string; model: string };
}) {
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const discoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const modelInput = useRef<HTMLInputElement>(null);
  const [modelError, setModelError] = useState("");
  const [filter, setFilter] = useState("");
  // 每个供应商的未保存草稿(弹窗内有效):来回切换不丢已填的 Key/模型
  const [drafts, setDrafts] = useState<Record<string, Settings>>({});
  // 指示灯红灯:本弹窗会话内该供应商检测保存失败( shortcut: 不跨弹窗/刷新记忆,升级路径=服务端存 lastCheck 结果 )
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  useEffect(() => () => request.current?.abort(), []);
  const [form, setForm] = useState<Settings>({
    preset: initial.preset,
    protocol: initial.protocol,
    baseUrl: initial.baseUrl,
    model: initial.model,
    jsonMode: initial.jsonMode,
    contextTokens: initial.contextTokens,
    apiKey: "",
    judge: judgeHint
      ? { enabled: true, baseUrl: judgeHint.baseUrl, model: judgeHint.model, apiKey: "" }
      : initial.judge
        ? { ...initial.judge, apiKey: "" }
        : { enabled: false, baseUrl: "", model: "", apiKey: "" },
  });
  const [models, setModels] = useState<string[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [judgeStatus, setJudgeStatus] = useState<{
    enabled: boolean;
    reachable?: boolean;
    models?: { name: string; vramMB: number; expiresAt: string | null }[];
  } | null>(null);
  const [warming, setWarming] = useState(false);
  const [warmMsg, setWarmMsg] = useState("");
  const refreshJudgeStatus = useRef(() => {});
  refreshJudgeStatus.current = () => {
    fetch("/api/judge/status")
      .then((r) => r.json())
      .then(setJudgeStatus)
      .catch(() => {});
  };
  useEffect(() => {
    refreshJudgeStatus.current();
  }, []);
  async function warmup() {
    setWarming(true);
    setWarmMsg("");
    try {
      const r = await fetch("/api/judge/warmup", { method: "POST" });
      const d = (await r.json()) as {
        ok: boolean;
        loadMs?: number;
        totalMs?: number;
        error?: string;
      };
      setWarmMsg(
        d.ok
          ? `已预热：模型加载 ${d.loadMs}ms，总耗时 ${d.totalMs}ms`
          : d.error || "预热失败",
      );
    } catch {
      setWarmMsg("预热失败：无法连接本机服务");
    } finally {
      setWarming(false);
      refreshJudgeStatus.current();
    }
  }
  const preset = MODEL_PRESETS.find((p) => p.id === form.preset)!;
  const sameKey =
    initial.hasKey &&
    form.preset === initial.preset &&
    form.baseUrl === initial.baseUrl &&
    form.protocol === initial.protocol;
  const sameJudgeKey =
    !!initial.judge?.baseUrl && form.judge?.baseUrl === initial.judge.baseUrl;
  const localJudge = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(
    form.judge?.baseUrl ?? "",
  );
  // 当前供应商的模型列表(登记簿草稿):顾问/评估下拉的选项来源
  const models0 = initial.providers?.find((p) => p.baseUrl === form.baseUrl)
    ?.models;
  const [providerModels, setProviderModels] = useState<
    Record<string, string[]>
  >(
    initial.providers
      ? Object.fromEntries(initial.providers.map((p) => [p.baseUrl, p.models]))
      : {},
  );
  const [addingModel, setAddingModel] = useState("");
  // 通道开关（2026-11-20）：供应商整体停用 + 按模型停用——配置保留，只是从下拉隐藏
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(
      (initial.providers ?? []).map((p) => [p.baseUrl, p.enabled ?? true]),
    ),
  );
  const [providerOffModels, setProviderOffModels] = useState<Record<string, string[]>>(
    Object.fromEntries(
      (initial.providers ?? []).map((p) => [p.baseUrl, p.disabledModels ?? []]),
    ),
  );
  const currentModels = providerModels[form.baseUrl] ?? models0 ?? [];
  function addModel(id: string) {
    const m = id.trim();
    if (!m) return;
    setProviderModels((d) => ({
      ...d,
      [form.baseUrl]: [...new Set([...(d[form.baseUrl] ?? models0 ?? []), m])],
    }));
    setAddingModel("");
  }
  function removeModel(m: string) {
    setProviderModels((d) => ({
      ...d,
      [form.baseUrl]: (d[form.baseUrl] ?? models0 ?? []).filter((x) => x !== m),
    }));
  }
  function buildProviders() {
    const reg: Record<
      string,
      {
        preset: string;
        protocol: Settings["protocol"];
        models: string[];
        enabled?: boolean;
        disabledModels?: string[];
      }
    > = {};
    for (const p of initial.providers ?? [])
      reg[p.baseUrl] = {
        preset: p.preset,
        protocol: p.protocol,
        models: p.models,
        // 其他供应商的开关状态原样保留（本弹窗一次只编辑一个供应商）
        ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
        ...(p.disabledModels ? { disabledModels: p.disabledModels } : {}),
      };
    reg[form.baseUrl] = {
      preset: form.preset,
      protocol: form.protocol,
      models: [...new Set([...(providerModels[form.baseUrl] ?? models0 ?? []), form.model])],
      enabled: providerEnabled[form.baseUrl] ?? true,
      disabledModels: providerOffModels[form.baseUrl] ?? [],
    };
    return reg;
  }
  function select(id: string) {
    if (id === form.preset) return;
    // 各供应商的草稿在本次弹窗内互不覆盖:切走时存档,切回时恢复
    setDrafts((d) => ({ ...d, [form.preset]: form }));
    const draft = drafts[id];
    if (draft) {
      setForm(draft);
      return;
    }
    const p = MODEL_PRESETS.find((p) => p.id === id)!;
    setForm({
      preset: id,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      model: p.model,
      jsonMode: true,
      apiKey: "",
      // 评估判官与上下文预算是全局设置，不随顾问供应商预设切换重置——
      // 丢了的话保存后判官静默失效（2026-11-19 bug 审查 P1）
      contextTokens: form.contextTokens,
      judge: form.judge,
    });
    request.current?.abort();
    sequence.current++;
    setBusy("");
    setModels([]);
    setModelError("");
    setFilter("");
    setPickerOpen(false);
    setError("");
  }
  async function submit(action: "save" | "models") {
    if (discoveryTimer.current) clearTimeout(discoveryTimer.current);
    discoveryTimer.current = null;
    request.current?.abort();
    const ticket = ++sequence.current;
    setBusy(action);
    if (action === "models") setModelError("");
    else setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const res = await fetch("/api/settings/" + action, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-config-token": initial.token,
        },
        body: JSON.stringify({ ...form, providers: buildProviders() }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(action === "save" ? 45000 : 18000),
        ]),
      });
      const data = await res.json();
      if (ticket !== sequence.current) return;
      if (!res.ok) throw new Error(data.error || "连接失败，请重试。");
      if (action === "save") {
        setForm((f) => ({ ...f, apiKey: "" }));
        setFailed((f) => ({ ...f, [form.preset]: false }));
        saved(data);
      } else {
        const ids: string[] = [...new Set<string>(data.models)].filter(
          isTextAnalysisModel,
        );
        setModels(ids);
        setFilter("");
        setPickerOpen(!!ids.length);
        if (ids.length)
          setForm((f) => ({
            ...f,
            model: preferredModel(ids, f.model, f.preset),
          }));
        else setModelError("平台未提供模型列表，可以手动填写模型 ID。");
      }
    } catch (e) {
      if (!controller.signal.aborted && ticket === sequence.current) {
        if (action === "models") {
          setModelError("读取模型失败：" + (e as Error).message);
          setPickerOpen(false);
        } else {
          setFailed((f) => ({ ...f, [form.preset]: true }));
          setError(
            (e as Error).name === "TimeoutError"
              ? "检测超过 45 秒，请换一个快速文本型号或稍后重试。"
              : (e as Error).message,
          );
        }
      }
    } finally {
      if (ticket === sequence.current) setBusy("");
    }
  }
  useEffect(() => {
    setBusy("");
    setModels([]);
    setModelError("");
    setError("");
    setFilter("");
    if (
      form.protocol === "jev" ||
      (!form.apiKey.trim() && !sameKey) ||
      !form.baseUrl
    )
      return;
    discoveryTimer.current = setTimeout(() => void submit("models"), 600);
    return () => {
      if (discoveryTimer.current) clearTimeout(discoveryTimer.current);
      request.current?.abort();
      sequence.current++;
    };
  }, [form.preset, form.apiKey, form.baseUrl, form.protocol]);
  useEffect(() => {
    if (busy !== "save") return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  function chooseModel(model: string) {
    setForm((f) => ({ ...f, model }));
    setPickerOpen(false);
    setFilter("");
    setError("");
    modelInput.current?.focus();
  }
  const visibleModels = models.filter((m) =>
    m.toLowerCase().includes(filter.toLowerCase()),
  );
  // 指示灯数据源:绿=登记簿存过 Key;当前供应商看顶层 hasKey(环境变量 Key 时登记簿为空)
  const keyOk = (id: string) =>
    (id === initial.preset && initial.hasKey) ||
    !!(initial.providers ?? []).some((p) => p.preset === id && p.hasKey);
  return (
    <form
      className="model-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void submit("save");
      }}
    >
      <p className="model-intro">
        管理顾问与评估的模型供应商。左侧指示灯：绿=已配置，红=最近一次检测保存失败，灰=未配置；没配
        Key 的供应商不会出现在消息框的下拉里。
      </p>
      <div className="ms-layout">
        <aside className="ms-side" aria-label="模型供应商">
          {MODEL_PRESETS.map((p) => {
            const bad = !!failed[p.id];
            const ok = !bad && keyOk(p.id);
            const state = bad ? "bad" : ok ? "ok" : "none";
            const status = bad
              ? "配置失败"
              : !ok
                ? "未配置"
                : initial.configured && initial.preset === p.id
                  ? "使用中"
                  : "已配置";
            return (
              <button
                type="button"
                key={p.id}
                className={"ms-provider" + (form.preset === p.id ? " active" : "")}
                onClick={() => select(p.id)}
              >
                {p.name}
                <span className={"ms-status " + state}>
                  <span className="ms-dot" aria-hidden="true" />
                  {status}
                </span>
              </button>
            );
          })}
        </aside>
        <div className="ms-main">
          {/* 通道开关挪到顶部（2026-11-20）：放在模型列表中间不好找 */}
          <div className="ms-head">
            <h3 className="ms-name">{preset.name} · 顾问</h3>
            <label
              className={"ms-chan" + ((providerEnabled[form.baseUrl] ?? true) ? " on" : "")}
              title="暂时关闭该供应商通道：配置与 Key 保留，模型从下拉隐藏，当前正在用的不受影响"
            >
              <input
                type="checkbox"
                checked={providerEnabled[form.baseUrl] ?? true}
                onChange={(e) =>
                  setProviderEnabled((d) => ({ ...d, [form.baseUrl]: e.target.checked }))
                }
              />
              <span className="ms-switch" aria-hidden="true" />
              通道启用
            </label>
          </div>
      <fieldset disabled={busy === "save"}>
        <div className="field">
          <span className="field-heading">
            <label htmlFor="model-api-key">API Key</label>{" "}
            {preset.keyUrl && (
              <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                去获取 ↗
              </a>
            )}
          </span>
          <input
            id="model-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder={
              sameKey ? "已保存；留空继续使用" : "粘贴这个平台的 API Key"
            }
            required={!sameKey}
          />
        </div>
        {form.preset === "custom" && (
          <>
            <label className="field">
              接口类型
              <select
                value={form.protocol}
                onChange={(e) =>
                  setForm({
                    ...form,
                    protocol: e.target.value as Settings["protocol"],
                    apiKey: "",
                  })
                }
              >
                <option value="openai">OpenAI Chat Completions</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </label>
            <label className="field">
              Base URL
              <input
                value={form.baseUrl}
                onChange={(e) =>
                  setForm({ ...form, baseUrl: e.target.value, apiKey: "" })
                }
                placeholder="https://your-provider.com/v1"
                required
              />
            </label>
          </>
        )}
        {form.protocol !== "jev" && (
          <>
            <div className="field">
              <span className="field-heading">
                <label htmlFor="model-id">选择模型</label>
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    busy === "models" ||
                    (!form.apiKey && !sameKey) ||
                    !form.baseUrl
                  }
                  onClick={() => void submit("models")}
                >
                  {busy === "models" ? "读取中…" : "刷新模型列表"}
                </button>
              </span>
              {busy === "models" && (
                <span className="model-list-status" role="status">
                  正在读取平台的文本模型…
                </span>
              )}
              <div
                className="model-picker"
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    setPickerOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setPickerOpen(false);
                    modelInput.current?.focus();
                  }
                  if (e.key === "ArrowDown" && !pickerOpen && models.length) {
                    e.preventDefault();
                    setFilter("");
                    setPickerOpen(true);
                  }
                }}
              >
                <div className="model-value">
                  <input
                    ref={modelInput}
                    id="model-id"
                    aria-label="模型 ID"
                    value={form.model}
                    onChange={(e) => {
                      setForm({ ...form, model: e.target.value });
                      setPickerOpen(false);
                      setError("");
                    }}
                    onClick={() => {
                      if (models.length) {
                        setFilter("");
                        setPickerOpen(true);
                      }
                    }}
                    placeholder="选择型号，也可以直接输入模型 ID"
                    required
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="model-picker-toggle"
                    aria-label="展开模型列表"
                    aria-expanded={pickerOpen}
                    disabled={!models.length}
                    onClick={() => {
                      setFilter("");
                      setPickerOpen(!pickerOpen);
                    }}
                  >
                    ⌄
                  </button>
                </div>
                {pickerOpen && models.length > 0 && (
                  <div className="model-picker-panel">
                    <input
                      aria-label="搜索模型"
                      placeholder="搜索型号，例如 qwen、deepseek、kimi"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                    <div
                      className="model-options"
                      role="listbox"
                      aria-label="平台模型"
                    >
                      {visibleModels.map((m) => (
                        <button
                          key={m}
                          type="button"
                          role="option"
                          aria-selected={m === form.model}
                          onClick={() => chooseModel(m)}
                        >
                          {modelLabel(m, form.preset)}
                          {m === form.model && (
                            <span aria-hidden="true">✓</span>
                          )}
                        </button>
                      ))}
                      {!visibleModels.length && (
                        <p className="model-list-status">
                          没有匹配的型号，可在上方直接填写 ID。
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {modelError && (
                <span className="model-list-status" role="status">
                  {modelError}
                </span>
              )}
              <div className="field">
                <div className="ms-list-head">
                  <span className="field-heading">模型列表（顾问/评估下拉的候选）</span>
                </div>
                {(providerModels[form.baseUrl] ?? models0 ?? []).map((m) => {
                  const off = (providerOffModels[form.baseUrl] ?? []).includes(m);
                  return (
                    <div className={"ms-model-row" + (off ? " off" : "")} key={m}>
                      <span className="ms-model-name">{m}</span>
                      {m === form.model ? (
                        <span className="ms-model-tag">使用中</span>
                      ) : (
                        <>
                          {off && <span className="ms-model-tag">已停用</span>}
                          <button
                            type="button"
                            className={"ms-switch-btn" + (off ? "" : " on")}
                            role="switch"
                            aria-checked={!off}
                            aria-label={off ? `启用 ${m}` : `停用 ${m}`}
                            title={off ? "开启：重新加入下拉候选" : "关闭：从下拉隐藏（保留在列表，随时可开）"}
                            onClick={() =>
                              setProviderOffModels((d) => {
                                const cur = d[form.baseUrl] ?? [];
                                return {
                                  ...d,
                                  [form.baseUrl]: off
                                    ? cur.filter((x) => x !== m)
                                    : [...new Set([...cur, m])],
                                };
                              })
                            }
                          >
                            <span className="ms-switch" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon"
                            aria-label={`删除 ${m}`}
                            onClick={() => removeModel(m)}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
                <div className="ms-add-row">
                  <input
                    value={addingModel}
                    placeholder="输入模型 ID 添加到列表"
                    spellCheck={false}
                    onChange={(e) => setAddingModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addModel(addingModel);
                      }
                    }}
                  />
                  <button type="button" onClick={() => addModel(addingModel)}>
                    添加
                  </button>
                </div>
                <small className="model-list-status">
                  在「选择模型」里选定当前使用的模型；上方列表是供下拉切换的候选。
                </small>
              </div>
            </div>
            <details className="model-advanced">
              <summary>连接选项</summary>
              <p>{form.baseUrl}</p>
              {form.protocol === "openai" && (
                <label>
                  <input
                    type="checkbox"
                    checked={form.jsonMode}
                    onChange={(e) =>
                      setForm({ ...form, jsonMode: e.target.checked })
                    }
                  />{" "}
                  使用 JSON 模式（接口不支持时可关闭）
                </label>
              )}
              <label className="field">
                上下文窗口 tokens（自适应上下文：喂给顾问的聊天转写按它换算；留空=按模型名自动推断。接入点窗口与官方不同就填它，如 1000000）
                <input
                  type="number"
                  min={4096}
                  step={1024}
                  value={form.contextTokens ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      contextTokens: e.target.value
                        ? Math.max(4096, Number(e.target.value))
                        : undefined,
                    })
                  }
                  placeholder="留空自动（如 deepseek-chat=128k）"
                />
              </label>
            </details>
          </>
        )}
      </fieldset>
      <fieldset disabled={busy === "save"}>
        <label className="field">
          <label>
            <input
              type="checkbox"
              checked={!!form.judge?.enabled}
              onChange={(e) =>
                setForm({
                  ...form,
                  judge: {
                    enabled: e.target.checked,
                    baseUrl:
                      form.judge?.baseUrl || "http://127.0.0.1:11434/v1",
                    model: form.judge?.model || "mimo-v2.6:9b",
                    apiKey: form.judge?.apiKey || "",
                    protocol: form.judge?.protocol || "openai",
                  },
                })
              }
            />{" "}
            评估用独立模型（逐条情绪/意图/评分走它，与上面的顾问互相独立：顾问 GLM + 评估 Qwen 完全可以）
          </label>
        </label>
        {form.judge?.enabled && (
          <>
            <label className="field">
              评估接口地址（OpenAI 兼容。填服务根地址即可，应用自动补
              /chat/completions；粘完整地址也会自动归一）
              <input
                value={form.judge.baseUrl}
                onChange={(e) =>
                  setForm({
                    ...form,
                    judge: {
                      enabled: true,
                      model: form.judge?.model || "mimo-v2.6:9b",
                      apiKey: form.judge?.apiKey || "",
                      baseUrl: e.target.value,
                      protocol: form.judge?.protocol || "openai",
                    },
                  })
                }
                placeholder="http://127.0.0.1:11434/v1"
                spellCheck={false}
              />
            </label>
            <label className="field">
              判官协议
              <select
                value={form.judge.protocol || "openai"}
                onChange={(e) =>
                  setForm({
                    ...form,
                    judge: {
                      ...(form.judge ?? {
                        enabled: true,
                        baseUrl: "",
                        model: "",
                        apiKey: "",
                      }),
                      protocol: e.target.value as "openai" | "jev",
                    },
                  })
                }
              >
                <option value="openai">
                  OpenAI 兼容 chat（本地生成式判官，支持草稿体检/自审）
                </option>
                <option value="jev">
                  Jev 原生 systemone（StartLux 等概率读出服务，亚秒级；不支持草稿体检）
                </option>
              </select>
            </label>
            <label className="field">
              评估模型 ID
              <input
                value={form.judge.model}
                onChange={(e) =>
                  setForm({
                    ...form,
                    judge: {
                      enabled: true,
                      baseUrl:
                        form.judge?.baseUrl || "http://127.0.0.1:11434/v1",
                      apiKey: form.judge?.apiKey || "",
                      model: e.target.value,
                      protocol: form.judge?.protocol || "openai",
                    },
                  })
                }
                placeholder="mimo-v2.6:9b（ollama）或 Qwen/Qwen2.5-7B-Instruct"
                spellCheck={false}
              />
            </label>
            {form.judge.protocol !== "jev" && (
              <label className="field">
                判官上下文窗口 tokens（留空=按模型名推断并按 16k 封顶；判官窗口大于 16k 才需要填）
                <input
                  type="number"
                  min={4096}
                  step={1024}
                  value={form.judge?.contextTokens ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      judge: {
                        ...(form.judge ?? {
                          enabled: true,
                          baseUrl: "",
                          model: "",
                          apiKey: "",
                        }),
                        contextTokens: e.target.value
                          ? Math.max(4096, Number(e.target.value))
                          : undefined,
                      },
                    })
                  }
                  placeholder="留空自动（本地 16k 判官不用填）"
                />
              </label>
            )}
            {!localJudge && (
              <label className="field">
                评估模型 API Key（云端评估必填，留空继续用已保存的 Key）
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.judge.apiKey}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      judge: {
                        enabled: true,
                        baseUrl:
                          form.judge?.baseUrl || "http://127.0.0.1:11434/v1",
                        model: form.judge?.model || "",
                        apiKey: e.target.value,
                        protocol: form.judge?.protocol || "openai",
                      },
                    })
                  }
                  placeholder={
                    sameJudgeKey ? "已保存；留空继续使用" : "粘贴该服务的 API Key"
                  }
                />
              </label>
            )}
            {localJudge && (
              <>
            <div className="judge-status">
              <button
                type="button"
                className="secondary"
                disabled={warming}
                onClick={warmup}
              >
                {warming ? "预热中…" : "预热模型（提前加载进显存）"}
              </button>
              {warmMsg && <small>{warmMsg}</small>}
            </div>
            {judgeStatus && (
              <small className="judge-model-state">
                {judgeStatus.enabled
                  ? judgeStatus.reachable
                    ? (() => {
                        const m = judgeStatus.models?.find((x) =>
                          x.name.startsWith(form.judge?.model || "\u0000"),
                        );
                        return m
                          ? `当前状态：${m.name} 已驻留显存 ${m.vramMB}MB${
                              m.expiresAt
                                ? `，空闲后 ${new Date(
                                    m.expiresAt,
                                  ).toLocaleTimeString("zh-CN", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })} 起可能卸载`
                                : ""
                            }`
                          : "当前状态：模型未加载（首次分析或点上方预热后会自动加载）";
                      })()
                    : "当前状态：无法连接本地 Ollama 接口"
                  : "当前状态：评估未启用"}
              </small>
            )}
              </>
            )}
            {!localJudge && (
              <small className="judge-model-state">
                云端评估：连接与额度以保存后的实际分析为准；本地 Ollama 不受影响。
              </small>
            )}
          </>
        )}
      </fieldset>
      {error && (
        <p className="model-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy === "save"} type="submit">
        {busy === "save" ? `正在检测连接 · ${elapsed} 秒` : "检测连接并保存"}
      </button>
      {busy === "save" && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            request.current?.abort();
            sequence.current++;
            setBusy("");
            setError("检测已取消，可选择其他型号重试。");
          }}
        >
          取消检测
        </button>
      )}
      <p className="model-footnote">
        Key
        只保存在本机服务，不存进浏览器。检测会使用少量额度；聊天仅在分析时发给所选平台。
      </p>
        </div>
      </div>
    </form>
  );
}
