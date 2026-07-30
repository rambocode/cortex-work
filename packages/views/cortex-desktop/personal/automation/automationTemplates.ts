// 自动化页专属的「默认模板」展示数据（纯视图层，不进 core）。
// 设计取舍：
//  - 模板只提供「部分草稿」（prompt / schedule / effort），不含 agent；
//    agent 由创建弹窗按当前可用项兜底（避免在数据里硬编码一个可能未安装的 agent）。
//  - once 模板（体检、会议）的 schedule.at 是占位 0，真正的触发时刻由 AutomationView
//    在用户点选模板时用 `Date.now() + onceOffsetMs` 计算并覆盖，提示词内也引导用户
//    自行改成目标日期/时间。
//  - 图标只复用 @cortex-work/ui/icons 已有键，不新增图标以控制范围。

import { Icon } from "@cortex-work/ui/icons";
import type { ReasoningEffort, ScheduleSpec } from "@cortex-work/core";

// 合法图标键：约束 icon 字段只能取现有 Icon 集合里的键。
type IconKey = keyof typeof Icon;

export interface AutomationTemplate {
  id: string; // 稳定 key（kebab）
  name: string; // 卡片标题 = 预填到弹窗的标题
  description: string; // 卡片副标题（一行简介）
  icon: IconKey; // 复用 @cortex-work/ui/icons 现有图标
  draft: {
    // 预填进创建弹窗（不含 agent，agent 由弹窗兜底）
    prompt: string;
    schedule: ScheduleSpec;
    effort?: ReasoningEffort;
  };
  // 仅 once 模板：点选时调用方用 Date.now() + onceOffsetMs 覆盖 schedule.at。
  onceOffsetMs?: number;
}

