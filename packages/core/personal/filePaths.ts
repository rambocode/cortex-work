// 会话消息里文件路径的「渲染期」纯函数：判断一段文本是否「像项目内文件路径」,
// 并把相对/绝对 ref 解析为绝对路径 + 是否落在项目根内（within）。
// 纯字符串实现（不依赖 node path,因 views 同被 web 打包）;无副作用,便于表驱动测试。

// 常见源码/文档/配置扩展名（保守白名单;命中不到只退化为纯文本,不破坏渲染）。
const FILE_EXT_RE =
  /\.(tsx?|jsx?|mjs|cjs|md|markdown|mdx|go|json|jsonc|css|scss|sass|less|html?|py|rs|java|kt|kts|c|cc|cpp|h|hpp|sh|bash|zsh|fish|yml|yaml|toml|ini|txt|sql|vue|svelte|rb|php|swift|lua|pl|r|dart|ex|exs|erl|clj|scala|gradle|xml|csv|env|lock|cfg|conf|proto|graphql|prisma)$/i;

// 一段文本是否「像」项目内文件路径。保守判定:宁可漏识别(退化纯文本),不误触发。
// 命中规则:去空白后非空、不含空白、非 URL/mailto、且(含 `/` 或带已知文件扩展名);
// 纯数字/版本号(如 1.5、1.2.3)排除。
export function isLikelyFilePath(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\s/.test(t)) return false; // 含空白 → 不是单一路径(如 "npm run test")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // scheme:// (http(s)/file/...)
  if (/^mailto:/i.test(t)) return false;
  const hasSlash = t.includes("/");
  const hasExt = FILE_EXT_RE.test(t);
  if (!hasSlash && !hasExt) return false; // 无斜杠又无已知扩展名 → 视为普通词(README、e.g.)
  if (!hasSlash && /^[\d.]+$/.test(t)) return false; // 无斜杠的纯数字/版本号(1.5)
  return true;
}

// 本地位图图片路径扩展名(与主进程 image.ts 读侧 allowlist 对齐:仅 PNG/JPEG/GIF/WebP)。
// svg 刻意不在内——读侧也拒(svg 可内联脚本),避免内联渲染引入注入面。
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// 一段文本是否「本地图片路径」:非 scheme://(http(s)/file/data 等)、且以位图扩展名结尾。
// 用于聊天 markdown 把图片链接 / `<img>` 内联渲染。命中即交给 ChatInlineImage 经 imageReadAny
// 回读为 dataURL 显示;不命中(含 svg、http 图床、data: URI)走原有链接渲染逻辑。
export function isLocalImagePath(ref: string): boolean {
  const t = ref.trim();
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // scheme:// (http(s)/file/...)
  if (/^data:/i.test(t)) return false; // data: URI 已是可直接渲染的内联源,不经回读
  return IMAGE_EXT_RE.test(t);
}

// 取 POSIX 风格 basename（折叠尾分隔符后取末段）。
function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed || p;
}

// POSIX 规范化:折叠 `.`、空段(`//`),解析 `..`（绝对路径不越过根)。
function normalizePosix(p: string): string {
  const isAbs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push(".."); // 相对路径保留爬出语义,供 within 判定
      // 绝对路径在根处的 `..` 直接丢弃(不能越过 /)
    } else out.push(seg);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

// 把消息里的 ref 解析为绝对路径:相对 ref 拼到 projectPath;绝对 ref 原样规范化。
// within = 规范化结果是否落在 projectPath 内（按分隔符边界匹配,防 /proj 误配 /project-other）。
export function resolveProjectFileRef(
  projectPath: string,
  ref: string,
): { abs: string; name: string; within: boolean } {
  const root = normalizePosix(projectPath);
  const abs = ref.startsWith("/") ? normalizePosix(ref) : normalizePosix(`${root}/${ref}`);
  const name = baseName(abs);
  const within = abs === root || abs.startsWith(root === "/" ? "/" : `${root}/`);
  return { abs, name, within };
}
