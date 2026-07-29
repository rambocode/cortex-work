// 会话正文里的知识库文档引用：`[文件名](kb://<sourceId>/<relPath>)` → 可点击的引用 chip，
// 点击在右栏打开正文预览。
//
// 为什么用自定义 scheme 而不是复用 FileAnchor：知识库文档**不在本机**，
// FileAnchor 那条链会先 stat 本地路径、定位不到就把链接判死，对远端文档必然失败。
//
// 预览取文走 bridge.knowledge.readDoc（主进程自己的 MCP 通道），与 agent 会话无关——
// 用户点一下引用不该触发一次 agent 回合。
import { useCallback, type ReactNode } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore, type DesktopBridge } from "@cortex-work/core";

/// 引用 URL 的 scheme。skill 里要求 agent 按 `kb://<sourceId>/<relPath>` 输出。
const KB_SCHEME = "kb://";

export interface KnowledgeDocRef {
  sourceId: string;
  relPath: string;
}

/// 解析 `kb://<sourceId>/<relPath>`。relPath 可含斜杠，故只切第一个。
///
/// href 经 remark 的 normalizeUri 会被 percent-encode（中文路径尤甚），必须解码后再用，
/// 否则拿去请求服务端会因路径对不上而 404 —— 与 chatMarkdown 里本地文件 ref 同一个坑。
export function parseKnowledgeRef(href: string | undefined): KnowledgeDocRef | null {
  if (!href || !href.toLowerCase().startsWith(KB_SCHEME)) return null;
  let rest = href.slice(KB_SCHEME.length);
  try {
    rest = decodeURI(rest);
  } catch {
    /* 已是解码态或含非法转义 → 用原串继续 */
  }
  rest = rest.replace(/^\/+/, "");
  const idx = rest.indexOf("/");
  if (idx <= 0 || idx === rest.length - 1) return null;
  const sourceId = rest.slice(0, idx).trim();
  const relPath = rest.slice(idx + 1).trim();
  if (!sourceId || !relPath) return null;
  return { sourceId, relPath };
}

/// 从 relPath 取展示用的文件名（agent 常把整个路径当 label，太长）。
export function knowledgeRefName(ref: KnowledgeDocRef): string {
  const segs = ref.relPath.split("/").filter(Boolean);
  return segs[segs.length - 1] || ref.relPath;
}

/// 知识库引用 chip。样式复用会话里既有的 .file-link（同为「可点开的资料」语义）。
export function KnowledgeDocAnchor({
  refDoc,
  href,
  children,
  bridge,
  ...rest
}: {
  refDoc: KnowledgeDocRef;
  href?: string;
  children: ReactNode;
  bridge: DesktopBridge | null;
} & Record<string, unknown>) {
  const openDoc = usePersonalStore((s) => s.openKnowledgeDoc);
  const label = typeof children === "string" ? children.trim() : "";
  // label 与路径同形（agent 常写 `[kb://a/b.md](kb://a/b.md)`）时收敛成文件名，
  // 与 FileAnchor 的 compact 形态同一取舍：完整坐标留在 title 里。
  const compact = !label || label === href || label === refDoc.relPath;
  const canOpen = Boolean(bridge?.knowledge?.readDoc);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault(); // Electron 里 a 默认导航会替换整个窗口
      if (canOpen) openDoc(refDoc);
    },
    [canOpen, openDoc, refDoc],
  );

  return (
    <a
      {...rest}
      href={href}
      rel="noreferrer"
      className={canOpen ? "file-link is-compact" : undefined}
      title={`知识库文档：${refDoc.sourceId}/${refDoc.relPath}`}
      onClick={onClick}
    >
      <Icon.Archive size={12} />
      {compact ? knowledgeRefName(refDoc) : children}
    </a>
  );
}
