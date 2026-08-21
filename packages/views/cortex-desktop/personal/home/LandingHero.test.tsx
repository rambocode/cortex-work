import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import { LandingHero } from "./LandingHero";
import { pickEncouragement } from "./encouragements";

afterEach(cleanup);

describe("LandingHero", () => {
  it("无 bridge 时渲染静态激励文案（确定性回退;清爽化改版后无水母插画）", () => {
    // desktopBridge=null（web 端形态）→ useDailyEncouragement 返回 null → 回退静态池。
    const { container } = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
        <LandingHero />
      </CoreProvider>,
    );
    const expected = pickEncouragement(new Date());
    expect(container.querySelector(".pw-hero-title")?.textContent).toBe(expected.title);
    expect(container.querySelector(".pw-hero-sub")?.textContent).toBe(expected.sub);
    // 清爽化改版:水母 SVG 已随紫色主题一并退场,hero 只有文案。
    expect(container.querySelector("svg.pw-hero-jelly")).toBeNull();
  });
});
