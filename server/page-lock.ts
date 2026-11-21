// 单页面锁：同一时间只允许一个页面持有,心跳续约,超时自动释放(页面崩溃/断网的兜底)。
const HELD_MS = 30_000; // ponytail: Chrome 会把后台窗口的定时器节流到 1 次/分钟,阈值太短会把挂后台的页面误判为已关闭(连带触发服务自退);30s 覆盖节流,代价是页面真关后接管最长等 30s
let holder = { token: "", at: 0, desktop: false };

export function claim(token: string, now = Date.now(), desktop = false): boolean {
  const alive = holder.token && holder.token !== token && now - holder.at < HELD_MS;
  // 桌面窗口(Electron)是唯一主界面:浏览器标签哪怕先抢到锁也直接接管,
  // 否则桌面版启动会输给残留 Chrome 标签的 3s 重试,把"多开提示"渲染进 exe 窗口(2026-10-25 事故)
  if (alive && !(desktop && !holder.desktop)) return false;
  holder = { token, at: now, desktop };
  return true;
}
export function release(token: string, now = Date.now()): void {
  if (holder.token === token) holder = { token: "", at: 0, desktop: false };
}
export function held(now = Date.now()): boolean {
  return holder.token !== "" && now - holder.at < HELD_MS;
}
export function holderIsDesktop(now = Date.now()): boolean {
  return held(now) && holder.desktop;
}
