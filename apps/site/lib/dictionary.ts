import type { Locale } from "./i18n";

/* =========================================================================
   全站文案 + 类型契约（内容唯一真源）
   区块组件统一接收 { d: Dict; locale: Locale }，只读取这里定义的 key。
   文案原则（落地页）：标题承载意义，支撑句简短克制，产品化语言而非营销腔。
   所有功能描述均对照源码核实，不夸大、不把规划项说成已上线。
   ========================================================================= */

export interface AgentItem {
  /** 用于组件挑选品牌色：claude | codex | pi */
  key: "claude" | "codex" | "pi";
  name: string;
  tag: string;
  desc: string;
}

export interface FeatureItem {
  /** 图标键：workspace | timeline | review | automation | usage | terminal */
  icon: "workspace" | "timeline" | "review" | "automation" | "usage" | "terminal";
  title: string;
  desc: string;
}

export interface Dict {
  meta: { title: string; description: string; ogAlt: string };
  brand: { name: string; tagline: string };
  nav: { skills: string; notes: string; features: string; agents: string; github: string; download: string };
  links: { github: string; releases: string; webApp: string };
  hero: {
    eyebrow: string;
    title: string;
    titleAccent: string;
    sub: string;
    primary: string;
    secondary: string;
    trust: string;
    note: string;
  };
  agents: {
    eyebrow: string;
    title: string;
    sub: string;
    items: AgentItem[];
    extra: { title: string; providers: string[] };
  };
  /** Skill 按需注入 · 省 token（差异化核心，showcase） */
  skills: {
    eyebrow: string;
    title: string;
    sub: string;
    points: string[];
    mock: {
      panel: string;
      items: string[];
      hint: string;
      attach: string;
      toggle: string;
      toggleState: string;
      placeholder: string;
      context: string;
      contextNote: string;
    };
  };
  /** 闪记 / Flash Notes（showcase） */
  notes: {
    eyebrow: string;
    title: string;
    sub: string;
    points: string[];
    mock: {
      shortcut: string;
      title: string;
      placeholder: string;
      project: string;
      save: string;
      stage1: string;
      stage2: string;
      stage3: string;
      output: string;
      plan: string;
    };
  };
  features: { eyebrow: string; title: string; sub: string; items: FeatureItem[] };
  automation: {
    eyebrow: string;
    title: string;
    auto: { title: string; desc: string; bullets: string[] };
    usage: {
      title: string;
      desc: string;
      stat1: { value: string; label: string };
      stat2: { value: string; label: string };
    };
  };
  finalCta: { title: string; sub: string; primary: string; secondary: string; note: string };
  footer: {
    tagline: string;
    groups: { title: string; links: { label: string; href: string }[] }[];
    localFirst: string;
    copyright: string;
  };
  /** 无障碍专用文案：地标命名与跳转链接 */
  a11y: { primaryNav: string; footerNav: string; skipToContent: string };
}

const GITHUB = "https://github.com/rambocode/cortex-work";

