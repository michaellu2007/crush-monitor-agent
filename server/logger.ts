// 运行日志环形缓冲：拦截 console 输出（仍照常打印到控制台），供 /api/logs 导出排障。
// ponytail: 只收服务端 console 流，2000 条环形覆盖；判官思维链（含聊天原文）不进这里
// ——隐私优先，需要时用开发者模式的 judge-thoughts.log 单独拿。
const RING_MAX = 2000;
const ring: string[] = [];
let installed = false;

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function push(level: string, args: unknown[]): void {
  const line =
    `[${stamp()}] [${level}] ` +
    args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a) ?? String(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/** 拦截 console 四个级别进环形缓冲；幂等，重复调用无副作用。 */
export function installLogRing(): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level.toUpperCase(), args);
      orig(...args);
    };
  }
}

/** 导出纯文本（时间戳 + 级别 + 内容），空缓冲给占位说明。 */
export function getLogText(): string {
  return ring.length ? ring.join("\n") : "(空——服务启动后尚无日志输出)";
}
