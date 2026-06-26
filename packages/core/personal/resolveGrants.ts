// 目录授权解析与按 mode 钳制(KTD3/KTD4)。纯函数:不碰 fs(home 由调用方注入,
// realpath 规范化在主进程入注册表时做,见 U5)。
//   resolveGrantDirs:DirectoryGrant[] → 各类别的绝对目录集 + all-files 哨兵。
//   clampByMode:按 mode 把目录集分流为可写/可读;mode 是上界,授权不能突破 mode。
//     plan        → 全部只读(writable 恒空)
//     accept-edits → workspace/custom/generated-images 可写
//     full-auto   → all-files 哨兵下完全放开(不产 extraDirs,sandbox 已全开)

import {
  DEFAULT_DIRECTORY_GRANTS,
  type ConcretePermissionMode,
  type DirectoryGrant,
} from "../desktop/types";

export interface ResolvedGrantDirs {
  workspace: string | null;
  generatedImages: string[];
  custom: string[];
  allFiles: boolean;
}

export interface ClampedGrantDirs {
  writableExtraDirs: string[];
  readableExtraDirs: string[];
}

// agent 产图目录。当前覆盖 codex `~/.codex/generated_images` 与 app 自身媒体目录
// (项目内 .cortex/media/images 由 cwd 推导)。claude/pi 产图目录待扩展(见计划 Deferred)。
function generatedImageDirs(cwd: string, home: string): string[] {
  return [`${home}/.codex/generated_images`, `${cwd}/.cortex/media/images`];
}

export function resolveGrantDirs(
  grants: DirectoryGrant[] | undefined,
  cwd: string,
  home: string,
): ResolvedGrantDirs {
  // 空/缺省兜底为默认授权(仅工作区),与「新会话默认目录」一致。
  const list = grants && grants.length > 0 ? grants : DEFAULT_DIRECTORY_GRANTS;
  const out: ResolvedGrantDirs = {
    workspace: null,
    generatedImages: [],
    custom: [],
    allFiles: false,
  };
  for (const g of list) {
    switch (g.kind) {
      case "workspace":
        out.workspace = cwd;
        break;
      case "generated-images":
        out.generatedImages = generatedImageDirs(cwd, home);
        break;
      case "custom":
        // 累加而非覆盖:防止畸形持久数据里多个 custom 条目只保留最后一个(评审 F2)。
        out.custom.push(...g.dirs);
        break;
      case "all-files":
        out.allFiles = true;
        break;
    }
  }
  return out;
}

export function clampByMode(
  mode: ConcretePermissionMode,
  resolved: ResolvedGrantDirs,
): ClampedGrantDirs {
  // 路径授权目录(不含 all-files 哨兵):workspace + generated-images + custom。
  const pathDirs = [
    ...(resolved.workspace ? [resolved.workspace] : []),
    ...resolved.generatedImages,
    ...resolved.custom,
  ];
  if (mode === "plan") {
    // 只读:全部进 readable,绝不可写。
    return { writableExtraDirs: [], readableExtraDirs: pathDirs };
  }
  if (mode === "full-auto") {
    // full-auto 本就 danger-full-access:all-files 完全放开,--add-dir 为 no-op,不产 extraDirs。
    // 非 all-files 时也无需额外目录(sandbox 已无限制)。
    return { writableExtraDirs: [], readableExtraDirs: [] };
  }
  // accept-edits:路径授权目录可写(all-files 哨兵在此 mode 无意义,被忽略——非 full-auto 不放开)。
  return { writableExtraDirs: pathDirs, readableExtraDirs: [] };
}
