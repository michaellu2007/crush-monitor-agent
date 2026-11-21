import { test } from "node:test";
import assert from "node:assert/strict";
import { claim, held, holderIsDesktop, release } from "../server/page-lock";

test("单页面锁：双页面互斥,释放或超时后可认领", () => {
  assert.equal(claim("a", 1000), true); // 第一页面认领成功
  assert.equal(claim("b", 2000), false); // 第二页面被拒
  assert.equal(claim("a", 3000), true); // 持有者心跳续约
  assert.equal(claim("b", 4000), false);
  release("b", 4000); // 非持有者释放无效
  assert.equal(claim("b", 4000), false);
  release("a", 4000); // 持有者关闭页面后立即可认领
  assert.equal(claim("b", 4000), true);
  assert.equal(held(5000), true);
  assert.equal(claim("c", 999999), true); // 长时间无心跳,锁过期,他人可认领
});

test("桌面窗口优先：浏览器标签先持锁,Electron 认领直接接管", () => {
  const t = 2_000_000; // 模块级 holder 跨测试残留,时间轴取在上一测试(999999)之后
  assert.equal(claim("web", t + 1000), true); // 残留 Chrome 标签先抢到
  assert.equal(holderIsDesktop(t + 1000), false);
  assert.equal(claim("app", t + 2000, true), true); // 桌面窗口接管,不再吃 409
  assert.equal(holderIsDesktop(t + 2000), true);
  assert.equal(claim("web", t + 3000), false); // 旧标签心跳被拒,只能停留在提示页
  assert.equal(claim("app", t + 3000, true), true); // 桌面窗口心跳正常
  assert.equal(claim("app2", t + 4000, true), false); // 第二个"桌面"不越权(单实例下不该出现)
  release("app", t + 4000);
  assert.equal(claim("web", t + 4000), true); // 桌面退出后浏览器可正常接管
  assert.equal(holderIsDesktop(t + 4000), false);
});
