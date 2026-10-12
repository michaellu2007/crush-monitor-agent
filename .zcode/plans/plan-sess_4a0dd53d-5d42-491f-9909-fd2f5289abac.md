# 建立《情感文献参考.md》并勘误计划文档

## 背景与目标

三个计划文档（《开发主计划》《评估改进计划》《顾问与亲密度实现计划》）中的情感建模设计——valence 聚合、半衰期 10 天、负信号 1.5×、情绪指向归因、词典基线、LLM 置信度问题——目前都没有文献支撑。本次已通过 CrossRef / arXiv / 出版方官网逐条在线验证了约 35 篇相关文献（非凭记忆），现在落成一份可长期维护的参考文档。

## 改动内容

1. **新建 `情感文献参考.md`**（项目根目录）：按设计概念分组，每条含完整引用 + DOI/链接 + 与项目概念的对应关系 + 引用注意事项
2. **《评估改进计划.md》**：第 2 步词典基线处勘误大连理工本体库出处（实际为《情报学报》2008, 27(2): 180-185，非中文信息学报），并链接参考文档
3. **《开发主计划.md》**：第二节末尾与里程碑 2 处各加一行指向参考文档的链接

## 参考文档内容骨架（文献均已验证存在）

### A. 聚合层参数依据（《评估改进计划》的数学设计）

| 计划概念 | 文献 |
|---|---|
| valence 标量 | Russell (1980). A circumplex model of affect. JPSP, 39(6), 1161–1178. DOI: 10.1037/h0077714 |
| 负信号 1.5×（定性依据） | Baumeister et al. (2001). Bad is stronger than good. Review of General Psychology, 5(4). DOI: 10.1037/1089-2680.5.4.323；Rozin & Royzman (2001). PSPR, 5(4). DOI: 10.1207/s15327957pspr0504_2 |
| 损失厌恶系数 | Tversky & Kahneman (1992). J Risk Uncertain, 5(4). DOI: 10.1007/BF00122574 —— **λ≈2.25 出自 1992 这篇，非 1979 原文**；1.5× 可表述为"取文献下界，按数据自标定" |
| 半衰期 10 天 | Verduyn & Lavrijsen (2015). Motivation and Emotion, 39(1). DOI: 10.1007/s11031-014-9445-y（只定数量级，无 10 天直接值，需自标定）；Houben et al. (2015) 元分析 Psych Bulletin 141(4). DOI: 10.1037/a0038822（惯性参数分布）；Kuppens et al. (2010) 情绪惯性 Psych Science 21(7). DOI: 10.1177/0956797610372634 |
| 连续漂移 + 事件阶跃混合模型 | Kuppens & Verduyn (2017). Emotion dynamics. Curr Opin Psychol, 17. DOI: 10.1016/j.copsyc.2017.06.004（最贴切的框架文献） |
| 事件阶跃锚点 | Kahneman et al. (1993). 峰终定律. Psych Science, 4(6). DOI: 10.1111/j.1467-9280.1993.tb00589.x |

### B. 情绪指向归因（"妈的"指向事件 = 信任信号）

- Scherer (2009). The dynamic architecture of emotion. Cognition and Emotion, 23(7). DOI: 10.1080/02699930902928969 —— 评价理论的归因/责任归属维度，归因模块首选引文
- Lazarus (1982). American Psychologist, 37(9). DOI: 10.1037/0003-066X.37.9.1019
- Weiner (1985). 归因三维框架. Psych Review, 92(4). DOI: 10.1037/0033-295X.92.4.548（指向稳定特质 vs 临时事件的衰减速度应不同的依据）

### C. 关系科学（好感度曲线到底在测什么）

