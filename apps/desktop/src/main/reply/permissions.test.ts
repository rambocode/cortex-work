import { describe, it, expect, vi } from "vitest";
import {
  mapAuthStatus,
  parseHelperPermissions,
  unknownPermissions,
  queryReplyPermissions,
} from "./permissions";

describe("mapAuthStatus", () => {
  it("authorized / limited → granted", () => {
    expect(mapAuthStatus("authorized")).toBe("granted");
    expect(mapAuthStatus("limited")).toBe("granted");
  });
  it("denied / restricted → denied", () => {
    expect(mapAuthStatus("denied")).toBe("denied");
    expect(mapAuthStatus("restricted")).toBe("denied");
  });
  it("not determined / 未知 → notDetermined", () => {
    expect(mapAuthStatus("not determined")).toBe("notDetermined");
    expect(mapAuthStatus("weird")).toBe("notDetermined");
  });
});

describe("parseHelperPermissions", () => {
  it("规范三态收敛,缺失字段兜底 notDetermined", () => {
    const res = {
      ok: true,
      accessibility: "granted",
      screen: "denied",
      calendar: "notDetermined",
      microphone: "granted",
      // speech 缺失
    };
    expect(parseHelperPermissions(res)).toEqual({
      accessibility: "granted",
      screen: "denied",
      calendar: "notDetermined",
      microphone: "granted",
      speech: "notDetermined",
    });
  });
  it("非法值 → notDetermined", () => {
    expect(parseHelperPermissions({ accessibility: 123 }).accessibility).toBe("notDetermined");
  });
});

describe("queryReplyPermissions", () => {
  // 原生模块「加载失败」加载器:动态 import 抛错(模拟未安装 / ABI 不匹配)。
  const failingLoader = () => Promise.reject(new Error("MODULE_NOT_FOUND"));
  // 原生模块「可用」加载器:返回可控 getAuthStatus。
  const okLoader = (statuses: Record<string, string>) => () =>
    Promise.resolve({ getAuthStatus: (t: string) => statuses[t] ?? "not determined" });

  it("非 mac 平台直接全未决,不调 helper 兜底 / 不加载原生模块", async () => {
    const fallback = vi.fn();
    const loader = vi.fn();
    const perms = await queryReplyPermissions(fallback, "win32", loader);
    expect(perms).toEqual(unknownPermissions());
    expect(fallback).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });

  it("mac 上 node-mac-permissions 可用 → 直接用其结果,不调 helper", async () => {
    const fallback = vi.fn();
    const loader = okLoader({
      accessibility: "authorized",
      screen: "denied",
      calendar: "restricted",
      microphone: "authorized",
      "speech-recognition": "not determined",
    });
    const perms = await queryReplyPermissions(fallback, "darwin", loader);
    expect(fallback).not.toHaveBeenCalled();
    expect(perms).toEqual({
      accessibility: "granted",
      screen: "denied",
      calendar: "denied",
      microphone: "granted",
      speech: "notDetermined",
    });
  });

  it("mac 上 node-mac-permissions 不可用 → 回退 helper", async () => {
    const fallback = vi.fn().mockResolvedValue({
      ok: true,
      accessibility: "granted",
      screen: "granted",
      calendar: "denied",
      microphone: "granted",
      speech: "notDetermined",
    });
    const perms = await queryReplyPermissions(fallback, "darwin", failingLoader);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(perms.accessibility).toBe("granted");
    expect(perms.calendar).toBe("denied");
  });

  it("helper 返回 ok:false → 全未决", async () => {
    const fallback = vi.fn().mockResolvedValue({ ok: false, error: "x" });
    const perms = await queryReplyPermissions(fallback, "darwin", failingLoader);
    expect(perms).toEqual(unknownPermissions());
  });

  it("helper 抛错 → 全未决", async () => {
    const fallback = vi.fn().mockRejectedValue(new Error("spawn fail"));
    const perms = await queryReplyPermissions(fallback, "darwin", failingLoader);
    expect(perms).toEqual(unknownPermissions());
  });

  it("无 helper 兜底且 node 不可用 → 全未决", async () => {
    const perms = await queryReplyPermissions(undefined, "darwin", failingLoader);
    expect(perms).toEqual(unknownPermissions());
  });
});
