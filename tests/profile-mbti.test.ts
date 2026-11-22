// MBTI 推测修准（2026-11-03）：单侧归因 / 双采样合并 / 证据回验 / 解析与规整
// 2026-11-04 二轮：12 票集成 / 词面统计代码裁决 / 短促拍板 J 信号 / F 族去幽默词
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile } from "../shared/profile";
import {
  MBTI_DECISIVE_RE,
  MBTI_MIN_MESSAGES,
  mbtiAxisCounts,
  mbtiBehaviorNotes,
  mbtiStructuralNotes,
  mergeMbtiSamples,
  parseMbti,
  splitChunks,
  verifyEvidence,
  type MbtiInference,
} from "../server/profile-extract";

const axis = (dim: string, pick: string, percent: number, evidence?: string): MbtiInference["axes"][number] => ({
  dim,
  pick,
  percent,
  evidence,
});

test("parseMbti：合法 JSON、容忍 78%/0.78、非法 type 拒绝", () => {
  const ok = parseMbti(
    '{"type":"entj","axes":[{"dim":"E/I 外向-内向","pick":"E","percent":"78%","evidence":"走，出去吃"},{"dim":"S/N","pick":"N","percent":0.65},{"dim":"T/F","pick":"T","percent":80},{"dim":"J/P","pick":"J","percent":70}]}',
  );
  assert.ok(ok);
  assert.equal(ok.type, "ENTJ");
  assert.equal(ok.axes[0].percent, 78);
  assert.equal(ok.axes[1].percent, 65);
  assert.equal(ok.axes.length, 4);
  assert.throws(() => parseMbti("这不是JSON"), "完全没有 JSON 时抛错（调用方 catch）");
  assert.equal(
    parseMbti('{"type":"XXXX","axes":[]}'),
    null,
    "type 不合法整体拒绝（宁缺勿错）",
  );
});

test("采样合并：一致取均值；平票压 50 注记；多数派按票数份额缩放；type 重拼自洽", () => {
  const a: MbtiInference = {
    type: "INTJ",
    axes: [
      axis("E/I 外向-内向", "I", 70, "先走了"),
      axis("S/N 实感-直觉", "N", 70),
      axis("T/F 思考-情感", "T", 60),
      axis("J/P 判断-感知", "P", 80),
    ],
  };
  const b: MbtiInference = {
    type: "ENTP",
    axes: [
      axis("E/I 外向-内向", "E", 80),
      axis("S/N 实感-直觉", "N", 60),
      axis("T/F 思考-情感", "T", 75),
      axis("J/P 判断-感知", "P", 55),
    ],
  };
  const m = mergeMbtiSamples([a, b]);
  assert.equal(m.axes[0].pick, "E", "平票取置信高的一侧");
  assert.equal(m.axes[0].percent, 50);
  assert.equal(m.axes[0].note, "采样不一致 (1:1)");
  assert.equal(m.axes[1].pick, "N");
  assert.equal(m.axes[1].percent, 65, "全票一致取均值 (70+60)/2");
  assert.equal(m.type, "ENTP", "type 从合并后 picks 重拼，与四轴自洽");
  assert.equal(mergeMbtiSamples([a]), a, "单样本原样返回");

  // N 路：3:1 多数派——均值 70 × (0.5 + 3/4/2) = 61，注记票型
  const c: MbtiInference = {
    type: "INTP",
    axes: [
      axis("E/I 外向-内向", "I", 55),
      axis("S/N 实感-直觉", "N", 70),
      axis("T/F 思考-情感", "T", 65),
      axis("J/P 判断-感知", "P", 70),
    ],
  };
  const d: MbtiInference = {
    type: "ISFP",
    axes: [
      axis("E/I 外向-内向", "I", 60),
      axis("S/N 实感-直觉", "S", 80),
      axis("T/F 思考-情感", "F", 70),
      axis("J/P 判断-感知", "P", 60),
    ],
  };
  const m4 = mergeMbtiSamples([b, c, a, d]); // N:70,60,70 vs S:80 → 3:1
  const sAxis = m4.axes.find((x) => mbtiKey(x.dim) === "S/N")!;
  assert.equal(sAxis.pick, "N");
  assert.equal(sAxis.percent, Math.round(((70 + 60 + 70) / 3) * (0.5 + 3 / 4 / 2)));
  assert.equal(sAxis.note, "4 份采样 3:1 分裂");
  const fAxis = m4.axes.find((x) => mbtiKey(x.dim) === "T/F")!;
  assert.equal(fAxis.pick, "T", "3:1 多数派 T");
  assert.equal(fAxis.percent, Math.round(((75 + 65 + 60) / 3) * (0.5 + 3 / 4 / 2)));
  assert.equal(fAxis.note, "4 份采样 3:1 分裂");
});

