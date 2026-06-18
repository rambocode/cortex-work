import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingHero } from "./LandingHero";

afterEach(cleanup);

describe("LandingHero", () => {
  it("渲染按时段问候标题、副标题与水母 SVG（不依赖 props/bridge）", () => {
    const { container } = render(<LandingHero />);
    // 标题为「{时段问候}，开始你的智能体节奏」,问候随时间变化,故只断言固定后半句。
    expect(screen.getByText(/开始你的智能体节奏/)).toBeTruthy();
    expect(screen.getByText(/输入一句话/)).toBeTruthy();
    // 水母为装饰性 SVG（aria-hidden）,按结构断言存在。
    expect(container.querySelector("svg.pw-hero-jelly")).toBeTruthy();
  });
});
