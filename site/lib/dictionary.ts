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
  nav: { skills: string; accounting: string; notes: string; terminal: string; features: string; agents: string; github: string; download: string };
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
  /** Hero 交互式演示:拖/选 skill → 输入 → 模拟输出(client） */
  heroDemo: {
    drag: string;
    send: string;
    hint: string;
    tryLabel: string;
    thinking: string;
    skills: { key: "review" | "ledger"; name: string; placeholder: string; example: string }[];
    reviewLines: string[];
    ledger: {
      cols: string[];
      account: string;
      date: string;
      done: string;
      cats: { match: string[]; label: string }[];
      fallback: string;
    };
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
  /** 会计录入 · 拖入的自定义 skill 示例（showcase，id="accounting"） */
  accounting: {
    eyebrow: string;
    title: string;
    sub: string;
    points: string[];
    mock: {
      skill: string;
      placeholder: string;
      send: string;
      cols: string[];
      rows: { date: string; cat: string; amount: string; account: string }[];
      done: string;
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
  /** 终端 · 文件/代码点击即引用进 Agent 输入框(showcase，id="terminal"，client） */
  terminal: {
    eyebrow: string;
    title: string;
    sub: string;
    points: string[];
    mock: {
      agents: { key: "claude" | "codex"; name: string }[];
      files: { name: string; lines: string[] }[];
      insertFile: string;
      placeholder: string;
      empty: string;
      send: string;
      sent: string;
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

// 发布与源码统一指向公开的 release 仓库（下载、发布版本、查看 GitHub 全部跟随）。
const GITHUB = "https://github.com/rambocode/cortex-work-release";

const zh: Dict = {
  meta: {
    title: "Cortex Desktop · 把所有编码 Agent 请进同一个工作区",
    description:
      "本地优先的桌面工作台：默认不加载 agent 自带 skill 省 token，按需拖曳注入；闪记随手接住灵感，再让 agent 孵化成文档。Claude Code、Codex、Pi 一处协作。",
    ogAlt: "Cortex Desktop — 本地优先的 Agent 工作台",
  },
  brand: { name: "Cortex Desktop", tagline: "本地优先的 Agent 工作台" },
  nav: { skills: "Skills", accounting: "记账", notes: "闪记", terminal: "终端", features: "功能", agents: "Agent", github: "GitHub", download: "下载" },
  links: { github: GITHUB, releases: `${GITHUB}/releases`, webApp: "#" },
  hero: {
    eyebrow: "本地优先的 Agent 工作台",
    title: "写代码、记一笔账，",
    titleAccent: "拖个 skill 就上手",
    sub: "本地优先的桌面工作台：默认不膨胀，需要哪个 skill 就拖哪个进来，这一轮照它干。写代码、记灵感、记一笔账，都是同一套动作。",
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
  heroDemo: {
    drag: "拖一个 skill 进来,或点一下切换",
    send: "运行",
    hint: "Enter 运行 · Shift+Enter 换行",
    tryLabel: "试试:",
    thinking: "Agent 正在处理…",
    skills: [
      {
        key: "review",
        name: "code-review",
        placeholder: "贴段代码,或说要审什么…",
        example: "审一下登录函数:user 可能为 null 吗?",
      },
      {
        key: "ledger",
        name: "会计录入",
        placeholder: "记一笔账…(午饭 25,打车 38)",
        example: "午饭 25,打车 38,买咖啡 19",
      },
    ],
    reviewLines: [
      "读完了,结构清晰。两点建议:",
      "• 取 user.id 前先判空,避免空指针。",
      "• 异常别吞掉,至少记一条日志。",
      "其余没问题,可以合。",
    ],
    ledger: {
      cols: ["日期", "分类", "金额", "账户"],
      account: "现金",
      date: "06-18",
      done: "已记账",
      cats: [
        { match: ["饭", "餐", "午", "晚", "早", "咖啡", "奶茶", "吃", "外卖"], label: "餐饮" },
        { match: ["车", "打车", "地铁", "公交", "油", "停车", "高铁"], label: "交通" },
        { match: ["买", "购", "衣", "超市", "话费"], label: "购物" },
      ],
      fallback: "其他",
    },
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
  accounting: {
    eyebrow: "拖入即用 · 不止编码",
    title: "拖个会计 skill，输入框就成了账本",
    sub: "同一个输入框，拖进你自己的「会计录入」skill，用大白话记一笔，Agent 把它拆成结构化条目——这一轮专心记账，不必新开工具。",
    points: [
      "自然语言一句拆多条：「午饭 25，打车 38」自动分成两笔。",
      "拖入的是你自己的 skill，只这一轮生效、发完即清，不常驻上下文。",
      "产出结构化条目（日期 / 分类 / 金额 / 账户），可导出对账。",
    ],
    mock: {
      skill: "会计录入",
      placeholder: "记一笔账…（午饭 25，打车 38）",
      send: "记一笔",
      cols: ["日期", "分类", "金额", "账户"],
      rows: [
        { date: "06-18", cat: "餐饮", amount: "¥25", account: "现金" },
        { date: "06-18", cat: "交通", amount: "¥38", account: "现金" },
      ],
      done: "已记账",
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
  terminal: {
    eyebrow: "终端 · 点击即引用",
    title: "看到哪行有问题,点一下就丢给 Agent",
    sub: "内置终端与文件预览,代码、diff 一眼可见。可疑的文件或某一行,点一下直接插进 Claude Code 或 Codex 的输入框——带着精确上下文,快速处理。",
    points: [
      "终端、文件、diff 都在工作台里,不用切出去翻。",
      "点文件名或某一行,引用就落进 Claude Code / Codex 的输入框。",
      "带着精确的文件/行号发问,Agent 少猜、改得准。",
    ],
    mock: {
      agents: [
        { key: "claude", name: "Claude Code" },
        { key: "codex", name: "Codex" },
      ],
      files: [
        {
          name: "auth.ts",
          lines: [
            "export function getUser(req) {",
            "  const token = req.headers.token",
            "  return db.users.find(token)",
            "}  // token 为空时会抛错",
          ],
        },
        {
          name: "payment.ts",
          lines: [
            "async function charge(order) {",
            "  const r = await api.pay(order)",
            "  return r.ok",
            "}  // 失败没有重试",
          ],
        },
      ],
      insertFile: "插入整个文件",
      placeholder: "描述要处理的问题…",
      empty: "点左侧文件或某一行,引用会出现在这里",
      send: "交给 Agent",
      sent: "已交给",
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
          { label: "会计录入", href: "#accounting" },
          { label: "闪记", href: "#notes" },
          { label: "终端", href: "#terminal" },
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
  nav: { skills: "Skills", accounting: "Ledger", notes: "Notes", terminal: "Terminal", features: "Features", agents: "Agents", github: "GitHub", download: "Download" },
  links: { github: GITHUB, releases: `${GITHUB}/releases`, webApp: "#" },
  hero: {
    eyebrow: "The local-first agent workspace",
    title: "Write code, log an expense —",
    titleAccent: "just drag in a skill",
    sub: "A local-first desktop workspace. Context stays lean by default; drag in the skill you need and this turn runs on it. Coding, notes, bookkeeping — one gesture.",
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
  heroDemo: {
    drag: "Drag a skill in, or tap to switch",
    send: "Run",
    hint: "Enter to run · Shift+Enter for newline",
    tryLabel: "Try:",
    thinking: "Agent is working…",
    skills: [
      {
        key: "review",
        name: "code-review",
        placeholder: "Paste code, or say what to review…",
        example: "Review the login fn — can user be null?",
      },
      {
        key: "ledger",
        name: "bookkeeping",
        placeholder: "Log an expense… (lunch 25, cab 38)",
        example: "lunch 25, cab 38, coffee 19",
      },
    ],
    reviewLines: [
      "Read it through — structure's clean. Two notes:",
      "• Guard user before reading .id to avoid a null deref.",
      "• Don't swallow the error; at least log it.",
      "Otherwise good to merge.",
    ],
    ledger: {
      cols: ["Date", "Category", "Amount", "Account"],
      account: "Cash",
      date: "06-18",
      done: "Logged",
      cats: [
        { match: ["lunch", "dinner", "breakfast", "coffee", "tea", "food", "meal", "eat", "snack"], label: "Dining" },
        { match: ["cab", "taxi", "bus", "metro", "subway", "gas", "fuel", "parking", "train", "car"], label: "Transit" },
        { match: ["buy", "shop", "store", "grocery", "clothes", "phone"], label: "Shopping" },
      ],
      fallback: "Other",
    },
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
  accounting: {
    eyebrow: "Drag-in, not just code",
    title: "Drop in a bookkeeping skill — the composer becomes a ledger",
    sub: "Same composer: drag in your own \"bookkeeping\" skill, jot a line in plain words, and the agent splits it into structured entries — this turn stays on the books, no new tool needed.",
    points: [
      "Plain language, multiple lines: \"lunch 25, cab 38\" splits into two entries.",
      "It's your own skill, applied to this turn only — it clears after sending, never sits in context.",
      "Structured entries (date / category / amount / account) you can export to reconcile.",
    ],
    mock: {
      skill: "bookkeeping",
      placeholder: "Log an expense… (lunch 25, cab 38)",
      send: "Log it",
      cols: ["Date", "Category", "Amount", "Account"],
      rows: [
        { date: "06-18", cat: "Dining", amount: "$25", account: "Cash" },
        { date: "06-18", cat: "Transit", amount: "$38", account: "Cash" },
      ],
      done: "Logged",
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
  terminal: {
    eyebrow: "Terminal · click to reference",
    title: "See the bad line, click to hand it to the agent",
    sub: "A built-in terminal and file preview keep code and diffs in view. Click a suspect file or line to drop it straight into the Claude Code or Codex composer — exact context, handled fast.",
    points: [
      "Terminal, files and diffs live in the workbench — no switching out.",
      "Click a filename or a single line — it lands in the Claude Code / Codex composer.",
      "Ask with exact file/line context, so the agent guesses less and edits right.",
    ],
    mock: {
      agents: [
        { key: "claude", name: "Claude Code" },
        { key: "codex", name: "Codex" },
      ],
      files: [
        {
          name: "auth.ts",
          lines: [
            "export function getUser(req) {",
            "  const token = req.headers.token",
            "  return db.users.find(token)",
            "}  // throws when token is empty",
          ],
        },
        {
          name: "payment.ts",
          lines: [
            "async function charge(order) {",
            "  const r = await api.pay(order)",
            "  return r.ok",
            "}  // no retry on failure",
          ],
        },
      ],
      insertFile: "Insert whole file",
      placeholder: "Describe what to handle…",
      empty: "Click a file or a line — references show up here",
      send: "Hand to agent",
      sent: "Sent to",
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
          { label: "Ledger entry", href: "#accounting" },
          { label: "Flash Notes", href: "#notes" },
          { label: "Terminal", href: "#terminal" },
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