function mbtiKey(dim: string): string {
  return dim.trim().split(/[\s（(]/)[0].slice(0, 3);
}

test("splitChunks：连续块覆盖全部且不重叠；~150 条/块；样本少 1 块", () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const chunks = splitChunks(items, 4);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.flat(), items, "保持时序、覆盖全部、不重叠");
  assert.ok(chunks.every((c) => c.length <= 250));
  assert.equal(splitChunks([1, 2, 3], 4).length, 1, "小样本单块");
});

test("mbtiBehaviorNotes：词面计数属实、T/F 与 J/P 两行总输出、少样本返回空", () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({
    text: i < 6 ? "今天明天几点如果" : "随便到时候再说开心",
  }));
  const notes = mbtiBehaviorNotes(msgs);
  assert.ok(notes.includes("样本 12 条"));
  assert.ok(notes.includes("前瞻假设词"), "含 N 侧词");
  assert.ok(notes.includes("随机随性词"), "含 P 侧词");
  assert.ok(notes.includes("情绪感受词"), "含 F 侧词");
  assert.ok(notes.includes("既定/拍板词"), "J 侧行总输出（裁决规则需两侧数字可见）");
  assert.ok(notes.includes("推断方案词"), "T 侧行总输出");
  assert.ok(!notes.includes("笑死"), "幽默词已从 F 族剔除");
  assert.equal(mbtiBehaviorNotes([{ text: "太少" }]), "", "<10 条不出统计");
  // 结构信号行会被 extraLines 追加进统计块
  assert.ok(
    mbtiBehaviorNotes(msgs, ["- 开新会话占比：TA 4/6（67%）"]).includes("TA 4/6（67%）"),
  );
});

test("mbtiAxisCounts：短促拍板并入 J 计数（一条消息只计一次）", () => {
  const msgs = ["行", "走吧！", "好的", "ok", "计划安排", "随便", "到时候再说", "如果呢", "开心", "其实没毛病", "干嘛", "几点见"].map((text) => ({ text }));
  const c = mbtiAxisCounts(msgs)!;
  assert.equal(c.total, 12);
  // J：行 / 走吧！/ ok（拍板）+ 计划安排 + 几点见 = 5（"好的"是应答，不算拍板）
  assert.equal(c.j, 5);
  assert.equal(c.p, 2, "随便 + 到时候再说");
  assert.equal(c.f, 1, "开心");
  assert.equal(c.t, 1, "其实");
  assert.equal(c.n, 1, "如果");
  assert.ok(MBTI_DECISIVE_RE.test("没问题！"), "宽容尾部语气词");
  assert.ok(!MBTI_DECISIVE_RE.test("行的呀挺好"), "非纯拍板不匹配");
  assert.ok(!MBTI_DECISIVE_RE.test("不行"), "否定不是拍板");
});


test("mbtiBehaviorNotes 三轮：E/I 与 S/N 两行总输出（含 0%）", () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ text: i === 0 ? "兄弟聚不聚" : "嗯" }));
  const notes = mbtiBehaviorNotes(msgs);
  assert.ok(notes.includes("社交能量词（E 侧）："), "E/I 行总输出");
  assert.ok(notes.includes("独处能量词（I 侧）："), "I 侧数字可见");
  assert.ok(notes.includes("前瞻假设词（N 侧）："), "N 侧数字可见");
  assert.ok(notes.includes("当下细节词（S 侧）："), "S 侧数字可见（裁决需要两侧）");
});

test("mbtiStructuralNotes：只出两侧长度中位数（开聊占比受关系动态污染，不作证据）", () => {
  const mk = (sender: "other" | "self", text: string, timestamp: string) => ({
    sender,
    text,
    timestamp,
  });
  const msgs = [
    mk("other", "今天天气不错我们出去玩吧", "2026-01-01 08:00:00"),
    mk("self", "好呀几点出发", "2026-01-01 08:05:00"),
    mk("other", "十点直接来楼下", "2026-01-01 13:00:00"),
    mk("self", "下午去打球吗今天天气好呀", "2026-01-02 08:00:00"),
    mk("other", "走", "2026-01-02 08:30:00"),
  ];
  const lines = mbtiStructuralNotes(msgs, "other");
  assert.ok(lines.some((l) => l.includes("长度中位数：TA") && l.includes("用户")));
  assert.ok(!lines.some((l) => l.includes("开新会话") || l.includes("开聊")), "开聊占比不注入");
});

test("证据回验：转写行前缀（我/对方（时间）：）剥除后再匹配，整行照抄不误杀", () => {
  const msgs = [{ text: "那不可能的" }, { text: "我成绩不稳定的" }];
  const v = verifyEvidence(
    {
      type: "ENTJ",
      axes: [
        axis(
          "E/I 外向-内向",
          "E",
          72,
          "对方（2023年4月9日 15:36）：那不可能的\n对方（2023年4月9日 15:36）：我成绩不稳定的",
        ),
      ],
    },
    msgs,
  );
  assert.equal(v.axes[0].percent, 72, "带前缀证据剥前缀后匹配成功，不砍半");
  assert.equal(v.axes[0].note, undefined);
});