- **亲密过程模型**（工具的理论引擎）：Reis & Shaver (1988) Handbook of Personal Relationships；实证操作化 Laurenceau, Barrett & Pietromonaco (1998). JPSP, 74(5). DOI: 10.1037/0022-3514.74.5.1238
- **回应门槛**：Reis, Clark & Holmes (2004). 感知的伴侣回应性. Handbook of Closeness and Intimacy
- **好感度动态曲线的数学合法性**：Gottman, Murray et al. (2002). The Mathematics of Marriage. MIT Press. DOI: 10.7551/mitpress/4499.001.0001；积极/消极比例实证 Gottman et al. (1998). J Marriage & Family, 60(1). DOI: 10.2307/353438（注意："5:1 magic ratio" 无严格同行评议出处，慎引，以 1998 论文为准）
- **关系阶段**：Altman & Taylor (1973). Social Penetration（社会渗透理论）；Berger & Calabrese (1975). 不确定性递减. Human Comm Research, 1(2). DOI: 10.1111/j.1468-2958.1975.tb00258.x
- **回复策略**（互惠披露）：Aron et al. (1997). PSPB, 23(4). DOI: 10.1177/0146167297234003（"36 问"实验）；Cozby (1972). Sociometry, 35(1). DOI: 10.2307/2786555
- **边界检测 / 冷淡预警**：Downey & Feldman (1996). 拒绝敏感性. JPSP, 70(6). DOI: 10.1037/0022-3514.70.6.1327
- **回复节奏按人校准**：Jin & Peña (2010). 依恋类型×短信行为. Communication Reports, 23(1). DOI: 10.1080/08934211003598742

### D. 词典基线与 judge 设计（NLP）

- **大连理工情感词汇本体**：徐琳宏， 林鸿飞等 (2008). 情感词汇本体的构造. **情报学报， 27(2): 180-185**（已勘误；大连理工 IR 实验室官网核实）
- **NTUSD**：Ku & Chen (2007). JASIST, 58(12). DOI: 10.1002/asi.20630（扩充版 ANTUSD: Wang & Ku, LREC 2016）
- **纯表情消息处理**：Kralj Novak et al. (2015). Sentiment of Emojis. PLOS ONE 10(12). DOI: 10.1371/journal.pone.0144296（751 个 emoji 情感排名）
- **单字"嗯"低信息量**：Kiritchenko et al. (2014). Sentiment Analysis of Short Informal Texts. JAIR, 50. DOI: 10.1613/jair.4272
- **LLM 置信度不可信**（计划诊断的实证确认）：Tian et al. (2023). Just Ask for Calibration. EMNLP. arXiv:2305.14975 —— RLHF LLM 系统性过度自信
- **选择题格式校准好 = JevK5 choice 协议依据**：Kadavath et al. (2022). LMs (Mostly) Know What They Know. arXiv:2207.05221
- **多选偏差需校正**：Zheng et al. (2024). ICLR 2024 Spotlight. arXiv:2309.03882；Wang et al. (2024). 首 token 概率≠文本答案. Findings ACL. DOI: 10.18653/v1/2024.findings-acl.441
- **本地小模型特征**：Fengshenbang 1.0 (arXiv:2209.02970)；Erlangshen (arXiv:2208.02959)；多选范式统一 NLU (arXiv:2210.08590)
- **奠基背景**：Picard (1997). Affective Computing. MIT Press；Pang & Lee (2008). FnTIR. DOI: 10.1561/1500000011；Liu (2012). DOI: 10.2200/S00416ED1V01Y201204HLT016

### E. 引用注意事项（写进文档末尾）

- 半衰期 10 天、负权重 1.5×、单条 1% 上限：文献只提供方向和数量级，具体数值需按自己数据标定，文档里如实标注
- Gottman "5:1" 与 Kramer (2014) 情绪传染（伦理争议）：给出替代引法
- 三条勘误：大连理工出处、NTUSD 出处、λ 出自 1992 论文

## 验收

- `情感文献参考.md` 每条文献带 DOI/arXiv/官网链接（全部本轮在线验证过）
- 两个计划文档勘误完成并有指向参考文档的链接
- 不改任何代码，`npm test` 不受影响