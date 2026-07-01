// pi 已启用 skills 的渲染端数据源(U3):供输入框 slash 菜单展示 /skill:<name>。
//
// 与注入链路 resolveEnabledSkillPaths(messages.ts)同源同规则:同一份 piSkillsList 扫描结果,
// 同样的「禁用 / 工作区未授信」过滤、同样的「按 name 去重(全局覆盖工作区)」、同样的
// useOwnSkills 会话级门控——保证「菜单可见」与「实际注入」严格一致,不出现「能选却没用」。
//
// query key 仿 notes.ts:桌面端无真实 wsId(useWorkspaceId 返回占位值),按 projectPath + 扫描根
// 命名,绝不用 wsId(否则同桌面所有项目串到同一 key)。禁用 / 去重在 fetch 后客户端做,故
// disabledSkills / trust 改动即时反映、无需重扫(piSkillsList 只随扫描根 / 工作区目录变化)。

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_PI_SKILLS, type AgentKind, type PiSkillSettings, type PluginSkill, type SessionMeta } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";

/** slash 菜单展示用的已启用 skill 元数据(取自 PluginSkill)。 */
export type PiSlashSkill = { name: string; description: string; argumentHint?: string };

/**
 * 纯函数:把 piSkillsList 扫描结果过滤为「已启用」展示集。规则与 resolveEnabledSkillPaths 完全一致——
 * 唯一事实来源在 messages.ts,这里复刻规则(勿各自漂移)。core 约定只对纯函数做单测,故抽出此函数。
 */
export function filterEnabledPiSkills(skills: PluginSkill[], cfg: PiSkillSettings, agent?: AgentKind): PiSlashSkill[] {
  const disabled = new Set(cfg.disabledSkills);
  const trusted = new Set(cfg.trustedWorkspaceSkillDirs);
  const enabled = skills.filter((s) => {
    if (disabled.has(`${s.scope}:${s.name}`)) return false; // 已禁用
    if (s.scope === "workspace" && !trusted.has(s.dir)) return false; // 工作区未授信不注入
    // 按 supportedAgents 过滤,与注入侧 resolveEnabledSkillRecords 完全一致:claude/codex 菜单不出现
    // 不适用的 skill,否则选中后发送侧转不出定向 prompt、变成「看着能选其实没用」。缺省=全 agent。
    if (agent && s.supportedAgents && !s.supportedAgents.includes(agent)) return false;
    return true;
  });
  // name 去重:先放工作区、后放全局覆盖 → 同名时全局胜出(防恶意工作区同名劫持)。
  const byName = new Map<string, PluginSkill>();
  for (const s of enabled) if (s.scope === "workspace") byName.set(s.name, s);
  for (const s of enabled) if (s.scope === "global") byName.set(s.name, s);
  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint }));
}

/**
 * 已启用 pi skills(供 slash 菜单)。hook 恒被调用,门控走 useQuery.enabled + 返回值:
 *  - 非 pi 会话 / 会话级关 skills(useOwnSkills===false)/ 无桥(web、旧壳)→ 返回 []。
 *  - 否则扫描 + 客户端过滤去重。
 */
export function usePiEnabledSkills(session: SessionMeta | undefined): PiSlashSkill[] {
  const bridge = useDesktopBridge();
  const piSkills = usePersonalStore((s) => s.generalSettings.piSkills);
  // 活动会话的工作区目录(projectId → project.path);无项目会话 → undefined(只扫全局根)。
  const projectPath = usePersonalStore((s) =>
    session?.projectId ? s.projects.find((p) => p.id === session.projectId)?.path : undefined,
  );

  const cfg = useMemo<PiSkillSettings>(() => ({ ...DEFAULT_PI_SKILLS, ...piSkills }), [piSkills]);

  // pi/claude/codex 会话 + 未会话级关 skills + 有 piSkillsList 才扫。claude/codex 无原生 /skill 展开,
  // 发送侧把 /skill:name 转定向 prompt(见 PersonalChatArea onSend + renderSkillInvocation),故菜单同样放行。
  const gateOpen =
    (session?.agent === "pi" || session?.agent === "claude" || session?.agent === "codex") &&
    session?.useOwnSkills !== false &&
    !!bridge?.piSkillsList;

  const { data } = useQuery<PluginSkill[]>({
    queryKey: [
      "pi-enabled-skills",
      projectPath ?? "",
      cfg.globalRoots.join("|"),
      cfg.userGlobalRoots.join("|"),
      cfg.workspaceEnabled,
    ],
    enabled: gateOpen,
    queryFn: () =>
      bridge!.piSkillsList!({
        globalRoots: cfg.globalRoots,
        userGlobalRoots: cfg.userGlobalRoots,
        workspaceEnabled: cfg.workspaceEnabled,
        workspaceDir: projectPath,
      }),
    staleTime: Infinity,
    refetchOnWindowFocus: true, // 兜底:窗口重获焦点时重扫(skill 目录可能在外部增删)
  });

  return useMemo(
    () => (gateOpen ? filterEnabledPiSkills(data ?? [], cfg, session?.agent) : []),
    [gateOpen, data, cfg, session?.agent],
  );
}