const zh: Dict = {
  meta: {
    title: "Cortex Desktop · 把所有编码 Agent 请进同一个工作区",
    description:
      "本地优先的桌面工作台：默认不加载 agent 自带 skill 省 token，按需拖曳注入；闪记随手接住灵感，再让 agent 孵化成文档。Claude Code、Codex、Pi 一处协作。",
    ogAlt: "Cortex Desktop — 本地优先的 Agent 工作台",
  },
  brand: { name: "Cortex Desktop", tagline: "本地优先的 Agent 工作台" },
  nav: { skills: "Skills", notes: "闪记", features: "功能", agents: "Agent", github: "GitHub", download: "下载" },
  links: { github: GITHUB, releases: `${GITHUB}/releases`, webApp: "#" },
  hero: {
    eyebrow: "本地优先的 Agent 工作台",
    title: "把所有编码 Agent，请进",
    titleAccent: "同一个工作区",
    sub: "Cortex Desktop 是本地优先的桌面工作台：Claude Code、Codex、Pi 在你的项目里接活、汇报，每步改动都等你过审。",
    primary: "下载桌面端",
    secondary: "在浏览器试用",
    trust: "已支持 Claude · Codex · Pi，可接入更多模型通道",
    note: "macOS · 自动更新",
  },
  agents: {
    eyebrow: "多 Agent 生态",
    title: "一个界面，任意 Agent",
    sub: "统一的适配层把每个 CLI 归一化成同一套流式事件——切换 Agent，不必切换工具。",
    items: [
      { key: "claude", name: "Claude Code", tag: "Anthropic", desc: "深度推理与大刀阔斧的重构，复杂改动交给它。" },
      { key: "codex", name: "Codex", tag: "OpenAI", desc: "贴合工程上下文的快速执行，日常迭代的好手。" },
      { key: "pi", name: "Pi", tag: "开放通道", desc: "经 Pi 接入 GLM、Kimi、DeepSeek 等更多模型。" },
    ],
    extra: { title: "还能接入你自己的模型通道", providers: ["GLM", "Kimi", "DeepSeek", "自定义"] },
  },
  skills: {
    eyebrow: "更省 token",
    title: "默认不膨胀，拖谁注入谁",
    sub: "别让用不上的 skill 常驻 system prompt。Cortex Desktop 默认关掉 agent 自带 skill，需要时再从你的库里拖一个进会话。",
    points: [
      "默认关闭 agent 自带 skill，system prompt 不被一堆工具定义撑大。",
      "把 skill 从 Prompt 库拖进输入框，只对这一轮生效、发完即清，不进长期上下文。",
      "skill、任务、项目文件都能一拖即引用，气泡里看得见这条带了什么。",
    ],
    mock: {
      panel: "Prompt 库",
      items: ["code-review", "commit-msg", "refactor"],
      hint: "拖一个 skill 进来",
      attach: "code-review",
      toggle: "Agent 自带 Skills",
      toggleState: "关",
      placeholder: "描述你的需求…",
      context: "上下文",
      contextNote: "默认精简",
    },
  },
  notes: {
    eyebrow: "闪记 · Flash Notes",
    title: "灵感随手接住，不打断当前会话",
    sub: "协作中蹦出的想法，一个快捷键就接住——不污染会话，之后还能交给 agent 孵化成文档。",
    points: [
      "全局快捷键 ⌘⇧N 唤起浮层，主窗口收进托盘也能记。",
      "闪记落进收件箱与项目时间线，完全不进当前会话上下文。",
      "选中闪记一键「深化」，让 agent 把它孵化成 brainstorm / plan 文档。",
    ],
    mock: {
      shortcut: "⌘⇧N",
      title: "闪记",
      placeholder: "记点什么…",
      project: "cortex-work",
      save: "保存",
      stage1: "收件箱",
      stage2: "深化中",
      stage3: "已深化",
      output: "brainstorm.md",
      plan: "plan.md",
    },
  },
  features: {
    eyebrow: "核心能力",
    title: "为一整天的 Agent 协作而生",
    sub: "从接活到交付，每个环节都在你的掌控之中。",
    items: [
      { icon: "workspace", title: "个人工作区", desc: "三栏浮起式工作台，本地项目与多会话并行不打架。" },
      { icon: "timeline", title: "时间线", desc: "项目级活动回看，每次会话与改动都有迹可循。" },
      { icon: "review", title: "Diff 人审", desc: "每次改动以 diff 卡片呈现，一键批准或打回。" },
      { icon: "automation", title: "定时自动化", desc: "用定时任务让 Agent 在你离开时继续干活。" },
      { icon: "usage", title: "用量日历", desc: "按天累计 token 与任务量，成本一目了然。" },
      { icon: "terminal", title: "终端与 Git", desc: "内置终端、分支与提交，改动不出工作台。" },
    ],
  },
  automation: {
    eyebrow: "无人值守",
    title: "下班后，工作台不打烊",
    auto: {
      title: "定时自动化",
      desc: "把重复的活交给 cron 式任务：夜间跑测试、每天理 issue、定期生成报告。",
      bullets: ["每日 / 每周 / 自定义节奏", "失败自动重试与通知", "结果回流到时间线"],
    },
    usage: {
      title: "用量与节奏",
      desc: "用量日历按天回看消耗，时间线串起每个项目的活动。",
      stat1: { value: "42", label: "本周任务" },
      stat2: { value: "7", label: "自动化运行" },
    },
  },
  finalCta: {
    title: "开始你的智能体节奏",
    sub: "下载 Cortex Desktop，给你的工作台添几个不知疲倦的帮手。",
    primary: "下载桌面端",
    secondary: "查看 GitHub",
    note: "macOS · 本地优先 · 自动更新",
  },
  footer: {
    tagline: "把所有编码 Agent，请进同一个工作区。",
    groups: [
      {
        title: "产品",
        links: [
          { label: "Skills 省 token", href: "#skills" },
          { label: "闪记", href: "#notes" },
          { label: "功能", href: "#features" },
          { label: "Agent 生态", href: "#agents" },
          { label: "下载", href: "#download" },
        ],
      },
      {
        title: "资源",
        links: [
          { label: "GitHub", href: GITHUB },
          { label: "发布版本", href: `${GITHUB}/releases` },
        ],
      },
    ],
    localFirst: "本地优先：你的代码与密钥不离开本机。",
    copyright: "© 2026 Cortex Desktop",
  },
  a11y: { primaryNav: "主导航", footerNav: "页脚导航", skipToContent: "跳到主内容" },
};

