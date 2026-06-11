// Mock contacts + conversations + file diffs for Cortex Desktop.
// Ported from the design prototype's data.jsx; JSX rich text and syntax-token
// spans are converted to plain data structures so this stays react-dom-free.

import type {
  CodeToken,
  Contact,
  Conversation,
  DiffLine,
  DiffSide,
  FileDiff,
  Group,
  Organization,
  WhoMeta,
} from "../types";

export const ORGS: Organization[] = [
  { id: "dx", name: "dx", initials: "D" },
  { id: "cortex", name: "Cortex", initials: "C" },
  { id: "repair", name: "维修平台", initials: "维" },
];

export const CONTACTS: Contact[] = [
  {
    id: "me",
    name: "我的 Agent",
    group: "pinned",
    avatar: { initials: "我", bg: "#1a1916" },
    agentStatus: "idle",
    statusText: "空闲 · 上次任务 12 分钟前完成",
    last: "已为你整理今日 5 条待办",
    time: "12:04",
    unread: 0,
    pinned: true,
    badgeTag: "my",
  },
  {
    id: "wangyutong",
    name: "王雨桐",
    group: "team",
    role: "前端 · DX 平台",
    avatar: { initials: "WY", bg: "#c96442" },
    agentStatus: "review",
    statusText: "Agent 已产出 3 处变更 · 待你审核",
    last: { kind: "review", text: "ContactList 字段重构 · 待审核" },
    time: "09:18",
    unread: 2,
    mention: true,
  },
  {
    id: "zhanghao",
    name: "张昊",
    group: "team",
    role: "后端 · 维修平台",
    avatar: { initials: "ZH", bg: "#1f6feb" },
    agentStatus: "working",
    statusText: "Agent 正在运行 e2e 测试 (3/7)",
    last: { kind: "working", text: "正在跑 e2e 测试…" },
    time: "09:21",
    unread: 0,
  },
  {
    id: "liqing",
    name: "李清",
    group: "team",
    role: "PM",
    avatar: { initials: "LQ", bg: "#7c3aed" },
    agentStatus: "online",
    statusText: "在线",
    last: "周会纪要已发到 #frontend-core,你瞄一眼",
    time: "08:47",
    unread: 0,
  },
  {
    id: "chenxiaoyang",
    name: "陈晓阳",
    group: "team",
    role: "设计",
    avatar: { initials: "CX", bg: "#0d9488" },
    agentStatus: "idle",
    statusText: "空闲",
    last: "稿子的间距我又调了一版,辛苦你 review",
    time: "昨天",
    unread: 0,
  },
  {
    id: "linxi",
    name: "林溪",
    group: "team",
    role: "前端 · Cortex 桌面",
    avatar: { initials: "LX", bg: "#d97706" },
    agentStatus: "working",
    statusText: "Agent 正在重构 sidebar 组件",
    last: { kind: "working", text: "正在重构 sidebar…" },
    time: "昨天",
    unread: 0,
  },
  {
    id: "liuxingyu",
    name: "刘星宇",
    group: "team",
    role: "QA",
    avatar: { initials: "LY", bg: "#6b3ec7" },
    agentStatus: "offline",
    statusText: "离线 · 最近活跃于昨天 23:14",
    last: "明天回归测试一起约个时间",
    time: "昨天",
    unread: 0,
  },
  {
    id: "zhoumo",
    name: "周墨",
    group: "team",
    role: "运维",
    avatar: { initials: "ZM", bg: "#475569" },
    agentStatus: "online",
    statusText: "在线",
    last: "灰度已切 30%,看一下监控",
    time: "周二",
    unread: 0,
  },
  {
    id: "cortex-proj",
    name: "Cortex 项目 Agent",
    group: "shared",
    role: "团队共享 · 项目知识库",
    avatar: { initials: "CX", bg: "#0f172a" },
    agentStatus: "online",
    statusText: "已索引 1,284 个文档 · 上次同步 3 分钟前",
    last: "已同步本周 12 篇新文档",
    time: "10:30",
    unread: 0,
    badgeTag: "shared",
  },
  {
    id: "repair-agent",
    name: "维修平台 Agent",
    group: "shared",
    role: "团队共享 · 仓库自动化",
    avatar: { initials: "RP", bg: "#16a34a" },
    agentStatus: "working",
    statusText: "Agent 正在打包 v2.14.0",
    last: { kind: "working", text: "正在打包 v2.14.0…" },
    time: "09:02",
    unread: 1,
    badgeTag: "shared",
  },
  {
    id: "ops-agent",
    name: "运维大屏 Agent",
    group: "shared",
    role: "团队共享 · 监控告警",
    avatar: { initials: "OP", bg: "#dc2626" },
    agentStatus: "review",
    statusText: "1 条告警待你确认",
    last: { kind: "review", text: "P2 告警 · 待确认" },
    time: "08:12",
    unread: 1,
    badgeTag: "shared",
  },
  {
    id: "g-frontend",
    name: "#frontend-core",
    group: "groups",
    role: "8 人 · 3 个 Agent",
    avatar: { initials: "#", bg: "#c96442" },
    agentStatus: "online",
    statusText: "活跃中",
    last: "李清:周会纪要已上传,大家看一下",
    time: "08:47",
    unread: 4,
  },
  {
    id: "g-repair",
    name: "#repair-platform",
    group: "groups",
    role: "12 人 · 4 个 Agent",
    avatar: { initials: "#", bg: "#2563eb" },
    agentStatus: "working",
    statusText: "维修平台 Agent 正在工作",
    last: { kind: "mention", text: "@你 帮看下 #4821 的 PR" },
    time: "09:20",
    unread: 1,
    mention: true,
  },
];

