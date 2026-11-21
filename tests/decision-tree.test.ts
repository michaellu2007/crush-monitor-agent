import { test } from "node:test";
import assert from "node:assert/strict";
import { collectBoundaryReasons } from "../server/decision-tree";

test("边界判定：judge 信号触发", () => {
  const reasons = collectBoundaryReasons(true, ["哈哈哈"], []);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /边界\/婉拒/);
});

test("边界判定：明确拒绝话术触发（词面兜底）", () => {
  assert.ok(collectBoundaryReasons(false, ["你别再联系我了"], []).length);
  assert.ok(collectBoundaryReasons(false, ["请你自重"], []).length);
  assert.ok(collectBoundaryReasons(false, ["离我远点"], []).length);
});

test("边界判定：普通消息不误触发（宁漏勿错）", () => {
  assert.deepEqual(collectBoundaryReasons(false, ["不想去那个地方，太远了", "别管我笑死"], []), []);
});

test("边界判定：画像雷区触发并带上内容", () => {
  const reasons = collectBoundaryReasons(false, [], ["前任", "工资"]);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /前任/);
});

test("边界判定：三路并集去重字段、全空返回空数组", () => {
  assert.deepEqual(collectBoundaryReasons(undefined, [], []), []);
  const all = collectBoundaryReasons(true, ["不想理你"], ["前任"]);
  assert.equal(all.length, 3);
});
