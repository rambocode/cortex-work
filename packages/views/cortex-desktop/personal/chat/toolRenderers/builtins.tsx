// 内置工具渲染器注册入口。PersonalWorkspace 模块顶层调用一次(模块加载即注册,Map 引用稳定)。

import { ARTIFACTS_TOOL_NAME } from "@cortex-work/core/desktop/types";

import { ArtifactStepCard } from "./ArtifactStepCard";
import { registerToolRenderer } from "./registry";

let registered = false;

/** 幂等注册全部内置渲染器。 */
export function registerBuiltinToolRenderers(): void {
  if (registered) return;
  registered = true;
  registerToolRenderer(ARTIFACTS_TOOL_NAME, ArtifactStepCard);
}
