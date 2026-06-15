// 第二阶段:初始化时下载官方 skill 库。当前为「未接线桩」——仅定义契约与落地路径,
// 不在任何启动流程中调用。蓝本为 server/internal/handler/skill.go 的 skill importer。
//
// 接入路径（第二阶段实现时）:
//   1. main/index.ts 在 app.whenReady 后（或首次启动检测）调用 downloadOfficialSkills()。
//   2. 新增 ipc "skills:download" handler 供设置页手动触发 / 重新拉取。
//   3. 落地到 userSkillsRoot()/<name>/{SKILL.md, references/...},registry 双源去重时
//      userData 优先覆盖内置（见 locate.skillsRoots / registry.listSkills）——无需改 registry。
//
// 实现要点（对齐 server importer, server/internal/handler/skill.go）:
//   - 多源:clawhub.ai / skills.sh / github.com（detectImportSource）。
//   - 配额:单文件 1 MiB、bundle 8 MiB、最多 128 文件;超限中止不静默丢弃。
//   - 二进制按扩展名跳过（isLikelyBinaryFilePath）。
//   - 路径安全:拒绝绝对路径 / `..` / 空（validateFilePath）。
//   - frontmatter 解析复用 registry.parseFrontmatter（已含 argument-hint）。

import { userSkillsRoot } from "./locate";

// 官方 skill 库源（第二阶段填真实地址）。
export interface OfficialSkillSource {
  name: string;
  url: string; // clawhub / skills.sh / github
}

// 第二阶段:把 sources 下载落地到 userSkillsRoot()。当前未实现。
export async function downloadOfficialSkills(sources: OfficialSkillSource[]): Promise<void> {
  void sources;
  void userSkillsRoot(); // 落地根 = userData/skills（registry 双源去重时优先覆盖内置）
  throw new Error("downloadOfficialSkills: 第二阶段实现（见本文件顶部接入路径与要点）");
}
