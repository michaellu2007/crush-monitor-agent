// 单页面锁：同一时间只允许一个页面持有,心跳续约,超时自动释放(页面崩溃/断网的兜底)。
const HELD_MS = 8000; // ponytail: 心跳 2.5s;后台标签页被浏览器深度节流超过 8s 会丢锁,重开即恢复,数据不会丢
let holder = { token: "", at: 0 };

export function claim(token: string, now = Date.now()): boolean {
  if (holder.token && holder.token !== token && now - holder.at < HELD_MS)
    return false;
  holder = { token, at: now };
  return true;
}
export function release(token: string, now = Date.now()): void {
  if (holder.token === token) holder = { token: "", at: 0 };
}
export function held(now = Date.now()): boolean {
  return holder.token !== "" && now - holder.at < HELD_MS;
}
