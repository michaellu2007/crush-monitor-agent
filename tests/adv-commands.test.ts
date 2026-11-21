import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdvCommand, ADV_COMMAND_HELP } from "../shared/adv-commands";

test("普通文本与未知 / 开头内容都按问题处理", () => {
  assert.deepEqual(parseAdvCommand("她这是什么意思"), { type: "question", question: "她这是什么意思" });
  assert.deepEqual(parseAdvCommand("/etc/hosts 里写啥"), { type: "question", question: "/etc/hosts 里写啥" });
});

test("readall：带问题进入读取全部模式；裸 /readall 回 help", () => {
  assert.deepEqual(parseAdvCommand("/readall 她是什么意思"), { type: "readall", question: "她是什么意思" });
  assert.deepEqual(parseAdvCommand("/readall"), { type: "help" });
});

test("goal：设定/清除/查看三态", () => {
  assert.deepEqual(parseAdvCommand("/goal 本周约她出来"), { type: "goal", arg: "本周约她出来" });
  assert.deepEqual(parseAdvCommand("/goal clear"), { type: "goal", arg: "clear" });
  assert.deepEqual(parseAdvCommand("/goal"), { type: "goal", arg: "" });
});

test("compact/clear/mode/help", () => {
  assert.deepEqual(parseAdvCommand("/compact"), { type: "compact" });
  assert.deepEqual(parseAdvCommand("/clear"), { type: "clear" });
  assert.deepEqual(parseAdvCommand("/mode auto"), { type: "mode", arg: "auto" });
  assert.deepEqual(parseAdvCommand("/mode"), { type: "mode", arg: "" });
  assert.deepEqual(parseAdvCommand("/help"), { type: "help" });
  assert.ok(ADV_COMMAND_HELP.includes("/readall"));
});
