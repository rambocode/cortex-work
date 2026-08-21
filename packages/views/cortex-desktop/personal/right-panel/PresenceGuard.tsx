// 面板「空态自动收起」的宿主执行体。descriptor.usePresence 是自定义 hook,不能在宿主
// 组件体内按当前面板条件调用（切面板会改变 Hook 调用序列）——包进这个 keyed 子组件:
// 宿主以 <PresenceGuard key={desc.id}> 渲染,换面板 = 整组件重挂载,每个实例内序列恒定。
// 只跑当前活跃面板的 presence（与旧 PersonalRightPanel 内联 effect 语义一致）。

import { useEffect } from "react";

export function PresenceGuard({
  usePresence,
  onAbsent,
}: {
  usePresence: () => boolean;
  onAbsent: () => void;
}) {
  const present = usePresence();
  useEffect(() => {
    if (!present) onAbsent();
  }, [present, onAbsent]);
  return null;
}
