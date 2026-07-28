// 菜单垂直自动翻转:默认向下弹,菜单挂载后于绘制前实测底缘,溢出视口(留 8px 余量)即翻为
// 向上弹,收起时复位。解决「落地页 composer 居中、下方空间大 → 下弹自然;历史会话页 composer
// 贴底、下弹被裁」的场景差异——方向不再写死,同一组件两处都合适。
// 测量与改类同帧完成(useLayoutEffect),无「先下后上」的可见闪烁。与 ModelThinkingPill 的
// 二级 flyout 水平翻左(pw-mt-sub--left)是同一套取舍,分属两个维度、互不干扰。

import { useLayoutEffect, useRef, useState } from "react";

export function useAutoFlipUp(open: boolean) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(false);

  useLayoutEffect(() => {
    if (!open) {
      setFlipUp(false);
      return;
    }
    const el = menuRef.current;
    setFlipUp(!!el && el.getBoundingClientRect().bottom > window.innerHeight - 8);
  }, [open]);

  return { menuRef, flipUp };
}
