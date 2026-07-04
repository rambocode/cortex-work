// 本地 HTML 文件的内嵌预览授权。agent 常把产物写成本地 .html(如
// Documents/cortex/<日期>/foo.html)并提示「用浏览器打开」,本模块把这类文件授权为可在
// 内嵌 webview 用 file:// 加载(借鉴 Kun 的 prototype-embed 授权模型)。
//
// 安全约束(file:// 是敏感 scheme,deny-by-default 之外的唯一放行口):
//   - 仅 .html/.htm 扩展名;
//   - 路径必须在允许根内(promptRoot / Documents/cortex / 已注册项目),复用 fs.assertAllowed;
//   - 符号链接规范化(realpath)后再校验一次,防 symlink 逃逸出允许根;
//   - 必须是真实存在的文件;
//   - 授权过的 file:// URL 进会话级 allow-list,webview 导航闸门只放行集合内的 file://。

import { promises as fsp } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertAllowed } from "../ipc/fs";
import { expandTilde } from "../skills/locate";

// 会话级已授权 file:// URL 集合。webviewGuards 经 isAuthorizedFileUrl 查询。
const authorizedFileUrls = new Set<string>();

// 匹配前剥掉 query/hash:设计画布实时刷新用 `?rev=N` 强制 webview 重载同一文件,
// query 变体指向的仍是已授权的那个物理文件,不构成新的放行面;路径本身仍须先经
// resolveLocalHtml 全套校验(允许根/realpath/.html/真实文件)进入集合。
function normalizeFileUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

export function isAuthorizedFileUrl(url: string): boolean {
  return authorizedFileUrls.has(normalizeFileUrl(url));
}

const HTML_EXT_RE = /\.html?$/i;

// 解析并授权一个本地 HTML 路径 → file:// URL;不合规返回 null。
export async function resolveLocalHtml(inputPath: string): Promise<string | null> {
  try {
    const expanded = expandTilde(inputPath.trim());
    if (!HTML_EXT_RE.test(expanded)) return null;
    // 先按原路径校验在允许根内。
    await assertAllowed(expanded);
    // 符号链接规范化后再校验,防 symlink 指向允许根之外。
    const real = await fsp.realpath(expanded);
    await assertAllowed(real);
    if (!HTML_EXT_RE.test(real)) return null;
    const stat = await fsp.stat(real);
    if (!stat.isFile()) return null;
    const url = pathToFileURL(real).toString();
    authorizedFileUrls.add(url);
    return url;
  } catch {
    // 不在允许根 / 不存在 / 非文件 → 不授权。
    return null;
  }
}
