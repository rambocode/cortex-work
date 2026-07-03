import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let isPackaged = false;

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return isPackaged;
    },
    getAppPath: () => "/fake/apps/desktop",
  },
}));

import { resolveReplyHelperBinary } from "./helper-locate";

const origResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

beforeEach(() => {
  isPackaged = false;
  Object.defineProperty(process, "resourcesPath", {
    value: "/fake/Contents/Resources",
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  if (origResourcesPath !== undefined) {
    Object.defineProperty(process, "resourcesPath", {
      value: origResourcesPath,
      writable: true,
      configurable: true,
    });
  }
});

describe("resolveReplyHelperBinary", () => {
  it("dev 态指向品牌化的 Cortex_Helper 二进制", () => {
    expect(resolveReplyHelperBinary()).toBe("/fake/apps/desktop/resources/Cortex_Helper/Cortex_Helper");
  });

  it("打包态指向 extraResources 内的 Cortex_Helper 二进制", () => {
    isPackaged = true;
    expect(resolveReplyHelperBinary()).toBe("/fake/Contents/Resources/Cortex_Helper/Cortex_Helper");
  });
});
