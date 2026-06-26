// spawn 装配合成层(KTD1/KTD7)。messages.ts 已超 1200 行上限,mode/目录授权的合成逻辑
// 抽到此处,messages.ts 仅调用,避免继续膨胀。
//
// 职责:把会话级的 (permissionMode, directoryGrants) 按当轮 prompt + cwd + home 合成为
// 下传 adapter 的 (具体档 + 可写/可读额外目录)。`auto` 在此逐轮解析成具体档(adapter 永不见 auto)。

import type { ConcretePermissionMode, DirectoryGrant, PermissionMode } from "../desktop/types";
import { resolveEffectiveMode } from "./resolveMode";
import { clampByMode, resolveGrantDirs } from "./resolveGrants";

export interface SpawnModeGrants {
  // 解析后的具体档,直接进 CliStartRequest.permissionMode(adapter 翻译原生标志)。
  permissionMode: ConcretePermissionMode;
  // 目录授权合成产物,进 CliStartRequest 同名字段(adapter 翻译 --add-dir 等)。
  writableExtraDirs: string[];
  readableExtraDirs: string[];
}

// 合成本轮的 mode + 目录授权。home 缺省(web/旧壳)时 generated-images 仅退化为缺其绝对路径,
// 不影响 workspace/custom 授权(均为绝对路径,不依赖 home)。
export function assembleModeGrants(opts: {
  permissionMode: PermissionMode | undefined;
  directoryGrants: DirectoryGrant[] | undefined;
  prompt: string;
  cwd: string;
  home: string | undefined;
}): SpawnModeGrants {
  const mode = resolveEffectiveMode(opts.permissionMode, opts.prompt);
  // home 缺省时传空串:generatedImageDirs 会产出无意义路径,但 resolveGrantDirs 仅在授权了
  // generated-images 时才展开;为避免污染,home 缺省时跳过 generated-images 展开。
  const resolved = resolveGrantDirs(
    opts.home ? opts.directoryGrants : stripGeneratedImages(opts.directoryGrants),
    opts.cwd,
    opts.home ?? "",
  );
  const clamped = clampByMode(mode, resolved);
  return {
    permissionMode: mode,
    writableExtraDirs: clamped.writableExtraDirs,
    readableExtraDirs: clamped.readableExtraDirs,
  };
}

// home 不可得时剔除 generated-images 授权(无法解析其绝对路径),其余授权照常。
function stripGeneratedImages(grants: DirectoryGrant[] | undefined): DirectoryGrant[] | undefined {
  if (!grants) return grants;
  return grants.filter((g) => g.kind !== "generated-images");
}
