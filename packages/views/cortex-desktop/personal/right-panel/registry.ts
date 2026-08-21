// 右栏面板集中静态注册表——「全 app 有哪些右栏面板」的唯一清单。
// 新增面板 = 在面板目录写一个 descriptor(+ 懒加载 wrapper) + 这里加一行 import;
// 不再需要动 core、宿主渲染链、标题/宽度/放大白名单或 rail 数组（2026-08-21 重构共识）。
// 刻意选集中显式 import 而非「模块自注册副作用」:副作用注册谁没被 import 谁就静默消失,
// 且可能被 tree-shaking 摇掉——与 0.1.63「两份注册表死角」是同类故障形态。

import type { RightPanelDescriptor } from "./types";
import type { PanelPayloadMap } from "./types";
import { filesPanel } from "../files/descriptor";
import { skillsPanel } from "../skills/descriptor";
import { todosPanel } from "../tasks/descriptor";
import { notesPanel } from "../notes/descriptor";
import { browserPanel } from "../browser/descriptor";
import { canvasPanel } from "../layout/canvas-descriptor";
import { subagentsPanel } from "../subagents/descriptor";
import { artifactPanel } from "../../design/artifact-descriptor";
import { researchPanel } from "../../research/descriptor";
import { knowledgePanel } from "../knowledge/descriptor";
import { piArtifactsPanel } from "../chat/artifacts/descriptor";

export const RIGHT_PANELS = [
  filesPanel,
  skillsPanel,
  todosPanel,
  notesPanel,
  browserPanel,
  canvasPanel,
  subagentsPanel,
  artifactPanel,
  researchPanel,
  knowledgePanel,
  piArtifactsPanel,
] as const;

/** 合法面板 id 联合（从注册表派生;core 的 rightView 是 string 通道,类型安全在 views 层）。 */
export type KnownPanelId = (typeof RIGHT_PANELS)[number]["id"];

/** 宽化视图:遍历/过滤用——精确字面量联合上取可选字段(rail/icon)会报 TS2339。 */
export const ALL_PANELS: readonly RightPanelDescriptor[] = RIGHT_PANELS;

// 编译期约束:PanelPayloadMap 的键必须都是注册过的面板 id（防载荷映射挂到不存在的面板上）。
type _PayloadKeysAreKnown = keyof PanelPayloadMap extends KnownPanelId ? true : never;
const _payloadKeysAreKnown: _PayloadKeysAreKnown = true;
void _payloadKeysAreKnown;

const PANEL_BY_ID: ReadonlyMap<string, RightPanelDescriptor> = new Map(
  ALL_PANELS.map((panel) => [panel.id, panel]),
);

/**
 * 按 id 取 descriptor;未知 id 回退 files——rightView 是不持久化的 string 通道,
 * 兜底只需覆盖运行时脏值（如未来已卸载的动态面板 id）,不能让宿主渲染崩掉。
 */
export function resolvePanel(id: string): RightPanelDescriptor {
  return PANEL_BY_ID.get(id) ?? PANEL_BY_ID.get("files")!;
}

/** rail 常驻入口清单（按 rail.order 升序;替代原 PersonalRightRail 的 ITEMS 数组）。 */
export function railItems(): RightPanelDescriptor[] {
  return ALL_PANELS.filter((panel) => panel.rail).sort(
    (a, b) => (a.rail?.order ?? 0) - (b.rail?.order ?? 0),
  );
}
