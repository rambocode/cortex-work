import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { usePersonalStore } from "@cortex-work/core";

import { BrowserControlSection } from "./BrowserControlSection";

function setBC(bc: { enabled: boolean; cdpEnabled: boolean; approvedOrigins: string[] }) {
  usePersonalStore.setState((s) => ({ generalSettings: { ...s.generalSettings, browserControl: bc } }));
}

describe("BrowserControlSection（U8）", () => {
  beforeEach(() => setBC({ enabled: false, cdpEnabled: false, approvedOrigins: [] }));

  it("总开关写 store", () => {
    render(<BrowserControlSection />);
    fireEvent.click(screen.getByLabelText("允许 agent 控制内置浏览器"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.enabled).toBe(true);
  });

  it("master 关时 CDP 开关禁用", () => {
    render(<BrowserControlSection />);
    expect(screen.getByLabelText("完整 CDP 访问")).toBeDisabled();
  });

  it("CDP 开关需确认再写 cdpEnabled", () => {
    setBC({ enabled: true, cdpEnabled: false, approvedOrigins: [] });
    render(<BrowserControlSection />);
    fireEvent.click(screen.getByLabelText("完整 CDP 访问"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.cdpEnabled).toBe(false); // 仅显示确认
    fireEvent.click(screen.getByText("我已了解风险,启用"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.cdpEnabled).toBe(true);
  });

  it("添加合法 origin;拒非法并提示", () => {
    setBC({ enabled: true, cdpEnabled: false, approvedOrigins: [] });
    render(<BrowserControlSection />);
    const input = screen.getByLabelText("添加授权 origin");
    fireEvent.change(input, { target: { value: "not a url" } });
    fireEvent.click(screen.getByText("添加"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.approvedOrigins).toEqual([]);
    expect(screen.getByText(/完整 origin/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "https://example.com/a" } });
    fireEvent.click(screen.getByText("添加"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.approvedOrigins).toEqual(["https://example.com"]);
  });

  it("移除 origin", () => {
    setBC({ enabled: true, cdpEnabled: false, approvedOrigins: ["https://x.com"] });
    render(<BrowserControlSection />);
    fireEvent.click(screen.getByText("移除"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.approvedOrigins).toEqual([]);
  });
});
