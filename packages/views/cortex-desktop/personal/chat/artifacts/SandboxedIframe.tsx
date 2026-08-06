// pi 产物 / REPL 共用的沙箱 iframe（React 组件层;srcdoc 组装与协议校验在 sandboxHtml.ts）。
//
// 【评审红线 · 永不放宽】sandbox 集合固定为 "allow-scripts allow-modals":
// srcdoc + allow-same-origin + allow-scripts = 沙箱逃逸——iframe 将与主渲染进程同源,
// 而主窗口带着 preload bridge(desktopAPI 全量能力),等于把 LLM 生成的代码放进特权环境。
// 后续如需「父页读 iframe DOM / 截图导出」一类能力,走 postMessage 协议扩展,绝不加
// allow-same-origin;也不加 allow-popups / allow-top-navigation(导航由 runtime 拦截转
// open-external,经系统浏览器打开)。测试对 sandbox 属性有精确断言,改动会先红。

import React, { useEffect, useMemo, useRef } from "react";

import {
  buildSandboxSrcdoc,
  parsePiSandboxMessage,
  type PiSandboxConsoleEntry,
  type PiSandboxMessage,
} from "./sandboxHtml";

/** 固定 sandbox 属性集（红线,见文件头）。 */
export const PI_SANDBOX_ATTR = "allow-scripts allow-modals";

export interface SandboxedIframeProps {
  sandboxId: string;
  mode: "html" | "repl";
  code: string;
  /** 产物 version:变化时经 key 重挂 iframe(update 覆盖刷新的实现手段)。 */
  version: number;
  allowNetwork?: boolean;
  className?: string;
  title?: string;
  onConsole?: (entry: PiSandboxConsoleEntry) => void;
  onError?: (message: string, stack?: string) => void;
  onDone?: (ok: boolean, returnValue?: string) => void;
  /** 沙箱内点外链 → 交宿主经系统浏览器打开(bridge.openExternal)。 */
  onOpenExternal?: (url: string) => void;
}

/** 沙箱 iframe。消息双验:event.source 必须是本 iframe + sandboxId 匹配（防同页其它 iframe 伪造）。 */
export function SandboxedIframe(props: SandboxedIframeProps): React.JSX.Element {
  const { sandboxId, mode, code, version, allowNetwork, className, title } = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // 回调经 ref 转发:message 监听只随 sandboxId 重挂,不因父组件每帧新建回调而反复解绑。
  const handlersRef = useRef(props);
  handlersRef.current = props;

  const srcDoc = useMemo(
    () => buildSandboxSrcdoc({ mode, code, sandboxId, ...(allowNetwork !== undefined ? { allowNetwork } : {}) }),
    [mode, code, sandboxId, allowNetwork],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const msg: PiSandboxMessage | null = parsePiSandboxMessage(event.data, sandboxId);
      if (!msg) return;
      const h = handlersRef.current;
      if (msg.kind === "console") h.onConsole?.(msg.entry);
      else if (msg.kind === "error") h.onError?.(msg.message, msg.stack);
      else if (msg.kind === "done") h.onDone?.(msg.ok, msg.returnValue);
      else if (msg.kind === "open-external") h.onOpenExternal?.(msg.url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sandboxId]);

  return (
    <iframe
      key={`${sandboxId}-v${version}`}
      ref={iframeRef}
      className={className}
      title={title ?? "pi-artifact-sandbox"}
      sandbox={PI_SANDBOX_ATTR}
      srcDoc={srcDoc}
    />
  );
}
