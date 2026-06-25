// 会话消息里文件 ref → 真实存在的绝对路径解析。chatMarkdown(渲染期点亮链接)与
// PersonalChatArea.handleOpenFile(点击派发)共用同一口径,避免两处漂移。
//
// 核心:可点/可开按「文件真实存在(fileExists)」判定,而非「是否落在项目内(within)」——
// agent 产物常落项目外(codex `~/.codex/generated_images`)或用 `../outputs` 爬出项目,旧的
// resolveProjectFile(仅项目内定位)对这两类一律落空,链接被判死。
//
// 口径:
//  - 绝对路径:直接 fileExists 判定(覆盖项目外)。无探测能力时不放行(无从验证)。
//  - 相对路径:先 resolveProjectFile 项目内定位(支持「只给裸文件名、真实文件在子目录」);
//    落空再 resolveProjectFileRef 拼绝对路径 + fileExists(覆盖 `../outputs` 等爬出项目)。
// 主进程侧 openPath/readFile 的 assertOpenable 仍是真实安全闸门(非真实文件一律拒)。

import { resolveProjectFileRef } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";

// 是否具备存在性探测能力(决定渲染期是否进入「探测中→点亮」流程;无能力 = web/旧壳,乐观放行)。
export function canProbeFile(bridge: DesktopBridge | null): boolean {
  return !!(bridge?.fileExists || bridge?.resolveProjectFile);
}

// 解析为真实存在的绝对路径;找不到 / 不存在 / 无探测能力 → null。
export async function resolveExistingFile(
  bridge: DesktopBridge | null,
  projectPath: string,
  ref: string,
): Promise<string | null> {
  const exists = bridge?.fileExists;
  const probe = bridge?.resolveProjectFile;
  if (ref.startsWith("/")) {
    // 绝对路径:fileExists 不依赖项目根(无项目会话也可验证,如 ~/.codex/generated_images);
    // resolveProjectFile 对绝对 ref 亦按存在性返回该路径(但其 assertAllowed(root) 在空根/项目外会拒,
    // 故仅作补充)。任一命中即放行。
    if (exists && (await exists(ref).catch(() => false))) return ref;
    if (probe) {
      const hit = await probe(projectPath, ref).catch(() => null);
      if (hit) return hit;
    }
    return null;
  }
  if (!projectPath) return null; // 相对路径需项目根
  if (probe) {
    const hit = await probe(projectPath, ref).catch(() => null);
    if (hit) return hit;
  }
  // probe 落空(或无 probe 但有 fileExists):拼绝对路径再按存在性,覆盖 `../outputs` 等爬出项目。
  if (exists) {
    const { abs } = resolveProjectFileRef(projectPath, ref);
    return (await exists(abs).catch(() => false)) ? abs : null;
  }
  return null;
}
