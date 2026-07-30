// 扩展市场面板（U6）渲染与交互:来源确认门、信任门 + 下一轮生效徽标、装≠启用、失踪态、空态/降级。
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePersonalStore,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_PI_EXTENSIONS,
  type DesktopBridge,
  type InstalledExtensionRecord,
} from "@cortex-work/core";
import { ExtensionPanel } from "./ExtensionPanel";

const rec = (ref: string, path: string): InstalledExtensionRecord => ({
  ref,
  scope: "global",
  sourceRef: ref,
  origin: ref.split(":")[0] ?? "npm",
  installedAt: 1,
  path,
});
function seed(installed: InstalledExtensionRecord[] = [], enabled: string[] = [], trusted: string[] = []): void {
  usePersonalStore.setState({
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piExtensions: { ...DEFAULT_PI_EXTENSIONS, installed, enabled, trusted } },
  });
}
function bridgeWith(over: Partial<DesktopBridge>): DesktopBridge {
  return {
    piExtList: vi.fn(async () => []),
    piExtInstall: vi.fn(async () => ({ ok: true, ref: "npm:a", sourceRef: "npm:a", origin: "npm", path: "/e/a" })),
    piExtRemove: vi.fn(async () => ({ ok: true })),
    ...over,
  } as unknown as DesktopBridge;
}
const extCfg = () => usePersonalStore.getState().generalSettings.piExtensions!;

beforeEach(() => seed([]));
afterEach(() => cleanup());

describe("ExtensionPanel", () => {
  it("空态:无已装扩展 → 引导安装", async () => {
    render(<ExtensionPanel bridge={bridgeWith({ piExtList: vi.fn(async () => []) })} />);
    expect(await screen.findByText("还没有已装扩展")).toBeTruthy();
  });

  it("bridge 无 piExtList（web/旧壳）→ 降级空态", () => {
    render(<ExtensionPanel bridge={{} as DesktopBridge} />);
    expect(screen.getByText(/当前环境不支持扩展安装/)).toBeTruthy();
  });

  it("安装:输入 ref → 来源确认门 → 确认后调 piExtInstall 并记录(装≠启用)", async () => {
    const bridge = bridgeWith({ piExtList: vi.fn(async () => ["/e/a"]) });
    render(<ExtensionPanel bridge={bridge} />);
    await screen.findByText("还没有已装扩展");
    fireEvent.change(screen.getByLabelText("安装扩展 ref"), { target: { value: "npm:a" } });
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    // 来源确认门出现:含「将下载并执行第三方代码」告知。
    expect(screen.getByText(/下载并安装第三方扩展/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    await waitFor(() => expect(bridge.piExtInstall).toHaveBeenCalledWith({ sourceRef: "npm:a" }));
    expect(extCfg().installed).toHaveLength(1);
    expect(extCfg().enabled).toEqual([]); // 装≠启用
    expect(await screen.findByText("npm:a")).toBeTruthy();
    expect(screen.getByText("已安装·未启用")).toBeTruthy();
  });

  it("来源确认门:取消 → 不安装", async () => {
    const bridge = bridgeWith({});
    render(<ExtensionPanel bridge={bridge} />);
    await screen.findByText("还没有已装扩展");
    fireEvent.change(screen.getByLabelText("安装扩展 ref"), { target: { value: "npm:a" } });
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(bridge.piExtInstall).not.toHaveBeenCalled();
  });

  it("启用:信任门确认 → 写启用+信任,显示「下一轮对话生效」徽标", async () => {
    seed([rec("npm:a", "/e/a")]);
    render(<ExtensionPanel bridge={bridgeWith({ piExtList: vi.fn(async () => ["/e/a"]) })} />);
    await screen.findByText("npm:a");
    fireEvent.click(screen.getByRole("button", { name: "信任并启用" })); // 卡片按钮
    const dialog = screen.getByRole("dialog", { name: "信任并启用扩展" });
    expect(within(dialog).getByText(/每一轮 pi 会话中执行/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "信任并启用" })); // 门内确认
    expect(extCfg().enabled).toEqual(["global:npm:a"]);
    expect(extCfg().trusted).toEqual(["global:npm:a"]);
    await waitFor(() => expect(screen.getByText("下一轮对话生效")).toBeTruthy());
  });

  it("禁用:已启用项点禁用 → 移出启用集", async () => {
    seed([rec("npm:a", "/e/a")], ["global:npm:a"], ["global:npm:a"]);
    render(<ExtensionPanel bridge={bridgeWith({ piExtList: vi.fn(async () => ["/e/a"]) })} />);
    await screen.findByText("npm:a");
    fireEvent.click(screen.getByRole("button", { name: "禁用" }));
    expect(extCfg().enabled).toEqual([]);
  });

  it("失踪态:store 有记录但 pi list 无该 path → 已失踪 + 移除记录", async () => {
    seed([rec("npm:gone", "/e/gone")], ["global:npm:gone"], ["global:npm:gone"]);
    render(<ExtensionPanel bridge={bridgeWith({ piExtList: vi.fn(async () => []) })} />);
    expect(await screen.findByText("已失踪")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除记录" }));
    await waitFor(() => expect(extCfg().installed).toEqual([]));
  });

  it("卸载:在用扩展确认门提示先停用,确认后调 piExtRemove", async () => {
    seed([rec("npm:a", "/e/a")], ["global:npm:a"], ["global:npm:a"]);
    const bridge = bridgeWith({ piExtList: vi.fn(async () => ["/e/a"]) });
    render(<ExtensionPanel bridge={bridge} />);
    await screen.findByText("npm:a");
    fireEvent.click(screen.getByRole("button", { name: "卸载" }));
    const dialog = screen.getByRole("dialog", { name: "卸载扩展" });
    expect(within(dialog).getByText(/将先停用/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认卸载" }));
    await waitFor(() => expect(bridge.piExtRemove).toHaveBeenCalledWith({ sourceRef: "npm:a" }));
  });
});
