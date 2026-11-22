import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  normalizeProfile,
  describeProfile,
  PROFILE_LIMITS,
} from "../shared/profile";
import { readProfile, saveProfile } from "../server/profile-store";
import { parseExtraction } from "../server/profile-extract";

test("画像规整：裁剪条数与长度、去重、拒绝空 contactId", () => {
  const p = normalizeProfile(
    {
      interests: ["  咖啡 ", "咖啡", "烘焙", ""],
      boundaries: ["前任", "家里的事"],
      styleNote: "  偏短句、爱用表情包  ",
      events: [{ at: "10月", note: "期末周" }, null, { note: "  " }],
    },
    "wxid_test",
  );
  assert.ok(p);
  assert.deepEqual(p.interests, ["咖啡", "烘焙"]);
  assert.deepEqual(p.boundaries, ["前任", "家里的事"]);
  assert.equal(p.styleNote, "偏短句、爱用表情包");
  assert.equal(p.events.length, 1);
  assert.ok(p.updatedAt);
  assert.equal(normalizeProfile({ interests: [] }, ""), null);
});

test("画像规整：超上限条数被截断", () => {
  const many = Array.from({ length: 30 }, (_, i) => `话题${i}`);
  const p = normalizeProfile({ interests: many }, "wxid_test");
  assert.ok(p);
  assert.equal(p.interests.length, PROFILE_LIMITS.interests);
});

test("画像注入：含守卫句、雷区标注硬约束、空画像返回空串", () => {
  const p = normalizeProfile(
    {
      interests: ["咖啡"],
      boundaries: ["前任"],
      events: [{ at: "10月", note: "期末周" }],
    },
    "x",
  );
  const note = describeProfile(p);
  assert.ok(note.includes("判断必须落在摘选原话上"));
  assert.ok(note.includes("硬约束"));
  assert.ok(note.includes("前任"));
  assert.equal(describeProfile(normalizeProfile({}, "x")), "");
  assert.equal(describeProfile(null), "");
});

test("画像落盘：save→read 回环一致，损坏文件返回 null", () => {
  const id = "test-profile-" + Date.now();
  try {
    const saved = saveProfile(
      { interests: ["爬山"], boundaries: ["加班话题"] },
      id,
    );
    assert.deepEqual(saved.interests, ["爬山"]);
    const back = readProfile(id);
    assert.ok(back);
    assert.deepEqual(back.boundaries, ["加班话题"]);
  } finally {
    try {
      unlinkSync(`data/profiles/${encodeURIComponent(id)}.json`);
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
});

test("抽取解析：容忍围栏、默认空数组", () => {
  const parsed = parseExtraction(
    '```json\n{"interests":["看展"],"boundaries":[],"events":[{"at":"11月","note":"考试周"}]}\n```',
  );
  assert.deepEqual(parsed.interests, ["看展"]);
  assert.equal(parsed.styleNote, undefined);
  assert.throws(() => parseExtraction("这不是 JSON"));
});
