// 会话目录授权 → 主进程可信目录集(KTD6)。
// 安全要点:授权目录的真相源是主进程自有的持久化会话(getPersistedState().sessions),
// **绝不**接受渲染端传入的目录列表——渲染端只传 sessionId 作查表 key。被注入的渲染端
// 无法借此打开任意路径(注册表里没有即恒拒)。
//
// 仅 generated-images 与 custom 两类授权会扩展 app 侧打开/读取范围:
//   - workspace 已由 allowedRoots 的项目根覆盖,不重复;
//   - all-files 不在此展开(它是 mode=full-auto 下的 agent 启动级全开,app 侧打开不放任意盘)。
// 所有路径在此 realpath 规范化(解符号链接,杜绝 custom 指向 symlink 越权);解析失败的路径丢弃。

import { promises as fsp } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getPersistedState } from "./store";
import type { DirectoryGrant } from "./types";

// 把单个会话的授权(generated-images + custom)展开为待规范化的逻辑绝对路径。
function logicalGrantDirs(grants: DirectoryGrant[] | undefined): string[] {
  if (!grants) return [];
  const home = homedir();
  const out: string[] = [];
  for (const g of grants) {
    if (g.kind === "generated-images") {
      out.push(join(home, ".codex", "generated_images"));
    } else if (g.kind === "custom") {
      out.push(...g.dirs);
    }
    // workspace / all-files 不在此展开(见文件头注释)。
  }
  return out;
}

// realpath 规范化:解符号链接到真实目标;不存在/无权访问的路径丢弃(不抛)。
async function canonicalize(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    try {
      out.push(await fsp.realpath(p));
    } catch {
      /* 路径不存在或不可访问,丢弃 */
    }
  }
  return out;
}

// 给定 sessionId,返回该会话授权扩展出的、已规范化的可打开/可读目录集。
// sessionId 缺省或查无此会话 → 返回空数组(退化为「仅白名单根 + 真实文件」的既有语义)。
export async function sessionGrantedDirs(sessionId: string | undefined): Promise<string[]> {
  if (!sessionId) return [];
  const state = await getPersistedState();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return [];
  return canonicalize(logicalGrantDirs(session.directoryGrants));
}
