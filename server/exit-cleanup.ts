// 开源版不含本地退出收尾实现（随本地全量版分发，服务端退出时无需额外清扫）。
export function killAndExit(_trayProc: { kill(): void } | null): void {}
