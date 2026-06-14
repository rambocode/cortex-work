import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingHero } from "./LandingHero";

afterEach(cleanup);

describe("LandingHero", () => {
  it("渲染标题、副标题与吉祥物图（不依赖 props/bridge）", () => {
    render(<LandingHero />);
    expect(screen.getByText("开始你的智能体节奏")).toBeTruthy();
    expect(screen.getByText(/按天累计的用量日历/)).toBeTruthy();
    const mascot = screen.getByAltText("Cortex 吉祥物") as HTMLImageElement;
    expect(mascot.getAttribute("src")).toBeTruthy();
  });
});