test("证据回验：多段证据（cleanEvidence 的分号拼接）多数命中即核实", () => {
  const msgs = [{ text: "那不可能的" }, { text: "我成绩不稳定的" }, { text: "区统考吗" }];
  const v = verifyEvidence(
    {
      type: "ENTJ",
      axes: [
        axis("E/I", "E", 72, "那不可能的；我成绩不稳定的；区统考吗"),
        axis("T/F", "T", 60, "那不可能的；完全编造的句子啊"),
      ],
    },
    msgs,
  );
  assert.equal(v.axes[0].percent, 72, "3/3 段命中不砍半");
  assert.equal(v.axes[0].note, undefined);
  assert.equal(v.axes[1].percent, 60, "1/2 段命中=多数，保留置信但注记");
  assert.equal(v.axes[1].note, "证据部分核实（1/2 段）");
});

test("cleanEvidence：parseMbti 出口清洗证据（逐行剥前缀、多行并句）", () => {
  const ok = parseMbti(
    '{"type":"entj","axes":[{"dim":"E/I 外向-内向","pick":"E","percent":72,"evidence":"对方（2023年4月9日 15:36）：那不可能的\\n我（2023年4月9日 15:37）：哦\\n对方（2023年4月9日 15:38）：我成绩不稳定的"}]}',
  );
  assert.ok(ok);
  assert.equal(ok.axes[0].evidence, "那不可能的；哦；我成绩不稳定的");
});

test("证据回验：能在原文找到的原样保留，找不到/过短的压半并注记", () => {
  const msgs = [
    { text: "今天天气不错，一起去爬山吧" },
    { text: "周五晚上一起吃火锅？我请客" },
  ];
  const in1: MbtiInference = {
    type: "ENTJ",
    axes: [
      axis("E/I 外向-内向", "E", 80, "一起去爬山吧"),
      axis("S/N 实感-直觉", "S", 70, "昨天梦到自己会飞了"),
      axis("T/F 思考-情感", "T", 60, "嗯"),
    ],
  };
  const v = verifyEvidence(in1, msgs);
  assert.equal(v.axes[0].percent, 80, "逐字匹配的保留");
  assert.equal(v.axes[0].note, undefined);
  assert.equal(v.axes[1].percent, 35, "匹配不上减半 70→35");
  assert.equal(v.axes[1].note, "证据未核实");
  assert.equal(v.axes[2].percent, 30, "过短证据（<4字）减半并注记");
  assert.equal(v.axes[2].note, "证据过短未核实");
});

test("样本门槛常量与 baseline 口径一致（20 条）", () => {
  assert.equal(MBTI_MIN_MESSAGES, 20);
});

test("画像规整透传 source/samples/note，非法值丢弃", () => {
  const p = normalizeProfile(
    {
      mbti: {
        type: "entj",
        axes: [
          { dim: "E/I 外向-内向", pick: "E", percent: 72, note: "证据未核实" },
          { dim: "S/N 实感-直觉", pick: "N", percent: 70 },
          { dim: "T/F 思考-情感", pick: "T", percent: 68 },
          { dim: "J/P 判断-感知", pick: "J", percent: 66 },
        ],
        source: "self",
        samples: 123,
        note: "文本证据有限：2/4 轴置信 ≤55，此结果仅作弱参考",
      },
    },
    "wxid_x",
  );
  assert.ok(p?.mbti);
  assert.equal(p.mbti.type, "ENTJ");
  assert.equal(p.mbti.source, "self");
  assert.equal(p.mbti.samples, 123);
  assert.equal(p.mbti.axes[0].note, "证据未核实");
  assert.equal(p.mbti.note, "文本证据有限：2/4 轴置信 ≤55，此结果仅作弱参考");
  // 修准后语义：四轴不齐 → 丢弃 type（宁可说测不准），但保留逐轴结论
  const partial = normalizeProfile(
    {
      mbti: { type: "ENTJ", axes: [{ dim: "E/I", pick: "E", percent: 72 }] },
    },
    "wxid_x",
  );
  assert.equal(partial?.mbti?.type, undefined, "缺轴时不给四字母");
  assert.equal(partial?.mbti?.axes.length, 1, "逐轴结论保留");
  const bad = normalizeProfile(
    { mbti: { type: "ENTJ", source: "别人的", samples: -5 } },
    "wxid_x",
  );
  assert.equal(bad?.mbti?.source, undefined, "非法 source 丢弃");
  assert.equal(bad?.mbti?.samples, undefined, "负数 samples 丢弃");
});
