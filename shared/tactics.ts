/**
 * 聊天策略知识库的机器可读层（docs/聊天策略知识库.md 是事实来源，此处是注入用蒸馏）。
 * advise.ts 按问题类别选取 2-4 条"判据化注入句"挂进 system prompt，附守卫句。
 * 边界规则优先于一切策略；策略只影响行动层候选生成，不进判官 prompt（感知层保持确定性）。
 */

export type TacticCategory = "接球" | "推进" | "修复" | "邀约" | "解读护栏";

export type Tactic = {
  id: string;
  title: string;
  categories: TacticCategory[];
  /** 判据化注入句：顾问在什么信号下、怎么约束候选生成 */
  injection: string;
};

export const TACTICS: Tactic[] = [
  {
    id: "T-001",
    title: "接球三件套：回应性",
    categories: ["接球"],
    injection:
      "接球类候选必须含至少一个指向对方披露内容的成分（复述要点/确认感受/追问细节），纯自我转向的候选降权；对方倾诉负面情绪且指向外部事件时先共情，不急着给方案。",
  },
  {
    id: "T-002",
    title: "主动-建设性回应（对方分享好事时）",
    categories: ["接球"],
    injection:
      "若对方末段在分享好事，至少出一个「追问细节+正面放大」型候选，并标注它比「简单祝贺」型风险更低；对方只是随口一提（消息短、无情绪投入）时不做大动作。",
  },
  {
    id: "T-003",
    title: "识别连接邀请（bids）",
    categories: ["接球"],
    injection:
      "对方的表情包/随口吐槽/分享链接都是连接邀请：候选要给出增量（新增信息或新问题），纯「哈哈/是的」式确认词候选标注「转离风险」；对方含蓄是常态，别把「没有直说」当「没兴趣」。",
  },
  {
    id: "T-004",
    title: "互惠披露阶梯：一次只深一层",
    categories: ["推进"],
    injection:
      "「推进话题」类候选相对当前对话最多深一层（事实→观点→感受），且含对等量的自我披露；对方明确绕开的话题立即回退一层，不追问。",
  },
  {
    id: "T-005",
    title: "修复话术：说砸之后",
    categories: ["修复"],
    injection:
      "上下文含负情绪指向我时，候选必含一个修复类选项（承认+轻幽默/换话题），排序高于推进类；修复不等于过度道歉，过度道歉抬高后续回应门槛。",
  },
  {
    id: "T-006",
    title: "振荡回落≠降温",
    categories: ["解读护栏"],
    injection:
      "水位短期回落期不生成「测试对方」「试探一下」类候选；回落先区分正常振荡与趋势下跌，再把动作建议交给判断。",
  },
  {
    id: "T-007",
    title: "短回复按人校准",
    categories: ["解读护栏"],
    injection:
      "解读短回复先看行为基线——简短≠冷淡，常态内的短回复不是负信号；只有「偏离习惯」（短回复率突然上升+间隔同时拉长）才值得注意。",
  },
  {
    id: "T-008",
    title: "邀约具体化+低压力出口",
    categories: ["邀约"],
    injection:
      "邀约类候选检查三要素：具体选项×2（二选一而非开放式「有空吗」）、天然退出口（「不行也没事，下次再约」）、不翻旧账；对方明显在高压期（考试/加班/家事）时不催邀约，也不重提被拒绝过的活动。",
  },
  {
    id: "T-009",
    title: "主动发 bid：小额高频",
    categories: ["推进"],
    injection:
      "用户想主动联系时，优先出「小额分享」类候选（看到这个想起你/梗图/日常小事），而非重型表白或长篇；连接邀请是低压力无索取的，带「在吗/怎么不回」式催促就不算。",
  },
  {
    id: "T-010",
    title: "唤起错归因（吊桥效应）",
    categories: ["邀约"],
    injection:
      "邀约活动选型按「共同新体验」（新鲜+适度唤醒：密室/悬疑片/爬山）加权一档；同时提醒刺激性场景后的心动要打折——唤醒源可能在场景，以后续行为为准。",
  },
  {
    id: "T-011",
    title: "不确定感放大心动：上头≠进度条",
    categories: ["解读护栏"],
    injection:
      "用户的心动强度含不确定感放大成分：关系进度判断以行为信号（对方主动频率/回复意愿）为准，不以主观上头程度为准；绝不建议制造忽冷忽热来吊人（操纵类，禁用）。",
  },
  {
    id: "T-012",
    title: "追问式提问",
    categories: ["接球", "推进"],
    injection:
      "候选里的问句必须是针对对方上一条内容的追问，而非话题跳跃或查户口式连环问；连续问句超过一个降权；想自己填场时，先改成一个追问。",
  },
];

export const TACTIC_GUARD =
  "以上策略是候选生成的参考，判断仍落在聊天原话上；边界规则（对方拒绝/需要空间时只给尊重边界的收尾）优先于一切策略。";

/** 问题→类别的关键词路由（v0 词面规则，纯函数可测；宁多选不漏配）。 */
export function classifyQuestion(question: string): TacticCategory[] {
  const q = question.toLowerCase();
  const out = new Set<TacticCategory>();
  if (/(邀|约对方|约她|约他|约出来|见面|出去(玩|走)|约会|约个|见一面)/.test(q))
    out.add("邀约");
  if (/(修复|道歉|说错|吵架|冷战|得罪|误会|惹(她|他|对方|TA|ta)|生气|冒犯)/.test(q))
    out.add("修复");
  if (
    /(什么意思|怎么看|怎么解读|冷淡|忽冷忽热|上头|心动|喜欢我|对我有意思|测试|试探|是不是不喜欢|敷衍)/.test(
      q,
    )
  )
    out.add("解读护栏");
  if (/(推进|话题|聊什么|开(个)?话题|主动|下一步|深(入|聊)|拉近)/.test(q))
    out.add("推进");
  if (
    /(怎么回|回什么|怎么接|接(不住|话)|她(说|发)|他(说|发)|对方(说|发)|回复|聊得|接球|怎么聊)/.test(
      q,
    )
  )
    out.add("接球");
  if (!out.size) {
    out.add("接球");
    out.add("推进");
  }
  return [...out];
}

/** 按类别选策略：命中类别依序取，去重，最多 limit 条（2-4 的经验区间由调用方控制）。 */
export function selectTactics(question: string, limit = 3): Tactic[] {
  const categories = classifyQuestion(question);
  const picked: Tactic[] = [];
  const seen = new Set<string>();
  for (const cat of categories) {
    for (const t of TACTICS.filter((x) => x.categories.includes(cat))) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      picked.push(t);
      if (picked.length >= limit) return picked;
    }
  }
  return picked;
}

/** 组装注入块（advise.ts 拼进 system prompt）；没有命中策略时返回空串。 */
export function buildTacticsNote(question: string, limit = 3): string {
  const picked = selectTactics(question, limit);
  if (!picked.length) return "";
  const lines = picked.map((t) => `- 【${t.title}】${t.injection}`);
  return `\n策略参考（按问题类别选取，来自聊天策略知识库）：\n${lines.join("\n")}\n${TACTIC_GUARD}`;
}
