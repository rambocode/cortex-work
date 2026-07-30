// 用户消息气泡内的图片缩略图。统一经 bridge.imageRead(path) 回读为 dataURL 渲染(KTD4:不
// 维护跨组件 dataUrl 缓存,本地盘读取延迟可忽略)。读失败/越界/文件缺失 → 受控占位(显示文件名
// + 「图片不可用」),不渲染 broken-image(lessons ENOENT:仅 reject 才占位)。本期缩略图不可点。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";
import type { ChatImageRef, DesktopBridge } from "@cortex-work/core";

export function ChatImages({ images }: { images: ChatImageRef[] }) {
  const bridge = useDesktopBridge();
  return (
    <div className="msg-img-row">
      {images.map((img) => (
        <ChatImageThumb key={img.path} img={img} bridge={bridge} />
      ))}
    </div>
  );
}

function ChatImageThumb({ img, bridge }: { img: ChatImageRef; bridge: DesktopBridge | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!bridge?.imageRead) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setSrc(null);
    bridge
      .imageRead(img.path)
      .then((r) => {
        if (alive) setSrc(r.dataUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [img.path, bridge]);

  if (failed) {
    return (
      <span className="msg-img msg-img-missing" title={img.name}>
        <Icon.Image size={16} />
        <span className="msg-img-name">{img.name}</span>
        <span className="msg-img-label">图片不可用</span>
      </span>
    );
  }
  if (!src) return <span className="msg-img msg-img-loading" aria-busy="true" aria-label={`加载 ${img.name}`} />;
  return <img className="msg-img" src={src} alt={img.name} />;
}
