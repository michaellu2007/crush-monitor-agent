import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCandidates,
  parseJudgeScores,
  parseDraftCheck,
} from "../server/advise";

test("候选抽取：从顾问回复的「说法：」行提取，≤5 条", () => {
  const text = `判断：她现在愿意聊。

1. 说法：晚上有个市集，一起去逛？
   回应门槛：低
2. 说法：「周末去看展吗？不行也没事」
   回应门槛：中
- 说法: 你上次说的那家店我找到了
推荐候选 1。`;
  const picked = extractCandidates(text);
  assert.deepEqual(picked, [
    "晚上有个市集，一起去逛？",
    "周末去看展吗？不行也没事",
    "你上次说的那家店我找到了",
  ]);
});

test("候选抽取：模型把标签加粗成 **说法**： 也能抽出（markdown 格式加固）", () => {
  const md = `### 候选
**候选1**
- **说法**：「今晚去吃那家新开的面馆？」
- 门槛：低

**候选2**
- **说法**: 周末想去看那个市集，一起去？
推荐候选 1。`;
  assert.deepEqual(extractCandidates(md), [
    "今晚去吃那家新开的面馆？",
    "周末想去看那个市集，一起去？",
  ]);
});

test("候选抽取：没有「说法：」行时返回空（自审静默跳过）", () => {
  assert.deepEqual(extractCandidates("就一句话的普通回复。"), []);
});

test("判官评分解析：容忍 ```json 围栏与前后废话", () => {
  const raw =
    '好的，结果如下：\n```json\n{"best":2,"scores":[{"index":1,"threshold":70,"risk":40},{"index":2,"threshold":25,"risk":15,"note":"最轻"}]}\n```\n以上。';
  const parsed = parseJudgeScores(raw);
  assert.equal(parsed.best, 2);
  assert.equal(parsed.scores[1].threshold, 25);
});

test("判官评分解析：没有 JSON 时抛错（自审会静默回退）", () => {
  assert.throws(() => parseJudgeScores("我不同意这个问法。"));
});

test("体检解析：完整字段 + 围栏容忍", () => {
  const raw =
    '```json\n{"threshold":30,"warmth":"温和","risk":20,"riskNote":"对方可能在忙","comments":[{"quote":"在吗","note":"开场有压迫感"}],"rewrite":"看到你发的那家店，想起我也想去"}\n```';
  const parsed = parseDraftCheck(raw);
  assert.equal(parsed.threshold, 30);
  assert.equal(parsed.warmth, "温和");
  assert.equal(parsed.comments.length, 1);
  assert.ok(parsed.rewrite.includes("那家店"));
});

test("体检解析：超范围钳制而不是拒绝（模型无关稳健性）", () => {
  const clamped = parseDraftCheck(
    '{"threshold":200,"warmth":"温和","risk":0,"riskNote":"","comments":[],"rewrite":""}',
  );
  assert.equal(clamped.threshold, 100);
  const fuzzyWarm = parseDraftCheck(
    '{"threshold":30,"warmth":"热情奔放","risk":0,"riskNote":"","comments":[],"rewrite":""}',
  );
  assert.equal(fuzzyWarm.warmth, "热络", "warmth 模糊匹配");
  const unknownWarmth = parseDraftCheck(
    '{"threshold":30,"warmth":"平淡如水","risk":0,"riskNote":"","comments":[],"rewrite":""}',
  );
  assert.equal(unknownWarmth.warmth, "克制");
});
