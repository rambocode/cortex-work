// 用户消息折叠的抗振荡回归(白屏事故):若 scrollHeight 随折叠态变化(实测根因:限高下
// flex 压缩含 overflow 的子块),单阈值判定会在 useLayoutEffect 里同步振荡,触发 React
// "Maximum update depth exceeded" 并因无错误边界整树卸载白屏。本测试用 scrollHeight
// getter 模拟这种病态布局:折叠态 260(阈下)、展开态 300(阈上),断言组件收敛不炸。
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UserMessageContent } from "./userMessageCollapse";

const SCROLL_HEIGHT_DESC = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");

function installOscillatingScrollHeight(): void {
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      if (!this.classList.contains("pw-user-message-content")) return 0;
      // 病态布局模拟:折叠限高把内容压回阈下,撤销限高又弹回阈上——单阈值实现会无限振荡。
      return this.parentElement?.classList.contains("is-collapsed") ? 260 : 300;
    },
  });
}

afterEach(() => {
  if (SCROLL_HEIGHT_DESC) Object.defineProperty(Element.prototype, "scrollHeight", SCROLL_HEIGHT_DESC);
});

describe("UserMessageContent(抗振荡)", () => {
  it("scrollHeight 随折叠态回落到阈下时仍收敛为折叠态,不触发 Maximum update depth", () => {
    installOscillatingScrollHeight();
    // 旧实现在这里同步振荡直到 React 熔断抛错;滞回实现应正常渲染并保持折叠。
    const { container } = render(
      <UserMessageContent>
        <p>很长的用户消息</p>
      </UserMessageContent>,
    );
    const shell = container.querySelector(".pw-user-message-shell");
    expect(shell?.classList.contains("is-collapsed")).toBe(true);
    expect(container.querySelector(".pw-user-message-toggle")).not.toBeNull();
  });

  it("内容明显低于阈值时不折叠、不渲染切换按钮", () => {
    // jsdom 默认 scrollHeight=0(阈下),走不折叠分支。
    const { container } = render(
      <UserMessageContent>
        <p>短消息</p>
      </UserMessageContent>,
    );
    expect(container.querySelector(".pw-user-message-toggle")).toBeNull();
  });
});
