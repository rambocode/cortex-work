import { beforeEach, describe, expect, it, vi } from "vitest";

const { existsSync } = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
}));
vi.mock("node:fs", () => ({ existsSync }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/app" },
}));

import { resolveSenseVoiceSidecar } from "./locate";

describe("resolveSenseVoiceSidecar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CORTEX_SENSEVOICE_SIDECAR;
  });

  it("优先使用显式环境变量覆盖", () => {
    process.env.CORTEX_SENSEVOICE_SIDECAR = "/custom/sidecar";
    existsSync.mockImplementation((path) => path === "/custom/sidecar");
    expect(resolveSenseVoiceSidecar()).toMatchObject({ command: "/custom/sidecar" });
  });

  it("开发态按当前平台与架构查找 resources/sensevoice", () => {
    existsSync.mockImplementation((path) => path.includes(`/sensevoice/${process.platform}-${process.arch}/`));
    const result = resolveSenseVoiceSidecar();
    expect(result.command).toContain(`/sensevoice/${process.platform}-${process.arch}/`);
  });

  it("不支持的平台给出明确错误", () => {
    existsSync.mockReturnValue(false);
    expect(() => resolveSenseVoiceSidecar()).toThrow(/找不到 SenseVoice sidecar/);
  });
});