export const GROUPS: Group[] = [
  { id: "pinned", label: "置顶" },
  { id: "team", label: "团队成员" },
  { id: "shared", label: "项目 / 共享 Agent" },
  { id: "groups", label: "群聊" },
];

export const CONVOS: Record<string, Conversation> = {
  wangyutong: {
    headerStatus: { dot: "working", text: "Agent 正在工作 · 已运行 2m 14s" },
    metaRow: [
      { k: "项目", v: "cortex-desktop" },
      { k: "分支", v: "feat/contact-list" },
    ],
    messages: [
      { kind: "day", label: "今天 · 09:11" },
      {
        kind: "text",
        who: "wangyutong",
        time: "09:11",
        text: {
          kind: "rich",
          parts: [
            { t: "text", v: "刚到工位,我让 Agent 接手了 " },
            { t: "mention", v: "@你" },
            { t: "text", v: " 昨天提的几点。组里 " },
            { t: "mention", v: "@张昊" },
            { t: "text", v: " 说徽章呼吸效果在 high contrast 下可能有问题,顺手把 reduced-motion 也加上了 👇" },
          ],
        },
      },
      {
        kind: "agentLog",
        who: "wangyutong-agent",
        time: "09:14",
        title: "Agent · 已读取 + 已重构",
        completed: true,
        items: [
          {
            ic: "check",
            text: {
              kind: "rich",
              parts: [
                { t: "text", v: "已检出 " },
                { t: "code", v: "main" },
                { t: "text", v: " · " },
                { t: "code", v: "a3f9c2d" },
                { t: "text", v: ",读取 " },
                { t: "path", v: "ContactList.tsx" },
                { t: "text", v: " / " },
                { t: "path", v: "SidebarShell.tsx" },
              ],
            },
          },
          {
            ic: "check",
            text: {
              kind: "rich",
              parts: [
                { t: "text", v: "识别到 4 个需要补的字段,复用 " },
                { t: "code", v: "SectionGroup" },
                { t: "text", v: " 做分组,徽章走 " },
                { t: "code", v: "AgentBadge" },
              ],
            },
          },
          {
            ic: "check",
            text: {
              kind: "rich",
              parts: [
                { t: "text", v: "已重构 ContactList,补回归测试 " },
                { t: "path", v: "ContactList.test.tsx" },
              ],
            },
          },
        ],
      },
      {
        kind: "diff",
        who: "wangyutong-agent",
        time: "09:15",
        title: "ContactList 字段重构",
        sub: "3 个文件 · +57 / −40 · 待你确认",
        status: "pending",
        files: [
          { path: "desktop/src/sidebar/ContactList.tsx", add: 24, del: 32, active: true },
          { path: "desktop/src/sidebar/AgentBadge.tsx", add: 27, del: 0 },
          { path: "desktop/src/sidebar/types/contact.ts", add: 6, del: 8 },
        ],
      },
      {
        kind: "approve",
        who: "wangyutong-agent",
        time: "09:15",
        title: "等待确认",
        body: {
          kind: "rich",
          parts: [
            { t: "text", v: "需要写入 3 个文件并运行 " },
            { t: "code", v: "pnpm test --filter desktop" },
            { t: "text", v: "。" },
          ],
        },
      },
      { kind: "typing", who: "wangyutong", text: "王雨桐 正在输入…" },
    ],
  },

  me: {
    headerStatus: { dot: "idle", text: "空闲 · 等待你的指令" },
    metaRow: [{ k: "上下文", v: "全部项目" }],
    messages: [
      { kind: "day", label: "今天" },
      { kind: "text", who: "me", time: "12:04", text: "整理一下今天还没动的事项,挑 3 件最紧要的。" },
      {
        kind: "text",
        who: "me-agent",
        time: "12:04",
        text: "好,给你过滤了 12 条未跟进的,挑出 3 件影响他人或带 deadline 的:",
      },
      {
        kind: "agentLog",
        who: "me-agent",
        time: "12:04",
        title: "今日 · 3 件待办",
        completed: true,
        items: [
          {
            ic: "dot",
            text: {
              kind: "rich",
              parts: [
                { t: "text", v: "审核 " },
                { t: "path", v: "王雨桐 · ContactList 重构" },
                { t: "text", v: "(她在等)" },
              ],
            },
          },
          {
            ic: "dot",
            text: {
              kind: "rich",
              parts: [
                { t: "text", v: "回复 " },
                { t: "path", v: "陈晓阳 · 设计稿间距 v3" },
              ],
            },
          },
          {
            ic: "dot",
            text: {
              kind: "rich",
              parts: [
                { t: "text", v: "本周五前提交 " },
                { t: "path", v: "Cortex 桌面 RFC" },
              ],
            },
          },
        ],
      },
    ],
  },

  zhanghao: {
    headerStatus: { dot: "working", text: "Agent 正在跑 e2e 测试 (3/7)" },
    metaRow: [
      { k: "项目", v: "repair-platform" },
      { k: "分支", v: "fix/repair-workbench" },
    ],
    messages: [
      { kind: "day", label: "今天" },
      { kind: "text", who: "me", time: "09:02", text: "RepairWorkbench 首次 loading 那个空引用问题搞定了么?" },
      { kind: "text", who: "zhanghao", time: "09:05", text: "搞了,我 Agent 在跑回归。预计还要 4 分钟。" },
      {
        kind: "agentLog",
        who: "zhanghao-agent",
        time: "09:21",
        title: "Agent · e2e 进行中",
        active: true,
        items: [
          { ic: "check", text: "workbench/measure-height.spec.ts · 通过 ✓" },
          { ic: "check", text: "workbench/scroll-parent.spec.ts · 通过 ✓" },
          { ic: "check", text: "workbench/loading-state.spec.ts · 通过 ✓" },
          { ic: "running", text: "正在跑 workbench/sidebar-resize.spec.ts" },
          { ic: "pending", text: "还剩 3 个 spec 文件" },
        ],
      },
    ],
  },

  liqing: {
    headerStatus: { dot: "online", text: "在线" },
    metaRow: [{ k: "频道", v: "1:1" }],
    messages: [
      { kind: "day", label: "今天" },
      {
        kind: "text",
        who: "liqing",
        time: "08:47",
        text: "周会纪要发到 #frontend-core 了,关键是 Cortex 桌面端联系人面板的优先级被提到本周二,可以么?",
      },
      { kind: "text", who: "me", time: "08:50", text: "可以,王雨桐 Agent 已经在做了。我下午同步进度。" },
    ],
  },

  "g-frontend": {
    headerStatus: { dot: "online", text: "8 人 · 3 个 Agent · 活跃" },
    metaRow: [
      { k: "频道", v: "#frontend-core" },
      { k: "成员", v: "8 人" },
    ],
    messages: [
      { kind: "day", label: "今天" },
      { kind: "text", who: "liqing", time: "08:47", text: "纪要已上,本周二要看到 Cortex 联系人面板 MVP,大家自取 ✊" },
      { kind: "text", who: "zhanghao", time: "08:51", text: "徽章呼吸效果在 high contrast 下我有点担心,谁能帮看看?" },
      { kind: "text", who: "wangyutong", time: "08:53", text: "我 Agent 顺手处理,稍等。" },
    ],
  },
};

