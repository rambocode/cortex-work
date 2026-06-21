// 宿主侧标注状态管理(计划 U5)。与 webview 内的 annotation preload(隔离世界)经
// webview.send(宿主→preload)/ 'ipc-message'(preload→宿主)双向通道协作:
//   - 切换标注模式 → send('annotation:enable' / 'annotation:disable')。
//   - 接收 preload 回传的 'annotation:added' / 'annotation:removed' → 维护宿主标注列表。
//   - 整页导航(did-navigate)→ 清空未发送标注 + 退出模式 + toast(计划 KTD5);该监听
//     **独立于 BrowserView 的 onNavigate**(后者继续驱动地址栏/前进后退态),互不回归。
//   - 批量发送:组装纯文本(经 annotationPayload 中和)→ 复用 store 的 insertToComposer
//     (不传 submit,人审)/ sendToTerminal;url 由宿主 webview.getURL() 盖戳(不信 preload 回传)。

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  composeAnnotationsForChat,
  composeAnnotationsForTerminal,
  type AnnotationRecord,
} from "@cortex-work/core/personal/annotationPayload";

// webview 元素的标注相关能力(运行期由 Electron 提供)。
export type AnnotatableWebview = HTMLElement & {
  send(channel: string, ...args: unknown[]): void;
  getURL(): string;
};

type IpcMessageEvent = Event & { channel: string; args: unknown[] };
type HostAnnotation = AnnotationRecord & { id: string };

export function useBrowserAnnotations(opts: {
  webviewRef: RefObject<AnnotatableWebview | null>;
  useElectronWebview: boolean;
  instanceNonce: number;
  onToast?: (text: string) => void;
}) {
  const { webviewRef, useElectronWebview, instanceNonce, onToast } = opts;
  const { t } = useTranslation("browser");
  const [enabled, setEnabled] = useState(false);
  const [records, setRecords] = useState<HostAnnotation[]>([]);
  // 始终拿到最新 enabled 供事件回调判断(避免回调闭包过期)。
  const enabledRef = useRef(false);
  enabledRef.current = enabled;

  // 监听 webview 'ipc-message'(preload 回传)与 did-navigate(整页导航清空)。
  useEffect(() => {
    const webview = webviewRef.current;
    if (!useElectronWebview || !webview) return;

    const onIpc: EventListener = (event) => {
      const ev = event as IpcMessageEvent;
      if (ev.channel === "annotation:added") {
        const a = ev.args[0] as HostAnnotation;
        if (a && typeof a.id === "string") setRecords((prev) => [...prev, a]);
      } else if (ev.channel === "annotation:removed") {
        const { id } = (ev.args[0] as { id: string }) ?? {};
        setRecords((prev) => prev.filter((r) => r.id !== id).map((r, i) => ({ ...r, n: i + 1 })));
      }
    };
    const onNavigate = (): void => {
      // 整页导航:selector 立即失效 → 清空未发送 + 退出模式 + 提示(KTD5)。
      if (!enabledRef.current && records.length === 0) return;
      setRecords((prev) => {
        if (prev.length > 0) onToast?.(t("annotate.navCleared"));
        return [];
      });
      setEnabled(false);
    };

    webview.addEventListener("ipc-message", onIpc);
    webview.addEventListener("did-navigate", onNavigate);
    return () => {
      webview.removeEventListener("ipc-message", onIpc);
      webview.removeEventListener("did-navigate", onNavigate);
    };
    // records 仅用于 onNavigate 的「是否提示」,用 ref 避免频繁重挂;此处依赖 instanceNonce 重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useElectronWebview, instanceNonce, onToast, t]);

  const send = useCallback(
    (channel: string) => {
      try {
        webviewRef.current?.send(channel);
      } catch {
        /* webview 尚未 attach */
      }
    },
    [webviewRef],
  );

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      send(next ? "annotation:enable" : "annotation:disable");
      if (!next) setRecords([]);
      return next;
    });
  }, [send]);

  const finish = useCallback(() => {
    send("annotation:disable");
    setEnabled(false);
    setRecords([]);
  }, [send]);

  const toRecords = (list: HostAnnotation[]): AnnotationRecord[] =>
    list.map(({ id: _id, ...rest }, i) => ({ ...rest, n: i + 1 }));

  const currentUrl = (): string => {
    try {
      return webviewRef.current?.getURL() ?? "";
    } catch {
      return "";
    }
  };

  const sendToChat = useCallback(() => {
    if (records.length === 0) return;
    const text = composeAnnotationsForChat(toRecords(records), currentUrl());
    usePersonalStore.getState().insertToComposer(text); // 不传 submit:人审后手动发送(KTD2)
    onToast?.(t("annotate.sentToChat"));
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, finish, onToast, t]);

  const sendToTerminal = useCallback(() => {
    if (records.length === 0) return;
    const text = composeAnnotationsForTerminal(toRecords(records), currentUrl());
    usePersonalStore.getState().sendToTerminal(text);
    onToast?.(t("annotate.sentToTerminal"));
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, finish, onToast, t]);

  return { enabled, count: records.length, toggle, sendToChat, sendToTerminal };
}
