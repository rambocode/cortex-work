// pushSettings 跨窗口镜像同步（窄通道）。
// 背景：项目管理独立窗口刻意不挂 usePersonalPersistence（防陈旧全量快照 clobber 主窗口写入），
// 其 personal store 从不 hydrate → pushSettings 恒为默认空对象，导致任务提醒字段的
// 「未开启系统通知」警告在该窗口永远误报。本 hook 让任意窗口保持 pushSettings 镜像新鲜：
//   1) store 未 hydrate 时（二级窗口），mount 后从 main 权威态一次性拉取；
//   2) 订阅 main 的变更广播（任一窗口改动开关都会推给所有窗口）。
// 只写 pushSettings 单切片、且内容相等时跳过写入——主窗口收到自己发起的变更回声时
// 不产生新引用，故不会触发其全量持久化订阅，杜绝 save→广播→save 回环。

import { useEffect } from "react";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import type { PushSettings } from "./types";

// 应用一份来自 main 的权威 pushSettings 快照（导出供单测）。内容相等则跳过写入（防回环）。
export function applyPushSettingsSnapshot(next: PushSettings): void {
  const cur = usePersonalStore.getState().pushSettings;
  if (JSON.stringify(cur) === JSON.stringify(next)) return;
  usePersonalStore.setState({ pushSettings: next });
}

export function usePushSettingsSync(): void {
  const bridge = useDesktopBridge();

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    // 未 hydrate（本窗口不挂全量持久化）→ 从 main 补一次初始值；已 hydrate 的主窗口无需重复拉取。
    // loadState 用可选调用：契约上必有，但测试里的部分 mock 桥可能缺 → 空转而非抛错。
    if (!usePersonalStore.getState().hydrated) {
      bridge
        .loadState?.()
        .then((s) => {
          if (!cancelled) applyPushSettingsSnapshot(s.pushSettings ?? {});
        })
        .catch(() => {});
    }
    const unsub = bridge.onPushSettingsChanged?.((push) => applyPushSettingsSnapshot(push ?? {})) ?? (() => {});
    return () => {
      cancelled = true;
      unsub();
    };
  }, [bridge]);
}
