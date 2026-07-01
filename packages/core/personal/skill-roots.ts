// per-agent skill 扫描根解析(Design B,plan 002 U2)。给定 Skill 配置 + 会话 agent + 项目路径,
// 产出该 agent 应扫的**带 scope + origin 的根规格**。下拉(piSkills.ts)与注入(skill-injection.ts)
// 共用此单一实现,避免两处各写一份根选择逻辑再漂移(复刻 skill-injection.ts「唯一实现」惯例)。
//
// 为什么按 agent 分根:claude/codex/pi 各有自己的原生 skill 目录,用户预期「切 agent 看到自己的
// skill」。本函数据 cfg.agentRoots[agent](私有原生根)+ cfg.sharedRoots(共享,对三端都扫)组装。
//
// 纯函数、不读盘、不展开 ~、不做 OS path join:
//   · global scope 根:含 ~ 的绝对根,由主进程 expandTilde;
//   · workspace scope 根:相对项目根的子目录(如 ".claude/skills"),由主进程 join(workspaceDir, path)。
// 这与主进程 locate.ts pluginSkillRoots 现有「global 展开 ~ / workspace 拼 workspaceDir」的分工一致。

import type { AgentKind, PiSkillSettings, SkillScope } from "../desktop/types";

// origin 区分「共享根」与「该 agent 私有原生根」——供 U6 去重:当 skill 来自 agent 自己的原生根时,
// agent(pi/claude)会自行原生发现,Cortex 不再重复 --skill/桥接注入,避免 name collision。
export type SkillRootOrigin = "shared" | "agent";

export interface AgentSkillRoot {
  // global scope:含 ~ 的绝对根;workspace scope:相对项目根的子目录。
  path: string;
  scope: SkillScope;
  origin: SkillRootOrigin;
}

// 每 agent 的工作区级私有子目录(相对项目根)。与 DEFAULT_AGENT_SKILL_ROOTS 的全局原生根对应:
//   claude → .claude/skills;codex → .codex/skills;pi → .pi/skills。
// .agents/skills(项目级 Agent Skills 标准目录)与全局 ~/.agents/skills 一样三端共享,见 SHARED_WORKSPACE_SUBDIRS。
const AGENT_WORKSPACE_SUBDIRS: Record<AgentKind, string[]> = {
  claude: [".claude/skills"],
  codex: [".codex/skills"],
  pi: [".pi/skills"],
};

// 共享工作区子目录(对三端生效):Cortex 自有 .cortex-desktop/skills + .agents/skills(跨 agent 标准)。
const SHARED_WORKSPACE_SUBDIRS = [".cortex-desktop/skills", ".agents/skills"];

// 解析某 agent 的扫描根规格。projectPath 缺省 / workspaceEnabled=false → 不产出任何 workspace scope 根。
// agent 缺省(理论上的无 agent 调用点)→ 只产出共享根,不产出任何 agent 私有根(防串场)。
export function resolveAgentSkillRoots(
  cfg: PiSkillSettings,
  agent?: AgentKind,
  projectPath?: string,
): AgentSkillRoot[] {
  const roots: AgentSkillRoot[] = [];

  // 全局根:共享(shared)在前、agent 私有(agent)在后。scope 均为 global(主进程 expandTilde)。
  for (const path of cfg.sharedRoots) roots.push({ path, scope: "global", origin: "shared" });
  if (agent) for (const path of cfg.agentRoots[agent] ?? []) roots.push({ path, scope: "global", origin: "agent" });

  // 工作区根:仅在开启且有项目时产出。相对子目录,主进程 join(workspaceDir, path)。
  if (cfg.workspaceEnabled && projectPath) {
    for (const sub of SHARED_WORKSPACE_SUBDIRS) roots.push({ path: sub, scope: "workspace", origin: "shared" });
    if (agent) for (const sub of AGENT_WORKSPACE_SUBDIRS[agent] ?? []) {
      roots.push({ path: sub, scope: "workspace", origin: "agent" });
    }
  }

  return roots;
}
