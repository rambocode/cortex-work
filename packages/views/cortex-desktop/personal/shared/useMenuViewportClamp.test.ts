// useMenuViewportClamp 单测：验证弹层打开时按实际 rect 做视口收敛的四类场景
// （不溢出 / 溢出右缘 / 溢出左缘 / 溢出下缘）与关闭时清空位移。
// jsdom 无真实布局,用 mock getBoundingClientRect 构造溢出场景。
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { useMenuViewportClamp } from "./useMenuViewportClamp";

// 探针组件:开关受控,菜单节点的 rect 由测试注入。
function Probe({ open, rect }: { open: boolean; rect: Partial<DOMRect> }) {
  const { menuRef, clampStyle } = useMenuViewportClamp(open);
  return open
    ? createElement("div", {
        "data-testid": "menu",
        ref: (el: HTMLDivElement | null) => {
          menuRef.current = el;
          if (el) {
            el.getBoundingClientRect = () =>
              ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...rect }) as DOMRect;
          }
        },
        style: clampStyle,
      })
    : null;
}

// jsdom 默认视口 1024x768。
describe("useMenuViewportClamp", () => {
  it("菜单完全在视口内时不加位移", () => {
    const { getByTestId } = render(
      createElement(Probe, { open: true, rect: { left: 100, right: 300, top: 40, bottom: 240 } }),
    );
    expect(getByTestId("menu").style.transform).toBe("");
  });

  it("溢出右缘时向左平移回视口(留 8px 边距)", () => {
    const { getByTestId } = render(
      createElement(Probe, { open: true, rect: { left: 900, right: 1100, top: 40, bottom: 240 } }),
    );
    // 1100 - (1024 - 8) = 84 → 左移 84px
    expect(getByTestId("menu").style.transform).toBe("translate(-84px, 0px)");
  });

  it("溢出左缘时向右平移回视口", () => {
    const { getByTestId } = render(
      createElement(Probe, { open: true, rect: { left: -60, right: 140, top: 40, bottom: 240 } }),
    );
    // 8 - (-60) = 68 → 右移 68px
    expect(getByTestId("menu").style.transform).toBe("translate(68px, 0px)");
  });

  it("溢出下缘时向上平移回视口", () => {
    const { getByTestId } = render(
      createElement(Probe, { open: true, rect: { left: 100, right: 300, top: 700, bottom: 900 } }),
    );
    // 900 - (768 - 8) = 140 → 上移 140px
    expect(getByTestId("menu").style.transform).toBe("translate(0px, -140px)");
  });

  it("重新打开时按新 rect 重算(关闭会清空上次位移)", () => {
    const { getByTestId, rerender } = render(
      createElement(Probe, { open: true, rect: { left: 900, right: 1100, top: 40, bottom: 240 } }),
    );
    expect(getByTestId("menu").style.transform).toBe("translate(-84px, 0px)");
    rerender(createElement(Probe, { open: false, rect: {} }));
    rerender(createElement(Probe, { open: true, rect: { left: 100, right: 300, top: 40, bottom: 240 } }));
    expect(getByTestId("menu").style.transform).toBe("");
  });
});
