// 写作文件树的纯路径工具 + 文件/目录 CRUD 动作(经注入的 DesktopBridge 落盘)。
// 树节点 key 一律用绝对路径。新建走「先探测重名再写盘」预检——bridge.writeFile 会
// 静默覆盖已有文件,必须自行拒绝重名,否则「新建同名文件」会顶掉原内容;renameEntry 的
// 重名预检主进程已自带(fs:renameEntry 用 stat 兜底),这里再前置一次以便早返回友好错误。
// core 禁用 node path,故路径切分自己做,且兼容 / 与 \(路径来自 OS 原生,跨端)。
import type { DesktopBridge } from "../desktop/bridge";
import type { PromptNode } from "../desktop/types";

// CRUD 动作统一返回值:ok 成功;error 为归类原因供 UI 提示(exists=重名、unsupported=旧壳缺能力、
// invalid=名称非法、failed=底层抛错),message 携带原始错误文本。
export interface FsActionResult {
  ok: boolean;
  path?: string; // 成功时的目标绝对路径
  error?: "exists" | "unsupported" | "invalid" | "failed";
  message?: string;
}

// 取绝对路径末段(文件/目录名)。先去尾部分隔符再按最后一个分隔符切。
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

// 取父目录路径(去掉末段)。根或无分隔符时回落去尾后的原串,避免拼出空父目录。
export function parentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx <= 0 ? trimmed : trimmed.slice(0, idx);
}

// 拼接目录与子名:统一用 / 分隔,去掉 dir 尾部分隔符防出现 //。
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[/\\]+$/, "")}/${name}`;
}

// 归一化用户输入的名称:去首尾空白;非法(空 / 含路径分隔符)则回 null,由调用方转 invalid 错误。
function sanitizeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || /[/\\]/.test(trimmed)) return null;
  return trimmed;
}

// 探测路径是否已被占用。注意:主进程 fs:exists 仅对「文件」返回 true(isFile),
// 目录不计——故本预检只能拦文件重名。目录重名由 mkdir 幂等(recursive 已存在即 no-op,
// 无数据损失)与 renameEntry 的 stat 预检兜底,可接受。旧壳缺 fileExists 时退化为不预检(false)。
async function entryExists(bridge: DesktopBridge, path: string): Promise<boolean> {
  if (!bridge.fileExists) return false;
  try {
    return await bridge.fileExists(path);
  } catch {
    return false;
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 写作树过滤与自动带入 ─────────────────────────────────────────────────
// 写作空间文件树只显示写作相关文件:md 系(可编辑)+ pdf(阅读/选区引用是既有功能,不滤)。
// 图片等其它文件(如粘贴图片落盘的 img 目录内容)不进树,避免杂文件淹没文档列表。
const WRITING_MD_RE = /\.(md|markdown|mdx)$/i;
const WRITING_TREE_FILE_RE = /\.(md|markdown|mdx|pdf)$/i;

export function isWritingTreeFile(name: string): boolean {
  return WRITING_TREE_FILE_RE.test(name);
}

// 过滤扫描出的目录树:文件只保留 md/pdf;目录按「本来是否为空」区分——
// 本就是空目录(新建文件夹/用户的组织目录)必须保留,否则新建文件夹不显示、层级关系缺失;
// 原本有内容但全被滤掉的目录(如只装粘贴图片的 img 目录)才整体隐藏。根节点恒保留。
export function filterWritingTree(node: PromptNode): PromptNode {
  const children = (node.children ?? []).flatMap((c) => {
    if (c.kind !== "dir") return isWritingTreeFile(c.name) ? [c] : [];
    const filtered = filterWritingTree(c);
    const originallyEmpty = (c.children?.length ?? 0) === 0;
    return (filtered.children?.length ?? 0) > 0 || originallyEmpty ? [filtered] : [];
  });
  return { ...node, children };
}

// 按树展示顺序找第一个 md 文档(本层文件优先于子目录深入):
// 「添加写作空间」后自动带入所选目录里的文档用。无 md 时返回 null(编辑器留空)。
export function firstMarkdownFile(node: PromptNode): string | null {
  const children = node.children ?? [];
  for (const c of children) {
    if (c.kind === "file" && WRITING_MD_RE.test(c.name)) return c.path;
  }
  for (const c of children) {
    if (c.kind === "dir") {
      const hit = firstMarkdownFile(c);
      if (hit) return hit;
    }
  }
  return null;
}

// 新建空文件:重名预检拒绝(避免 writeFile 覆盖),通过则写入空内容。
export async function createFile(
  bridge: DesktopBridge,
  parentDir: string,
  name: string,
): Promise<FsActionResult> {
  const safe = sanitizeName(name);
  if (!safe) return { ok: false, error: "invalid" };
  const target = joinPath(parentDir, safe);
  if (await entryExists(bridge, target)) return { ok: false, error: "exists", path: target };
  try {
    await bridge.writeFile(target, "");
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: "failed", message: toMessage(err) };
  }
}

// 新建目录:mkdir 可选(旧壳/web 缺 → unsupported)。文件重名预检拦已有同名文件。
export async function createDir(
  bridge: DesktopBridge,
  parentDir: string,
  name: string,
): Promise<FsActionResult> {
  if (!bridge.mkdir) return { ok: false, error: "unsupported" };
  const safe = sanitizeName(name);
  if (!safe) return { ok: false, error: "invalid" };
  const target = joinPath(parentDir, safe);
  if (await entryExists(bridge, target)) return { ok: false, error: "exists", path: target };
  try {
    await bridge.mkdir(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: "failed", message: toMessage(err) };
  }
}

// 重命名文件/目录:同名视为 no-op 直接成功;否则算出同目录目标路径,前置重名预检 +
// 主进程 renameEntry(stat 二次兜底不覆盖)。renameEntry 可选(旧壳缺 → unsupported)。
export async function renameNode(
  bridge: DesktopBridge,
  from: string,
  newName: string,
): Promise<FsActionResult> {
  if (!bridge.renameEntry) return { ok: false, error: "unsupported" };
  const safe = sanitizeName(newName);
  if (!safe) return { ok: false, error: "invalid" };
  const to = joinPath(parentPath(from), safe);
  if (to === from) return { ok: true, path: from }; // 未改名
  if (await entryExists(bridge, to)) return { ok: false, error: "exists", path: to };
  try {
    await bridge.renameEntry(from, to);
    return { ok: true, path: to };
  } catch (err) {
    return { ok: false, error: "failed", message: toMessage(err) };
  }
}

// 删除文件/目录(递归):deleteEntry 可选(旧壳/web 缺 → unsupported)。破坏性操作,
// 调用方对「当前打开文件」需先确认(见 WritingSidebar)。
export async function deleteNode(bridge: DesktopBridge, path: string): Promise<FsActionResult> {
  if (!bridge.deleteEntry) return { ok: false, error: "unsupported" };
  try {
    await bridge.deleteEntry(path);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: "failed", message: toMessage(err) };
  }
}
