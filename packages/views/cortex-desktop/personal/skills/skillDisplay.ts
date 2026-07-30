// skill 展示辅助:SkillPanel 卡片与 composer slash 菜单共用,避免各写一份(dedup)。

// frontmatter/目录 name(kebab/下划线/空格)→ 展示用标题大小写(如 agent-browser → Agent Browser)。
export function skillTitleCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// skill 来源标签(展示在 slash 菜单右侧):工作区 / 系统(CLI 自带内置,如 codex .system) / 个人(用户目录 + 插件)。
export function skillSourceTag(scope: string, system: boolean): string {
  if (scope === "workspace") return "工作区";
  return system ? "系统" : "个人";
}
