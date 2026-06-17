// pi 扩展市场编排（U5）:把 U4 的 install/list/remove IPC 与 store 的启用集/信任/溯源串成完整状态机。
// 与 SkillPanel 一致走「手动 bridge 加载 + store 叠加」(非 React Query),由 U6 面板调用。
// C3 双源对账:存在性以 pi list（bridge.piExtList）为准,store.installed 有但 pi list 无 = missing（标失踪,
// 不删启用记录）。装≠启用:启用集/信任是 store 的 opt-in allowlist。C2:卸载在用扩展先自动禁用再 remove。

import type { DesktopBridge } from "../desktop/bridge";
import type { InstalledExtension, InstalledExtensionRecord, PiExtInstallResult, SkillScope } from "../desktop/types";
import { DEFAULT_PI_EXTENSIONS } from "../desktop/types";
import { usePersonalStore } from "../store/personal";

// 纯函数:把 store 溯源记录 + pi list 当前路径 + 启用/信任集 叠加为渲染端富项。
// missing = 记录的 path 不在 pi list（外部删除/损坏）→ 标失踪但保留启用/溯源记录（C3）。
// 排序:启用优先,再按 installedAt 倒序（新装在前）。
export function decorateExtensions(
  records: InstalledExtensionRecord[],
  presentPaths: string[],
  enabled: string[],
  trusted: string[],
): InstalledExtension[] {
  const present = new Set(presentPaths);
  const en = new Set(enabled);
  const tr = new Set(trusted);
  return records
    .map((r): InstalledExtension => {
      const key = `${r.scope}:${r.ref}`;
      const missing = !present.has(r.path);
      return {
        ref: r.ref,
        path: missing ? undefined : r.path,
        scope: r.scope,
        sourceRef: r.sourceRef,
        origin: r.origin,
        version: r.version,
        installedAt: r.installedAt,
        enabled: en.has(key),
        trusted: tr.has(key),
        missing,
      };
    })
    .sort((a, b) => (a.enabled === b.enabled ? b.installedAt - a.installedAt : a.enabled ? -1 : 1));
}

// 拉取已装扩展富列表（bridge 缺失 → []，与 SkillPanel 降级一致）。
export async function listExtensions(bridge: DesktopBridge): Promise<InstalledExtension[]> {
  if (!bridge.piExtList) return [];
  let paths: string[];
  try {
    paths = await bridge.piExtList();
  } catch {
    return [];
  }
  const cfg = { ...DEFAULT_PI_EXTENSIONS, ...usePersonalStore.getState().generalSettings.piExtensions };
  return decorateExtensions(cfg.installed, paths, cfg.enabled, cfg.trusted);
}

// 安装:经 bridge 下载,成功则把溯源(含解析到的 path)写入 store。装≠启用——不触碰启用集。
export async function installExtension(
  bridge: DesktopBridge,
  sourceRef: string,
  scope: SkillScope = "global",
  now: number = Date.now(),
): Promise<PiExtInstallResult> {
  if (!bridge.piExtInstall) return { ok: false, error: "扩展安装在此环境不可用" };
  const r = await bridge.piExtInstall({ sourceRef });
  if (r.ok) {
    usePersonalStore.getState().recordInstalledExtension({
      ref: r.ref,
      scope,
      sourceRef: r.sourceRef,
      origin: r.origin,
      version: r.version,
      installedAt: now,
      path: r.path,
    });
  }
  return r;
}

// 卸载:在启用集则先自动禁用(C2,指纹下一轮漂移),再 remove;成功才清溯源/启用/信任记录。
// remove 失败 → 保留记录（已自动禁用,用户可重试卸载）。
export async function uninstallExtension(
  bridge: DesktopBridge,
  scope: SkillScope,
  ref: string,
  sourceRef: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!bridge.piExtRemove) return { ok: false, error: "扩展卸载在此环境不可用" };
  const store = usePersonalStore.getState();
  const key = `${scope}:${ref}`;
  const cfg = { ...DEFAULT_PI_EXTENSIONS, ...store.generalSettings.piExtensions };
  if (cfg.enabled.includes(key)) store.toggleExtension(scope, ref, false); // C2 自动先禁用
  const r = await bridge.piExtRemove({ sourceRef });
  if (r.ok) usePersonalStore.getState().removeInstalledExtension(scope, ref);
  return r;
}

// 启用 = 过信任门 + 入启用集（UI 在信任门确认后调用;trust+enable 一并落，R6）。
export function enableExtension(scope: SkillScope, ref: string): void {
  const store = usePersonalStore.getState();
  store.trustExtension(scope, ref, true);
  store.toggleExtension(scope, ref, true);
}

// 禁用 = 仅移出启用集（保留信任记录;指纹下一轮漂移使其真正卸载，防裸奔由 U3 resolve 侧保证）。
export function disableExtension(scope: SkillScope, ref: string): void {
  usePersonalStore.getState().toggleExtension(scope, ref, false);
}
