// pi 扩展市场编排（U5）单测:decorateExtensions(叠加/失踪/排序)、install(成功记溯源/失败不记/无桥)、
// uninstall(在用先自动禁用 C2 / remove 失败保留记录)、enable(过信任门)/disable。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { InstalledExtensionRecord, PersistedState } from "../desktop/types";
import { DEFAULT_GENERAL_SETTINGS, DEFAULT_PI_EXTENSIONS } from "../desktop/types";
import { usePersonalStore } from "../store/personal";
import {
  decorateExtensions,
  listExtensions,
  installExtension,
  uninstallExtension,
  enableExtension,
  disableExtension,
} from "./extensions";

const base: PersistedState = { version: 1, projects: [], sessions: [] };
const rec = (ref: string, path: string): InstalledExtensionRecord => ({
  ref,
  scope: "global",
  sourceRef: ref,
  origin: ref.split(":")[0] ?? "npm",
  installedAt: 1,
  path,
});
function hydrateExt(installed: InstalledExtensionRecord[], enabled: string[] = [], trusted: string[] = []): void {
  usePersonalStore.getState().hydrate({
    ...base,
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piExtensions: { ...DEFAULT_PI_EXTENSIONS, installed, enabled, trusted } },
  });
}
const extCfg = () => usePersonalStore.getState().generalSettings.piExtensions!;

beforeEach(() => hydrateExt([]));

describe("decorateExtensions", () => {
  it("叠加 enabled/trusted;present 路径给 path", () => {
    const rows = decorateExtensions([rec("npm:a", "/e/a")], ["/e/a"], ["global:npm:a"], ["global:npm:a"]);
    expect(rows[0]).toMatchObject({ ref: "npm:a", path: "/e/a", enabled: true, trusted: true, missing: false });
  });
  it("记录在 store 但 pi list 无该 path → missing,path 缺,保留启用记录", () => {
    const rows = decorateExtensions([rec("npm:a", "/e/a")], [], ["global:npm:a"], []);
    expect(rows[0]).toMatchObject({ missing: true, path: undefined, enabled: true });
  });
  it("排序:启用优先,再 installedAt 倒序", () => {
    const recs = [
      { ...rec("npm:old", "/e/old"), installedAt: 1 },
      { ...rec("npm:newdis", "/e/nd"), installedAt: 9 },
      { ...rec("npm:en", "/e/en"), installedAt: 5 },
    ];
    const rows = decorateExtensions(recs, ["/e/old", "/e/nd", "/e/en"], ["global:npm:en"], []);
    expect(rows.map((r) => r.ref)).toEqual(["npm:en", "npm:newdis", "npm:old"]);
  });
});

describe("listExtensions", () => {
  it("bridge 无 piExtList → []", async () => {
    expect(await listExtensions({} as DesktopBridge)).toEqual([]);
  });
  it("piExtList 抛错 → 降级 []", async () => {
    const bridge = { piExtList: vi.fn(async () => { throw new Error("boom"); }) } as unknown as DesktopBridge;
    expect(await listExtensions(bridge)).toEqual([]);
  });
  it("叠加 store 后返回富列表", async () => {
    hydrateExt([rec("npm:a", "/e/a")], ["global:npm:a"], ["global:npm:a"]);
    const bridge = { piExtList: vi.fn(async () => ["/e/a"]) } as unknown as DesktopBridge;
    const rows = await listExtensions(bridge);
    expect(rows[0]).toMatchObject({ ref: "npm:a", enabled: true, missing: false });
  });
});

describe("installExtension", () => {
  it("成功 → 记溯源(含 path)入 store,不动启用集（装≠启用）", async () => {
    const bridge = {
      piExtInstall: vi.fn(async () => ({ ok: true, ref: "npm:a", sourceRef: "npm:a", origin: "npm", path: "/e/a" })),
    } as unknown as DesktopBridge;
    const r = await installExtension(bridge, "npm:a", "global", 123);
    expect(r.ok).toBe(true);
    expect(extCfg().installed).toEqual([
      { ref: "npm:a", scope: "global", sourceRef: "npm:a", origin: "npm", version: undefined, installedAt: 123, path: "/e/a" },
    ]);
    expect(extCfg().enabled).toEqual([]); // 装≠启用
  });
  it("失败 → 不记溯源", async () => {
    const bridge = { piExtInstall: vi.fn(async () => ({ ok: false, error: "404" })) } as unknown as DesktopBridge;
    const r = await installExtension(bridge, "npm:bad");
    expect(r.ok).toBe(false);
    expect(extCfg().installed).toEqual([]);
  });
  it("无 piExtInstall → ok:false 不抛", async () => {
    const r = await installExtension({} as DesktopBridge, "npm:a");
    expect(r.ok).toBe(false);
  });
});

describe("uninstallExtension", () => {
  it("在用扩展 → 先自动禁用(C2) 再 remove,成功清记录", async () => {
    hydrateExt([rec("npm:a", "/e/a")], ["global:npm:a"], ["global:npm:a"]);
    const order: string[] = [];
    const bridge = {
      piExtRemove: vi.fn(async () => {
        order.push(`enabledAtRemove=${extCfg().enabled.length}`);
        return { ok: true };
      }),
    } as unknown as DesktopBridge;
    const r = await uninstallExtension(bridge, "global", "npm:a", "npm:a");
    expect(r.ok).toBe(true);
    expect(order).toEqual(["enabledAtRemove=0"]); // remove 前已自动禁用
    expect(extCfg().installed).toEqual([]);
    expect(extCfg().enabled).toEqual([]);
    expect(extCfg().trusted).toEqual([]);
  });
  it("remove 失败 → 已自动禁用但保留溯源记录(可重试)", async () => {
    hydrateExt([rec("npm:a", "/e/a")], ["global:npm:a"], ["global:npm:a"]);
    const bridge = { piExtRemove: vi.fn(async () => ({ ok: false, error: "占用中" })) } as unknown as DesktopBridge;
    const r = await uninstallExtension(bridge, "global", "npm:a", "npm:a");
    expect(r.ok).toBe(false);
    expect(extCfg().enabled).toEqual([]); // 已自动禁用
    expect(extCfg().installed).toHaveLength(1); // 记录保留
  });
});

describe("enable/disable", () => {
  it("enableExtension 同时过信任门 + 入启用集（R6）", () => {
    hydrateExt([rec("npm:a", "/e/a")]);
    enableExtension("global", "npm:a");
    expect(extCfg().enabled).toEqual(["global:npm:a"]);
    expect(extCfg().trusted).toEqual(["global:npm:a"]);
  });
  it("disableExtension 仅移出启用集,保留信任", () => {
    hydrateExt([rec("npm:a", "/e/a")], ["global:npm:a"], ["global:npm:a"]);
    disableExtension("global", "npm:a");
    expect(extCfg().enabled).toEqual([]);
    expect(extCfg().trusted).toEqual(["global:npm:a"]);
  });
});
