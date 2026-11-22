import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TACTICS,
  TACTIC_GUARD,
  classifyQuestion,
  selectTactics,
  buildTacticsNote,
} from "../shared/tactics";

test("策略库完整性：12 条、每条有判据化注入句、守卫句非空", () => {
  assert.equal(TACTICS.length, 12);
  for (const t of TACTICS) {
    assert.ok(t.id.startsWith("T-"), t.id);
    assert.ok(t.title.length > 2, t.title);
    assert.ok(t.categories.length >= 1, t.id);
    assert.ok(t.injection.length > 20, `${t.id} 注入句过短`);
    assert.ok(!/待验证|TODO/.test(t.injection), `${t.id} 注入句含占位`);
  }
  assert.ok(TACTIC_GUARD.includes("边界规则"));
});

test("类别路由：邀约/修复/解读/推进/接球问题各自命中", () => {
  assert.ok(classifyQuestion("周末怎么约她出来？").includes("邀约"));
  assert.ok(classifyQuestion("我昨天说错话了怎么修复").includes("修复"));
  assert.ok(classifyQuestion("她突然变冷淡是什么意思").includes("解读护栏"));
  assert.ok(classifyQuestion("下一步怎么推进话题").includes("推进"));
  assert.ok(classifyQuestion("她发了个表情包我怎么回").includes("接球"));
});

test("类别路由：无关问题回落默认（接球+推进）", () => {
  assert.deepEqual(classifyQuestion("你好"), ["接球", "推进"]);
});

test("类别路由：一词多类命中（邀约+修复同问）", () => {
  const cats = classifyQuestion("上次约她被拒绝了怎么道歉修好");
  assert.ok(cats.includes("邀约"));
  assert.ok(cats.includes("修复"));
});

test("选取：limit 生效且去重（T-012 跨类别不重复）", () => {
  const picked = selectTactics("怎么回她的话并且推进话题", 3);
  assert.equal(picked.length, 3);
  const ids = picked.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("选取：邀约问题选中邀约条目（T-008 在前两类之内）", () => {
  const picked = selectTactics("怎么约出来吃饭", 4);
  assert.ok(picked.some((t) => t.id === "T-008"));
});

test("注入块：含守卫句、含条目标题、以换行分隔可拼进 system", () => {
  const note = buildTacticsNote("怎么回她的消息", 3);
  assert.ok(note.includes(TACTIC_GUARD));
  assert.ok(/【.+】/.test(note));
  assert.ok(note.includes("\n- "));
});