// ── Code-diff token helpers ──────────────────────────────────────────────
const kw = (t: string): CodeToken => ({ c: "kw", t });
const str = (t: string): CodeToken => ({ c: "str", t });
const fn = (t: string): CodeToken => ({ c: "fn", t });
const ty = (t: string): CodeToken => ({ c: "type", t });
const tag = (t: string): CodeToken => ({ c: "tag", t });
const attr = (t: string): CodeToken => ({ c: "attr", t });
const com = (t: string): CodeToken => ({ c: "com", t });
const x = (t: string): CodeToken => ({ t });
const line = (num: number, side: DiffSide, ...tokens: CodeToken[]): DiffLine => ({ num, side, tokens });

export const FILE_DIFFS: Record<string, FileDiff> = {
  "desktop/src/sidebar/ContactList.tsx": {
    path: "desktop/src/sidebar/ContactList.tsx",
    crumbs: ["desktop", "src/sidebar", "ContactList.tsx"],
    stat: { add: 24, del: 32 },
    lines: [
      line(1, "ctx", kw("import"), x(" { "), fn("useMemo"), x(" } "), kw("from"), x(" "), str('"react"'), x(";")),
      line(2, "ctx", kw("import"), x(" { "), fn("SectionGroup"), x(", "), fn("Avatar"), x(" } "), kw("from"), x(" "), str('"@cortex/ui"'), x(";")),
      line(3, "add", kw("import"), x(" { "), fn("AgentBadge"), x(" } "), kw("from"), x(" "), str('"./AgentBadge"'), x(";")),
      line(4, "add", kw("import"), x(" "), kw("type"), x(" { "), ty("ContactItem"), x(" } "), kw("from"), x(" "), str('"./types/contact"'), x(";")),
      line(5, "ctx", x(" ")),
      line(6, "del", kw("interface"), x(" "), ty("ContactItem"), x(" {")),
      line(7, "del", x("  id: "), ty("string"), x(";")),
      line(8, "del", x("  name: "), ty("string"), x(";")),
      line(9, "del", x("  lastMessage: "), ty("string"), x(";")),
      line(10, "del", x("}")),
      line(11, "ctx", x(" ")),
      line(12, "ctx", kw("type"), x(" "), ty("Props"), x(" = {")),
      line(13, "ctx", x("  items: "), ty("ContactItem"), x("[];")),
      line(14, "ctx", x("  activeId?: "), ty("string"), x(";")),
      line(15, "add", x("  onSelect: (id: "), ty("string"), x(") => "), ty("void"), x(";")),
      line(16, "ctx", x("};")),
      line(17, "ctx", x(" ")),
      line(18, "ctx", kw("export"), x(" "), kw("function"), x(" "), fn("ContactList"), x("({ items, activeId, onSelect }: Props) {")),
      line(19, "add", x("  "), kw("const"), x(" grouped = "), fn("useMemo"), x("(() => "), fn("groupBy"), x("(items, "), str('"group"'), x("), [items]);")),
      line(20, "ctx", x(" ")),
      line(21, "ctx", x("  "), kw("return"), x(" (")),
      line(22, "del", x("    <"), tag("ul"), x(" "), attr("className"), x("="), str('"contact-list"'), x(">")),
      line(23, "del", x("      {items."), fn("map"), x("((c) => (")),
      line(24, "del", x("        <"), tag("li"), x(" "), attr("key"), x("={c.id}>{c.name}</"), tag("li"), x(">")),
      line(25, "del", x("      ))")),
      line(26, "del", x("    </"), tag("ul"), x(">")),
      line(27, "add", x("    <"), tag("div"), x(" "), attr("className"), x("="), str('"contact-list"'), x(">")),
      line(28, "add", x("      {"), fn("Object"), x("."), fn("entries"), x("(grouped)."), fn("map"), x("(([group, rows]) => (")),
      line(29, "add", x("        <"), fn("SectionGroup"), x(" "), attr("key"), x("={group} "), attr("label"), x("={"), fn("labelOf"), x("(group)}>")),
      line(30, "add", x("          {rows."), fn("map"), x("((c) => (")),
      line(31, "add", x("            <"), fn("ContactRow")),
      line(32, "add", x("              "), attr("key"), x("={c.id}")),
      line(33, "add", x("              "), attr("item"), x("={c}")),
      line(34, "add", x("              "), attr("active"), x("={c.id === activeId}")),
      line(35, "add", x("              "), attr("onClick"), x("={onSelect}")),
      line(36, "add", x("            />")),
      line(37, "add", x("          ))")),
      line(38, "add", x("        </"), fn("SectionGroup"), x(">")),
      line(39, "add", x("      ))")),
      line(40, "add", x("    </"), tag("div"), x(">")),
      line(41, "ctx", x("  });")),
      line(42, "ctx", x("}")),
      line(43, "ctx", x(" ")),
      line(44, "hunk", x("@@ ContactRow · 字段补齐 @@")),
      line(45, "ctx", kw("function"), x(" "), fn("ContactRow"), x("({ item, active, onClick }: RowProps) {")),
      line(46, "ctx", x("  "), kw("return"), x(" (")),
      line(47, "ctx", x("    <"), tag("button"), x(" "), attr("data-active"), x("={active} "), attr("onClick"), x("={() => onClick(item.id)}>")),
      line(48, "add", x("      <"), fn("Avatar"), x(" "), attr("src"), x("={item.avatar}>")),
      line(49, "add", x("        <"), fn("AgentBadge"), x(" "), attr("status"), x("={item.agentStatus} />")),
      line(50, "add", x("      </"), fn("Avatar"), x(">")),
      line(51, "add", x("      <"), tag("div"), x(" "), attr("className"), x("="), str('"meta"'), x(">")),
      line(52, "add", x("        <"), fn("Row"), x(" "), attr("name"), x("={item.name} "), attr("time"), x("={item.time} />")),
      line(53, "add", x("        <"), fn("LastMessage"), x(" "), attr("value"), x("={item.lastMessage} "), attr("unread"), x("={item.unread} />")),
      line(54, "add", x("      </"), tag("div"), x(">")),
      line(55, "ctx", x("    </"), tag("button"), x(">")),
      line(56, "ctx", x("  });")),
      line(57, "ctx", x("}")),
    ],
  },

  "desktop/src/sidebar/AgentBadge.tsx": {
    path: "desktop/src/sidebar/AgentBadge.tsx",
    crumbs: ["desktop", "src/sidebar", "AgentBadge.tsx"],
    stat: { add: 27, del: 0 },
    lines: [
      line(1, "add", kw("import"), x(" { "), fn("cn"), x(" } "), kw("from"), x(" "), str('"@cortex/utils"'), x(";")),
      line(2, "add", x(" ")),
      line(3, "add", kw("type"), x(" "), ty("Status"), x(" = "), str('"idle"'), x(" | "), str('"working"'), x(" | "), str('"review"'), x(" | "), str('"online"'), x(" | "), str('"offline"'), x(";")),
      line(4, "add", x(" ")),
      line(5, "add", kw("interface"), x(" "), ty("Props"), x(" { status: "), ty("Status"), x("; pulse?: "), ty("boolean"), x("; }")),
      line(6, "add", x(" ")),
      line(7, "add", kw("export"), x(" "), kw("function"), x(" "), fn("AgentBadge"), x("({ status, pulse = true }: "), ty("Props"), x(") {")),
      line(8, "add", x("  "), com("// Respect prefers-reduced-motion · no pulse if reduced")),
      line(9, "add", x("  "), kw("const"), x(" reduceMotion = "), fn("useReducedMotion"), x("();")),
      line(10, "add", x("  "), kw("return"), x(" (")),
      line(11, "add", x("    <"), tag("span")),
      line(12, "add", x("      "), attr("data-status"), x("={status}")),
      line(13, "add", x("      "), attr("className"), x("={"), fn("cn"), x("("), str('"agent-badge"'), x(", pulse && !reduceMotion && "), str('"pulse"'), x(")}")),
      line(14, "add", x("    />")),
      line(15, "add", x("  );")),
      line(16, "add", x("}")),
    ],
  },

  "desktop/src/sidebar/types/contact.ts": {
    path: "desktop/src/sidebar/types/contact.ts",
    crumbs: ["desktop", "src/sidebar/types", "contact.ts"],
    stat: { add: 6, del: 8 },
    lines: [
      line(1, "del", kw("export"), x(" "), kw("interface"), x(" "), ty("ContactItem"), x(" {")),
      line(2, "del", x("  id: "), ty("string"), x(";")),
      line(3, "del", x("  name: "), ty("string"), x(";")),
      line(4, "del", x("  lastMessage: "), ty("string"), x(";")),
      line(5, "del", x("}")),
      line(6, "ctx", x(" ")),
      line(7, "add", kw("export"), x(" "), kw("type"), x(" "), ty("AgentStatus"), x(" = "), str('"idle"'), x(" | "), str('"working"'), x(" | "), str('"review"'), x(" | "), str('"online"'), x(" | "), str('"offline"'), x(";")),
      line(8, "add", x(" ")),
      line(9, "add", kw("export"), x(" "), kw("interface"), x(" "), ty("ContactItem"), x(" {")),
      line(10, "add", x("  id: "), ty("string"), x("; name: "), ty("string"), x("; avatar: "), ty("Avatar"), x(";")),
      line(11, "add", x("  lastMessage: "), ty("LastMessage"), x("; agentStatus: "), ty("AgentStatus"), x(";")),
      line(12, "add", x("  unread?: "), ty("number"), x("; mentionsYou?: "), ty("boolean"), x(";")),
      line(13, "add", x("}")),
    ],
  },
};