const en: Dict = {
  meta: {
    title: "Cortex Desktop · One workspace for every coding agent",
    description:
      "A local-first desktop workspace: agent skills stay off by default to save tokens, drag them in only when needed; flash notes catch ideas and let an agent grow them into docs. Claude Code, Codex and Pi in one place.",
    ogAlt: "Cortex Desktop — the local-first agent workspace",
  },
  brand: { name: "Cortex Desktop", tagline: "The local-first agent workspace" },
  nav: { skills: "Skills", notes: "Notes", features: "Features", agents: "Agents", github: "GitHub", download: "Download" },
  links: { github: GITHUB, releases: `${GITHUB}/releases`, webApp: "#" },
  hero: {
    eyebrow: "The local-first agent workspace",
    title: "One workspace for every",
    titleAccent: "coding agent",
    sub: "Cortex Desktop is a local-first desktop workspace where Claude Code, Codex and Pi pick up work on your projects, report back, and wait for your review on every change.",
    primary: "Download for macOS",
    secondary: "Open the web app",
    trust: "Works with Claude · Codex · Pi — and more model channels",
    note: "macOS · auto-updating",
  },
  agents: {
    eyebrow: "Multi-agent",
    title: "One interface, any agent",
    sub: "A unified adapter normalizes every CLI into one streaming protocol — switch agents without switching tools.",
    items: [
      { key: "claude", name: "Claude Code", tag: "Anthropic", desc: "Deep reasoning and bold refactors for your hardest changes." },
      { key: "codex", name: "Codex", tag: "OpenAI", desc: "Fast, context-aware execution for everyday iteration." },
      { key: "pi", name: "Pi", tag: "Open channel", desc: "Bring GLM, Kimi, DeepSeek and more through Pi." },
    ],
    extra: { title: "...or plug in your own model channel", providers: ["GLM", "Kimi", "DeepSeek", "Custom"] },
  },
  skills: {
    eyebrow: "Lean on tokens",
    title: "No bloat by default — drag in what you need",
    sub: "Stop letting unused skills sit in the system prompt. Cortex Desktop keeps the agent's own skills off by default; drag one from your library into the chat only when you need it.",
    points: [
      "Agent skills are off by default, so the system prompt isn't padded with tool definitions you won't use.",
      "Drag a skill from your prompt library into the composer — it applies to this turn only and clears after sending.",
      "Skills, tasks and project files all drop in as references, so every message shows what it carried.",
    ],
    mock: {
      panel: "Prompt library",
      items: ["code-review", "commit-msg", "refactor"],
      hint: "Drag a skill in",
      attach: "code-review",
      toggle: "Agent's own skills",
      toggleState: "Off",
      placeholder: "Describe your task…",
      context: "Context",
      contextNote: "Lean by default",
    },
  },
  notes: {
    eyebrow: "Flash Notes",
    title: "Catch an idea without breaking your flow",
    sub: "An idea pops up mid-session — a single shortcut catches it. It never touches the conversation, and later an agent can grow it into a doc.",
    points: [
      "A global shortcut (⌘⇧N) opens a capture overlay — works even with the main window tucked in the tray.",
      "Notes land in an inbox and the project timeline, never in the current conversation's context.",
      "Pick a note and \"deepen\" it — an agent grows it into a brainstorm or plan document.",
    ],
    mock: {
      shortcut: "⌘⇧N",
      title: "Flash note",
      placeholder: "Jot something down…",
      project: "cortex-work",
      save: "Save",
      stage1: "Inbox",
      stage2: "Deepening",
      stage3: "Deepened",
      output: "brainstorm.md",
      plan: "plan.md",
    },
  },
  features: {
    eyebrow: "Capabilities",
    title: "Built for a full day of agent collaboration",
    sub: "From kickoff to delivery, every step stays in your hands.",
    items: [
      { icon: "workspace", title: "Personal workspace", desc: "A three-pane floating workbench for local projects and parallel sessions." },
      { icon: "timeline", title: "Timeline", desc: "Replay your project's activity — every session and change, tracked." },
      { icon: "review", title: "Diff review", desc: "Every change lands as a diff card — approve or send back in one click." },
      { icon: "automation", title: "Scheduled automation", desc: "Schedule tasks so agents keep working while you're away." },
      { icon: "usage", title: "Usage calendar", desc: "Daily token and task usage — your costs at a glance." },
      { icon: "terminal", title: "Terminal & Git", desc: "Built-in terminal, branches and commits — never leave the workbench." },
    ],
  },
  automation: {
    eyebrow: "Hands-off",
    title: "Off the clock, the workbench stays on",
    auto: {
      title: "Scheduled automation",
      desc: "Hand repetitive work to cron-style tasks: nightly tests, daily issue triage, scheduled reports.",
      bullets: ["Daily, weekly or custom cadence", "Auto-retry and notify on failure", "Results flow back to the timeline"],
    },
    usage: {
      title: "Usage & rhythm",
      desc: "A usage calendar replays daily spend; a timeline threads every project's activity.",
      stat1: { value: "42", label: "tasks this week" },
      stat2: { value: "7", label: "automations run" },
    },
  },
  finalCta: {
    title: "Start your agent rhythm",
    sub: "Download Cortex Desktop and put a few tireless agents to work on your projects.",
    primary: "Download for macOS",
    secondary: "View on GitHub",
    note: "macOS · Local-first · Auto-updating",
  },
  footer: {
    tagline: "One workspace for every coding agent.",
    groups: [
      {
        title: "Product",
        links: [
          { label: "Skills & tokens", href: "#skills" },
          { label: "Flash Notes", href: "#notes" },
          { label: "Features", href: "#features" },
          { label: "Agents", href: "#agents" },
          { label: "Download", href: "#download" },
        ],
      },
      {
        title: "Resources",
        links: [
          { label: "GitHub", href: GITHUB },
          { label: "Releases", href: `${GITHUB}/releases` },
        ],
      },
    ],
    localFirst: "Local-first: your code and keys never leave your machine.",
    copyright: "© 2026 Cortex Desktop",
  },
  a11y: { primaryNav: "Primary", footerNav: "Footer", skipToContent: "Skip to content" },
};

const dicts: Record<Locale, Dict> = { zh, en };

export function getDict(locale: Locale): Dict {
  return dicts[locale];
}
