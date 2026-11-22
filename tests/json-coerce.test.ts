import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripThink,
  extractBalancedObject,
  coerceString,
  coerceStringArray,
  coerceNumber,
  coerceProbability,
  coerceEventArray,
} from "../server/json-coerce";
import { parseExtraction } from "../server/profile-extract";
import { normalizeProfile } from "../shared/profile";
import { parseJudgeScores, parseDraftCheck } from "../server/advise";

test("剥思考块：<think> 包裹的 JSON 能解析", () => {
  const raw = '<think>用户想让我抽取画像……我先分析一下。</think>{"interests":["看展"]}';
  const parsed = parseExtraction(raw);
  assert.deepEqual(parsed.interests, ["看展"]);
});

test("宽容抽取：interests 是对象数组时取字段", () => {
  const raw = '{"interests":[{"name":"看展","reason":"提过三次"},{"topic":"摄影"}],"boundaries":[]}';
  const parsed = parseExtraction(raw);
  assert.deepEqual(parsed.interests, ["看展", "摄影"]);
});

test("宽容抽取：interests 是单个字符串时按分隔符拆", () => {
  const parsed = parseExtraction('{"interests":"看展、咖啡、爬山"}');
  assert.deepEqual(parsed.interests, ["看展", "咖啡", "爬山"]);
});

test("宽容抽取：事件是字符串数组/缺 at 都能收", () => {
  const parsed = parseExtraction('{"events":["11月期末周","3月 生日","假日"]}');
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[0].note, "11月期末周");
});

test("宽容抽取：超长字符串解析阶段保留、入库阶段由 normalizeProfile 截断", () => {
  const long = "很".repeat(60);
  const parsed = parseExtraction(`{"interests":["${long}"]}`);
  assert.equal(parsed.interests.length, 1);
  assert.ok(parsed.interests[0].length > 30, "解析阶段忠实保留原文");
  const saved = normalizeProfile(
    { interests: parsed.interests, boundaries: [], events: [] },
    "wx-test",
  );
  assert.ok(saved);
  assert.ok(saved.interests[0].length <= 31, "入库时截到 30 字上限");
});

test("宽容抽取：styleNote 是对象/数字也能转字符串", () => {
  const parsed = parseExtraction('{"styleNote":{"text":"偏短句"}}');
  assert.equal(parsed.styleNote, "偏短句");
});

test("宽容抽取：真的没有 JSON 才抛错", () => {
  assert.throws(() => parseExtraction("我觉得这段对话没什么可说的。"));
});

test("判官评分：字符串数字/百分号/中文键名都能解析", () => {
  const raw =
    '{"best":"2","scores":[{"index":"1","threshold":"70","risk":"40%"},{"index":2,"threshold":25,"risk":15}]}';
  const parsed = parseJudgeScores(raw);
  assert.equal(parsed.best, 2);
  assert.equal(parsed.scores[0].threshold, 70);
  assert.equal(parsed.scores[0].risk, 40);
});

test("判官评分：best 缺失时自动取门槛最低者", () => {
  const parsed = parseJudgeScores(
    '{"scores":[{"index":1,"threshold":70,"risk":40},{"index":2,"threshold":25,"risk":15}]}',
  );
  assert.equal(parsed.best, 2);
});

test("体检：warmth 模糊匹配（'热情'→热络），数字字符串钳制", () => {
  const parsed = parseDraftCheck(
    '{"threshold":"85","warmth":"热情奔放","risk":"10","riskNote":"ok","comments":[],"rewrite":"x"}',
  );
  assert.equal(parsed.threshold, 85);
  assert.equal(parsed.warmth, "热络");
  assert.equal(parsed.risk, 10);
});

test("体检：超范围钳制而不是拒绝（模型无关稳健性）", () => {
  const parsed = parseDraftCheck(
    '{"threshold":200,"warmth":"不知道","risk":-5,"riskNote":"","comments":[],"rewrite":""}',
  );
  assert.equal(parsed.threshold, 100);
  assert.equal(parsed.risk, 0);
});

test("配平扫描：字符串里的花括号不会截断 JSON", () => {
  const raw = '前缀 {"a":"包含 } 花括号的字符串","b":{"c":1}} 后缀';
  const obj = extractBalancedObject(raw) as { a: string; b: { c: number } };
  assert.ok(obj.a.includes("}"));
  assert.equal(obj.b.c, 1);
});

test("配平扫描：尾逗号/中文引号自动修复", () => {
  const obj = extractBalancedObject('{"a":["x","y",],"note":"“中文引号”"}') as {
    a: string[];
    note: string;
  };
  assert.deepEqual(obj.a, ["x", "y"]);
  assert.equal(obj.note, "“中文引号”");
});

test("配平扫描：修复只作用于结构层，字符串值内的逗号/引号原样保留", () => {
  const raw =
    '{"note":"abc,}", "interests":["咖啡、]"], "text":"她说“明天见”", "tail":"x、}"}';
  const obj = extractBalancedObject(raw) as {
    note: string;
    interests: string[];
    text: string;
    tail: string;
  };
  assert.equal(obj.note, "abc,}", "字符串里的 ,} 不能被当成尾逗号吃掉");
  assert.deepEqual(obj.interests, ["咖啡、]"], "字符串里的 、] 必须保留");
  assert.equal(obj.text, "她说“明天见”", "字符串里的中文引号必须保留");
  assert.equal(obj.tail, "x、}");
});

test("配平扫描：结构层的中文引号定界符仍能修复", () => {
  const obj = extractBalancedObject('{“a”: "x", ‘b’: [1, 2,]}') as {
    a: string;
    b: number[];
  };
  assert.equal(obj.a, "x");
  assert.deepEqual(obj.b, [1, 2]);
});

test("配平扫描：转义引号之后的字符仍正确跟踪字符串边界", () => {
  const obj = extractBalancedObject(
    '{"a":"含转义 \\" 和 ,} 的引号"}',
  ) as { a: string };
  assert.equal(obj.a, '含转义 " 和 ,} 的引号');
});

test("coerceStringArray：去重 + 截断", () => {
  assert.deepEqual(coerceStringArray(["咖啡", "咖啡", "茶"], 2), ["咖啡", "茶"]);
  assert.deepEqual(coerceStringArray("看展，咖啡；爬山", 5), ["看展", "咖啡", "爬山"]);
  assert.deepEqual(coerceStringArray(null, 5), []);
});

test("coerceProbability：65 → 0.65，'45%' → 0.45，0.5 → 0.5", () => {
  assert.equal(coerceProbability(65), 0.65);
  assert.equal(coerceProbability("45%"), 0.45);
  assert.equal(coerceProbability(0.5), 0.5);
  assert.equal(coerceProbability("没数字"), null);
});

test("coerceNumber/coerceString 基础形态", () => {
  assert.equal(coerceNumber("12条"), 12);
  assert.equal(coerceString({ a: "短", b: "这是更长的值" }), "这是更长的值");
  assert.equal(coerceString(42), "42");
  assert.equal(coerceString(null), undefined);
});
