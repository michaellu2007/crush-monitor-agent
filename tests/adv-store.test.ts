// 顾问会话归档存储（2026-11-18）：current 保存/恢复 + 归档 cap10 + 清理。
// 落盘目录切到 os 临时目录（setAdvDirForTests）：单测绝不读写生产 data/adv——
// 旧版直接写 cwd/data/adv，测试进程中途挂掉会把测试文件留在真实数据目录里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveCurrent,
  getAdvDir,
  loadAdv,
  renameArchived,
  saveCurrent,
  setAdvDirForTests,
} from "../server/adv-store";

const CONV = "unit-adv-test";
const TEST_DIR = mkdtempSync(join(tmpdir(), "crush-adv-test-"));
setAdvDirForTests(TEST_DIR);
const FILE = () => join(getAdvDir(), encodeURIComponent(CONV) + ".json");
const session = (n: number) => ({
  log: [
    { role: "user" as const, content: `第${n}轮问题` },
    { role: "assistant" as const, content: `第${n}轮回答` },
  ],
  summary: null,
  at: 1700000000000 + n,
});

test("current 保存→读取往返；损坏 id 返回空", () => {
  saveCurrent(CONV, session(1));
  const d = loadAdv(CONV);
  assert.equal(d.current?.log[0].content, "第1轮问题");
  assert.equal(d.archived.length, 0);
  assert.deepEqual(loadAdv(""), { current: null, archived: [] });
  saveCurrent(CONV, null);
  assert.equal(loadAdv(CONV).current, null);
});

test("归档：current 压入 archived 并置空；cap10 挤掉最旧", () => {
  for (let i = 1; i <= 12; i++) archiveCurrent(CONV, session(i));
  const d = loadAdv(CONV);
  assert.equal(d.current, null, "归档后 current 清空");
  assert.equal(d.archived.length, 10, "归档 cap 10");
  assert.equal(d.archived[0].log[0].content, "第12轮问题", "最新在前");
  assert.equal(d.archived[9].log[0].content, "第3轮问题", "最旧（第1-2轮）被挤掉");
  assert.ok(d.archived[0].endedAt, "带归档时间");
});

test("创建档案命名：title 保留；无 title 回退首问前 40 字", () => {
  if (existsSync(FILE())) rmSync(FILE());
  archiveCurrent(CONV, {
    title: "  周末邀约推演  ",
    log: [{ role: "user" as const, content: "x" }],
    summary: null,
    at: 1,
  });
  archiveCurrent(CONV, {
    log: [{ role: "user" as const, content: "长".repeat(80) }],
    summary: null,
    at: 2,
  });
  const d = loadAdv(CONV);
  assert.equal(d.archived[0].title, "长".repeat(40), "archived[0]=最新归档：无命名回退首问 40 字");
  assert.equal(d.archived[1].title, "周末邀约推演", "archived[1]=较早归档：用户命名保留并去空格");
});

test("重命名归档：改 title、越界返回 false、空名保留原值", () => {
  if (existsSync(FILE())) rmSync(FILE());
  archiveCurrent(CONV, {
    title: "原名",
    log: [{ role: "user" as const, content: "x" }],
    summary: null,
    at: 1,
  });
  assert.equal(renameArchived(CONV, 0, "  新名字  "), true);
  assert.equal(loadAdv(CONV).archived[0].title, "新名字");
  assert.equal(renameArchived(CONV, 5, "越界"), false);
  assert.equal(renameArchived(CONV, 0, ""), true);
  assert.equal(loadAdv(CONV).archived[0].title, "新名字", "空名保留原值");
});

test("空会话归档：只清 current 不产条目", () => {
  if (existsSync(FILE())) rmSync(FILE()); // 自清前置：不依赖上个用例的残留
  saveCurrent(CONV, session(1)); // 自给自足：先有 current
  const n = archiveCurrent(CONV, { log: [], summary: null, at: 1 });
  assert.equal(loadAdv(CONV).current, null, "归档后 current 清空");
  assert.equal(n, 0, "空会话不产归档条目");
});

test("隔离与清理：落盘目录指向临时目录，测完删除不残留", () => {
  assert.equal(getAdvDir(), TEST_DIR, "落盘目录已切到临时目录（不碰生产 data/adv）");
  if (existsSync(FILE())) rmSync(FILE());
  rmSync(TEST_DIR, { recursive: true, force: true });
  assert.equal(existsSync(TEST_DIR), false, "临时目录已删除");
});
