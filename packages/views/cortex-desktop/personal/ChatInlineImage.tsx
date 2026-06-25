// agent 回复里本地图片路径(markdown 链接 `[name](path)` 或 `![](path)`)的内联渲染。
// codex 等外部 CLI 产出绝对路径(~/.codex/generated_images),pi 产出项目内相对路径
// (.cortex/media/images);两者统一经 bridge.imageReadAny 回读为 dataURL 显示(复用 ChatImages
// 范式),点击在应用内灯箱放大。读失败/无能力 → 降级为可点击文件链接(走 onOpenFile→openPath)。

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { resolveProjectFileRef } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";

interface ChatInlineImageProps {
  src: string; // 原始 ref(绝对路径或项目内相对路径)
  alt: string; // markdown 链接文本 / alt,失败降级时作链接文字
  projectPath: string;
  bridge: DesktopBridge | null;
  onOpenFile: (ref: string) => void; // 降级链接点击 → 复用 handleOpenFile 派发
}

function baseName(p: string): string {
  return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
}

export function ChatInlineImage({ src, alt, projectPath, bridge, onOpenFile }: ChatInlineImageProps) {
  // 绝对路径直用;相对路径拼到项目根(图片 ref 是真实相对路径,无需 resolveProjectFile 的裸名搜索)。
  const abs = useMemo(
    () => (src.startsWith("/") ? src : resolveProjectFileRef(projectPath, src).abs),
    [src, projectPath],
  );
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = bridge?.imageReadAny;
    if (!read) {
      setFailed(true); // 无回读能力(web/旧壳)→ 降级链接
      return;
    }
    setFailed(false);
    setDataUrl(null);
    read(abs).then(
      (r) => alive && setDataUrl(r.dataUrl),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [abs, bridge]);

  if (failed) {
    // 降级:可点击文件链接。点击经 onOpenFile→handleOpenFile→openPath 用系统应用打开。
    return (
      <a
        className="file-link"
        href={abs}
        rel="noreferrer"
        title={src}
        onClick={(e) => {
          e.preventDefault();
          onOpenFile(src);
        }}
      >
        {alt || baseName(src)}
      </a>
    );
  }
  if (!dataUrl) {
    return <span className="chat-inline-img chat-inline-img--loading" aria-busy="true" aria-label={`加载 ${alt || baseName(src)}`} />;
  }
  return (
    <>
      <img
        className="chat-inline-img"
        src={dataUrl}
        alt={alt || baseName(src)}
        title={src}
        onClick={() => setZoom(true)}
      />
      {zoom ? <ImageLightbox src={dataUrl} abs={abs} name={baseName(src)} bridge={bridge} onClose={() => setZoom(false)} /> : null}
    </>
  );
}

// 全屏灯箱:portal 到 body,脱离消息流层叠环境;Esc / 点遮罩关闭;底部「系统应用打开 / 访达显示」。
function ImageLightbox({
  src,
  abs,
  name,
  bridge,
  onClose,
}: {
  src: string;
  abs: string;
  name: string;
  bridge: DesktopBridge | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="img-lightbox" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <div className="img-lightbox-body" onClick={(e) => e.stopPropagation()}>
        <img className="img-lightbox-img" src={src} alt={name} />
        <div className="img-lightbox-bar">
          {bridge?.openPath ? (
            <button type="button" className="img-lightbox-action" onClick={() => void bridge.openPath?.(abs).catch(() => {})}>
              用系统应用打开
            </button>
          ) : null}
          {bridge?.revealInFolder ? (
            <button
              type="button"
              className="img-lightbox-action"
              onClick={() => void bridge.revealInFolder?.(abs).catch(() => {})}
            >
              <Icon.Folder size={14} />
              在访达中显示
            </button>
          ) : null}
          <button type="button" className="img-lightbox-close" aria-label="关闭" onClick={onClose}>
            <Icon.X size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
