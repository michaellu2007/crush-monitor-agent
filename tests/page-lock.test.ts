import { test } from "node:test";
import assert from "node:assert/strict";
import { claim, held, release } from "../server/page-lock";

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
