import { test } from "node:test";
import assert from "node:assert/strict";

// 头像端点核心门禁：wxid 必须在联系人表内才可能出图。
// 无解密库/非联系人一律 null，绝不抓取——保证测试可移植且无网络副作用。
test("wechat avatar: 空值/路径穿越/未知 wxid 一律拒绝", async () => {
  const { avatarFileFor } = await import("../server/wechat.ts");
  assert.equal(await avatarFileFor(""), null);
  assert.equal(await avatarFileFor("../etc/passwd"), null);
  assert.equal(await avatarFileFor("definitely_not_a_contact_xyz"), null);
});
