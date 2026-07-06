// 写作工作区粘贴图片(U1)的渲染端纯逻辑:从剪贴板提取图片、mime→扩展名、
// 以及把落盘绝对路径换算成「相对当前 md 目录」的 Markdown 链接。
// 全部为纯函数(不碰 window.desktopAPI / node path,遵守 core 边界),便于就近单测;
// 真正的落盘经 DesktopBridge.writingSaveImage 走主进程(见 WritingEditorPane / WritingRichEditor)。

// 剪贴板 item 的最小形状(兼容真实 DataTransferItem 与测试桩)。
export interface ClipboardImageItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

// 常见图片 mime → 落盘扩展名(不含点)。jpeg 统一落 jpg,与 Kun 图片目录习惯一致。
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
};

// mime → 扩展名:命中映射表优先;否则退回 image/<subtype> 的 subtype(去掉 +xml 等后缀)并净化;
// 仍取不到则回落 png(主进程还会再净化一次,双保险)。
export function imageExtFromMime(mime: string): string {
  const key = (mime ?? "").trim().toLowerCase();
  if (MIME_TO_EXT[key]) return MIME_TO_EXT[key];
  const sub = key.startsWith("image/") ? key.slice(6).replace(/\+.*$/, "") : "";
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : "png";
}

// 剪贴板 items 中是否含图片文件(kind==='file' 且 type 以 image/ 开头)。
export function clipboardHasImageFile(
  items: ArrayLike<ClipboardImageItemLike> | null | undefined,
): boolean {
  if (!items) return false;
  return Array.from(items).some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

// 提取首个图片文件 + 其 mime;非图片粘贴(纯文本/无 file)返回 null,调用方据此放行默认粘贴。
export function extractClipboardImageFile(
  items: ArrayLike<ClipboardImageItemLike> | null | undefined,
): { file: File; mime: string } | null {
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return { file, mime: item.type };
  }
  return null;
}

// 统一分隔符为 /、拆段去空段(不做 realpath,core 无 node path)。
function pathSegments(value: string): string[] {
  return value.replaceAll("\\", "/").split("/").filter(Boolean);
}

// 把落盘绝对路径换算为「相对当前 md 所在目录」的 POSIX 相对链接(用于插入 ![](...))。
// 标准相对路径算法:剥公共前缀后,源目录剩余段各出一个 ..,再接目标剩余段。
//   同目录 → name.png;子目录 → img/name.png;父目录方向 → ../img/name.png(../ 折叠正确)。
// 退化情形(目标恰为源目录本身,现实中不会发生)回落目标 basename。
export function relativeImageLink(currentMdPath: string, savedAbsPath: string): string {
  const fromDir = pathSegments(currentMdPath).slice(0, -1); // md 所在目录
  const to = pathSegments(savedAbsPath);
  let i = 0;
  while (i < fromDir.length && i < to.length && fromDir[i] === to[i]) i += 1;
  const up = fromDir.slice(i).map(() => "..");
  const down = to.slice(i);
  const rel = [...up, ...down].join("/");
  return rel || (to[to.length - 1] ?? "");
}