// ── Lookups ──────────────────────────────────────────────────────────────
export function findContact(id: string): Contact | undefined {
  return CONTACTS.find((c) => c.id === id);
}

// Resolve a message author id ("wangyutong", "wangyutong-agent", "me-agent")
// to display metadata.
export function whoMeta(who: string): WhoMeta {
  if (who === "me") return { name: "我", avatar: { initials: "我", bg: "#1a1916" }, agent: null, isMe: true };
  // 个人工作区的 CLI agent 作者。
  if (who === "claude") return { name: "Claude Code", avatar: { initials: "CC", bg: "#c96442" }, agent: "agent" };
  if (who === "codex") return { name: "Codex", avatar: { initials: "CX", bg: "#1a1916" }, agent: "agent" };
  if (who === "me-agent") return { name: "我的 Agent", avatar: { initials: "我", bg: "#1a1916" }, agent: "mine", isMe: true };
  const base = who.replace(/-agent$/, "");
  const c = findContact(base);
  if (!c) return { name: who, avatar: { initials: "?", bg: "#94918a" }, agent: null };
  const isAgent = who.endsWith("-agent");
  return {
    name: c.name,
    avatar: c.avatar,
    agent: isAgent ? (c.group === "shared" ? "shared" : "agent") : null,
  };
}