// 一天的毫秒数：once 模板默认偏移 +1 天，引导用户改成自己的目标时间。
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// 精选的 11 个自动化模板（提示词逐字采用计划 U4 写定文案）。
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "daily-ai-news",
    name: "每日 AI 新闻推送",
    description: "关注当天 AI 领域的重要动态，每日汇总 5 条精选资讯",
    icon: "Globe",
    draft: {
      prompt:
        "你是我的 AI 行业资讯助理。请检索并汇总过去 24 小时内人工智能领域最重要的 5 条动态(模型发布、重要论文、行业事件、产品更新、政策监管)。每条给出:① 一句话标题;② 2-3 句要点;③ 为什么值得关注;④ 来源链接(如可获取)。按重要性排序,用简洁中文 Markdown 输出,总长 400 字内。若无法联网,请说明并改为基于已知信息给出近期值得关注的 AI 趋势。",
      schedule: { kind: "daily", hour: 9, minute: 0 },
    },
  },
  {
    id: "daily-english-words",
    name: "每日 5 个英语单词",
    description: "每天学 5 个高频实用单词，含音标、释义与例句",
    icon: "At",
    draft: {
      prompt:
        "请为正在提升英语的学习者推荐 5 个高频实用英语单词(日常或职场场景,难度 CEFR B1-B2)。每个给出:① 单词+音标;② 中文释义与词性;③ 一个地道例句及中文翻译;④ 一个常见搭配或近义词辨析。避免过于基础或生僻的词。用清晰的中文 Markdown 列表输出。",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    },
  },
  {
    id: "daily-bedtime-story",
    name: "每日儿童睡前故事",
    description: "每晚一个温暖治愈的原创睡前故事，适合家长朗读",
    icon: "Sparkle",
    draft: {
      prompt:
        "请为 3-8 岁孩子创作一个温暖治愈的原创睡前故事,约 400-600 字(3-5 分钟朗读量)。要求:① 主题积极(勇气/友善/好奇心/分享任选其一);② 语言简单生动有画面感,适合家长朗读;③ 结尾一句温柔的晚安寄语。先给标题再给正文。不要恐怖或紧张情节。",
      schedule: { kind: "daily", hour: 20, minute: 0 },
    },
  },
  {
    id: "weekly-work-report",
    name: "每周工作周报",
    description: "每周五自动汇总本周提交与进展，生成简洁周报",
    icon: "Chart",
    draft: {
      prompt:
        "请汇总我本周的工作进展,生成简洁周报。基于当前项目仓库:① 用 git 查看最近 7 天提交与合并改动;② 归纳本周完成的主要工作(按主题分组);③ 列出进行中/未完成事项;④ 给出下周建议聚焦的 2-3 个重点。中文 Markdown,500 字内。提示:请在创建时为本任务选择关联「项目」,否则无法读取仓库信息。",
      schedule: { kind: "weekly", weekday: 5, hour: 18, minute: 0 },
      effort: "medium",
    },
  },
  {
    id: "daily-classic-movie",
    name: "经典电影推荐",
    description: "每天推荐一部高分经典电影，含看点与剧情简介",
    icon: "Image",
    draft: {
      prompt:
        "请推荐一部高分经典电影(评分较高、上映满 5 年以上)。给出:① 片名(中/英)、年份、导演、主演;② 不剧透的一句话看点;③ 3-4 句剧情简介;④ 适合的观影心情或场景;⑤ 一句推荐语。尽量每天换不同类型(剧情/科幻/悬疑/动画/喜剧)。中文 Markdown 输出。",
      schedule: { kind: "daily", hour: 21, minute: 0 },
    },
  },
  {
    id: "today-in-history",
    name: "历史上的今天",
    description: "每天挑选一件有趣有启发的历史事件，轻松开启一天",
    icon: "Clock",
    draft: {
      prompt:
        "请从科技、电影、音乐、科学、文化等领域挑选「历史上的今天」发生的一件有趣有启发的事件(优先相对小众但有意思的)。给出:① 日期与事件标题;② 3-4 句背景经过;③ 它的影响或一个值得回味的细节。语气轻松,中文 Markdown,200 字左右。以运行当天日期为准。",
      schedule: { kind: "daily", hour: 7, minute: 0 },
    },
  },
  {
    id: "daily-why",
    name: "每日一个为什么",
    description: "每天抛出一个常被忽略的「为什么」并通俗解答",
    icon: "Info",
    draft: {
      prompt:
        "请抛出一个有趣、生活中常被忽略的「为什么」(科学/生活常识/心理/自然现象皆可),再通俗解答。结构:① 今日问题(一句话);② 30 秒能看懂的简短答案;③ 展开 3-4 句原理;④ 一个相关冷知识。避免过于学术,中文 Markdown,每天换不同领域。",
      schedule: { kind: "daily", hour: 8, minute: 30 },
    },
  },
  {
    id: "weekly-call-parents",
    name: "父母联系提醒",
    description: "每周日温柔提醒给家人打电话，附可聊的话题",
    icon: "Users",
    draft: {
      prompt:
        "现在是周末,温柔提醒我:别忘了给家人打电话或发条消息,陪他们聊几句。请生成:① 一句暖心提醒语;② 3 个可和父母聊的轻松话题或问候开场白(近况/健康/回忆/计划);③ 一句关于陪伴的小感悟。中文 Markdown,简短即可。",
      schedule: { kind: "weekly", weekday: 0, hour: 10, minute: 0 },
    },
  },
  {
    id: "health-checkup-reminder",
    name: "体检预约提醒",
    description: "一次性提醒确认并预约体检，附准备清单（点选后请改成目标时间）",
    icon: "Bell",
    draft: {
      // once 占位：at 为 0，点选时由 AutomationView 用 Date.now() + onceOffsetMs 覆盖。
      prompt:
        "提醒我:该确认并预约体检了。请生成简短行动清单:① 提醒语;② 体检前准备(空腹、证件、既往报告、预约时段等);③ 建议关注的常规检查项目(按年龄/性别通用建议);④ 一句健康鼓励。中文 Markdown 输出。",
      schedule: { kind: "once", at: 0 },
    },
    onceOffsetMs: ONE_DAY_MS,
  },
  {
    id: "interview-prep",
    name: "面试准备提醒",
    description: "工作日每 2 小时一道 AI 工程师高频面试题，碎片复习",
    icon: "Code",
    draft: {
      prompt:
        "现在是复习时间,帮我做大模型/AI 工程师面试准备。随机选 1 个高频主题(Transformer 结构、注意力机制、微调与 RLHF、RAG、推理优化、评测指标、分布式训练等),给出:① 主题名;② 一道典型面试题;③ 要点清晰的参考答案(分点 3-6 条);④ 一个可能的追问及简答。中文 Markdown,400 字内,便于碎片时间复习。",
      schedule: { kind: "cron", expression: "0 9-19/2 * * 1-5" },
    },
  },
  {
    id: "meeting-prep",
    name: "会议前准备",
    description: "一次性生成会前准备清单，快速进入状态（点选后请改成目标时间）",
    icon: "Task",
    draft: {
      // once 占位：at 为 0，点选时由 AutomationView 用 Date.now() + onceOffsetMs 覆盖。
      prompt:
        "我马上要开一个会,帮我快速进入状态。请生成会前准备清单:① 明确会议目标的引导问题(这次会要达成什么?);② 我需要提前整理的议题/材料清单;③ 3 个可主动提出或确认的关键点;④ 一句让自己专注高效的提醒。中文 Markdown,简洁可执行。",
      schedule: { kind: "once", at: 0 },
    },
    onceOffsetMs: ONE_DAY_MS,
  },
];
