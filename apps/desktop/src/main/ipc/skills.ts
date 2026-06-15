// 内置 skill IPC:渲染端经 bridge.skillGet / skillsList 拉 skill 元数据
//（深化注入 ce-ideate / 生成 plan 注入 ce-plan 用）。main 只返回 frontmatter 源数据 +
// 文件路径,不读全文——全文由 agent 自己 Read（见 core/personal/notes.ts 的注入文案）。

import { ipcMain } from "electron";
import { getSkill, listSkills } from "../skills/registry";
import type { SkillMeta } from "./types";

export function registerSkillsHandlers(): void {
  ipcMain.handle("skills:get", (_e, name: string): Promise<SkillMeta | null> => getSkill(name));
  ipcMain.handle("skills:list", (): Promise<SkillMeta[]> => listSkills());
}
