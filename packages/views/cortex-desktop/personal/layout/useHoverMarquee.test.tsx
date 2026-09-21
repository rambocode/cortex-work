// useHoverMarquee:只有被截断的标题悬停时才滚动,移开复位。
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHoverMarquee } from "./useHoverMarquee";

// 测试用标题:把 hook 接到一个行容器上。
function Title({ text }: { text: string }) {
  const m = useHoverMarquee();
  return (
    <div data-testid="row" onMouseEnter={m.start} onMouseLeave={m.stop}>
      <span data-testid="title" ref={m.containerRef} className={m.scrolling ? "is-scrolling" : ""} style={m.style}>
        {text}
      </span>
    </div>
  );
}

// jsdom 不做布局:手动给截断容器设定内容宽 / 可视宽。
function setWidths(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

beforeEach(() => {
  // 同步执行 rAF 回调,免去等帧。
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("useHoverMarquee", () => {
  it("标题溢出时悬停滚动(平移距离 = 溢出量),移开复位", () => {
    const { getByTestId } = render(<Title text="很长很长的标题" />);
    const title = getByTestId("title");
    setWidths(title, 300, 180);
    act(() => {
      fireEvent.mouseEnter(getByTestId("row"));
    });
    expect(title.className).toContain("is-scrolling");
    expect(title.style.getPropertyValue("--pw-marquee-shift")).toBe("-120px");
    act(() => {
      fireEvent.mouseLeave(getByTestId("row"));
    });
    expect(title.className).not.toContain("is-scrolling");
  });

  it("标题未溢出时不滚动", () => {
    const { getByTestId } = render(<Title text="短标题" />);
    const title = getByTestId("title");
    setWidths(title, 100, 180);
    act(() => {
      fireEvent.mouseEnter(getByTestId("row"));
    });
    expect(title.className).not.toContain("is-scrolling");
  });
});
