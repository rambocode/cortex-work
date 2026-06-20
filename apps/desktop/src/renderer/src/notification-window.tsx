// 独立通知窗体渲染入口:裸 React root(不包 CoreProvider/QueryClient),只经 window.desktopAPI
// 直连。接收主进程转发的提醒(notification:push)、自管理自动消失计时,实测内容高度上报主进程
// (notification:resize,空栈上报 0 → 主进程隐藏窗口)。卡片复用共享 NotificationCard。
// i18next 单例:import @cortex-work/core/i18n 即 init 本进程默认 zh;跨进程语言一致由
// app:locale 广播驱动(仿 notes-overlay.tsx)。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { NotificationCard } from "@cortex-work/views/cortex-desktop";
import { changeLanguage, useTranslation } from "@cortex-work/core/i18n";
import "./notification-window.css";

// 与 main/ipc/types.ts 的 NotificationPayload 同形(跨 tsconfig 不直接 import,结构兼容即可)。
interface NtfItem {
  id: string;
  kind: "info" | "success" | "error";
  text: string;
  title?: string;
  description?: string;
  iconName?: string;
  duration?: number;
}

// 外部窗体默认停留更久(用户可能不在应用前);payload.duration>0 优先。
const DEFAULT_EXTERNAL_DURATION = 5000;

function NotificationWindow(): React.ReactElement {
  const { t } = useTranslation("common");
  const api = typeof window !== "undefined" ? window.desktopAPI : undefined;
  const [items, setItems] = useState<NtfItem[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: string) => {
    setItems((list) => list.filter((n) => n.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  useEffect(() => {
    if (!api?.notification) return;
    const offPush = api.notification.onPush((p) => {
      setItems((list) => (list.some((n) => n.id === p.id) ? list : [...list, p]));
      const dur = p.duration && p.duration > 0 ? p.duration : DEFAULT_EXTERNAL_DURATION;
      const existing = timers.current.get(p.id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        p.id,
        setTimeout(() => remove(p.id), dur),
      );
    });
    const offClear = api.notification.onClear(() => {
      for (const tm of timers.current.values()) clearTimeout(tm);
      timers.current.clear();
      setItems([]);
    });
    // 主窗切语言 → 本窗体(独立 i18next 单例)随之重译。
    const offLocale = api.personal?.onLocaleChange?.((locale) => void changeLanguage(locale));
    return () => {
      offPush();
      offClear();
      offLocale?.();
    };
  }, [api, remove]);

  // 实测内容高度上报:空栈上报 0(主进程据此隐藏窗口),否则紧贴内容定位右上角。
  useLayoutEffect(() => {
    if (!api?.notification) return;
    const h = items.length === 0 ? 0 : (rootRef.current?.scrollHeight ?? 0) + 2;
    api.notification.resize(h);
  }, [items, api]);

  return (
    <div className="ntf-root" ref={rootRef}>
      {items.map((n) => (
        <NotificationCard
          key={n.id}
          kind={n.kind}
          text={n.text}
          title={n.title}
          description={n.description}
          iconName={n.iconName}
          closeLabel={t("toast.closeLabel")}
          onClose={() => remove(n.id)}
        />
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<NotificationWindow />);
