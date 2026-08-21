// auth-config 单测：序列化/反序列化纯函数（缺字段容错、解密失败 token=undefined、加密不可用不落盘 token）
// + IPC handler 全链路 round-trip（set → get → clear，走 mock safeStorage 与临时 userData）。
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

// mock electron：ipcMain 捕获 handler；app.getPath 指向临时目录；safeStorage 用可逆的
// "enc:" 前缀 + base64 模拟加密（默认可用，个别用例内切换不可用）。
let encAvailable = true;
let userDataDir = "";
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) },
  app: { getPath: (_name: string) => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => encAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => {
      const raw = b.toString("utf8");
      if (!raw.startsWith("enc:")) throw new Error("bad ciphertext");
      return raw.slice(4);
    },
  },
}));

import {
  serializeAuthConfig,
  deserializeAuthConfig,
  registerAuthConfigHandlers,
  type AuthConfig,
} from "./auth-config";

// 测试用可逆加解密（与 mock safeStorage 语义一致，但作为注入参数直接喂纯函数）。
const enc = (plain: string): string | null => `enc:${plain}`;
const encUnavailable = (): string | null => null;
const dec = (b64: string | undefined): string | undefined =>
  b64 && b64.startsWith("enc:") ? b64.slice(4) : undefined;

describe("serializeAuthConfig", () => {
  it("保留明文字段并加密 token", () => {
    const cfg: AuthConfig = {
      baseUrl: "http://127.0.0.1:8080",
      workspaceId: "ws-1",
      workspaceSlug: "team",
      userName: "阿伟",
      userEmail: "a@b.com",
      token: "jwt-abc",
    };
    const file = serializeAuthConfig(cfg, enc) as Record<string, unknown>;
    expect(file.baseUrl).toBe("http://127.0.0.1:8080");
    expect(file.userName).toBe("阿伟");
    expect(file.encToken).toBe("enc:jwt-abc");
    // 明文 token 绝不落盘。
    expect(file).not.toHaveProperty("token");
  });

  it("加密不可用时丢弃 token（不落盘明文）", () => {
    const file = serializeAuthConfig(
      { baseUrl: "http://x", token: "jwt-abc" },
      encUnavailable,
    ) as Record<string, unknown>;
    expect(file.encToken).toBeUndefined();
    expect(file).not.toHaveProperty("token");
  });

  it("无 token 时不产出 encToken", () => {
    const file = serializeAuthConfig({ baseUrl: "http://x" }, enc) as Record<string, unknown>;
    expect(file.encToken).toBeUndefined();
  });
});

describe("deserializeAuthConfig", () => {
  it("往返还原完整配置（含解密 token）", () => {
    const file = serializeAuthConfig(
      { baseUrl: "http://x", workspaceId: "ws-1", token: "jwt-abc" },
      enc,
    );
    const back = deserializeAuthConfig(file, dec);
    expect(back).toEqual({
      baseUrl: "http://x",
      workspaceId: "ws-1",
      workspaceSlug: undefined,
      userName: undefined,
      userEmail: undefined,
      token: "jwt-abc",
    });
  });

  it("非对象 / 缺 baseUrl → null", () => {
    expect(deserializeAuthConfig(null, dec)).toBeNull();
    expect(deserializeAuthConfig("str", dec)).toBeNull();
    expect(deserializeAuthConfig({}, dec)).toBeNull();
    expect(deserializeAuthConfig({ workspaceId: "ws-1" }, dec)).toBeNull();
  });

  it("缺字段容错为 undefined", () => {
    const back = deserializeAuthConfig({ baseUrl: "http://x" }, dec);
    expect(back).toEqual({
      baseUrl: "http://x",
      workspaceId: undefined,
      workspaceSlug: undefined,
      userName: undefined,
      userEmail: undefined,
      token: undefined,
    });
  });

  it("解密失败 → token undefined（不阻断其余字段）", () => {
    const back = deserializeAuthConfig({ baseUrl: "http://x", encToken: "corrupt" }, dec);
    expect(back?.baseUrl).toBe("http://x");
    expect(back?.token).toBeUndefined();
  });
});

describe("registerAuthConfigHandlers (round-trip)", () => {
  beforeEach(() => {
    handlers.clear();
    encAvailable = true;
    userDataDir = mkdtempSync(join(tmpdir(), "auth-config-"));
    registerAuthConfigHandlers();
  });
  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("注册三条 channel", () => {
    expect(handlers.has("auth:get-config")).toBe(true);
    expect(handlers.has("auth:set-config")).toBe(true);
    expect(handlers.has("auth:clear-config")).toBe(true);
  });

  it("无配置时 get 返回 null", async () => {
    expect(await handlers.get("auth:get-config")!()).toBeNull();
  });

  it("set → get 往返一致（token 经加密落盘后解密还原）", async () => {
    const cfg: AuthConfig = {
      baseUrl: "http://127.0.0.1:8080",
      workspaceId: "ws-1",
      workspaceSlug: "team",
      userName: "阿伟",
      userEmail: "a@b.com",
      token: "jwt-abc",
    };
    await handlers.get("auth:set-config")!({}, cfg);
    expect(await handlers.get("auth:get-config")!()).toEqual(cfg);
  });

  it("clear 后 get 返回 null", async () => {
    await handlers.get("auth:set-config")!({}, { baseUrl: "http://x", token: "t" });
    await handlers.get("auth:clear-config")!();
    expect(await handlers.get("auth:get-config")!()).toBeNull();
    expect(existsSync(join(userDataDir, "auth-config.json"))).toBe(false);
  });

  it("加密不可用：token 不落盘，get 回读 token undefined 但其余字段完整", async () => {
    encAvailable = false;
    await handlers.get("auth:set-config")!({}, { baseUrl: "http://x", workspaceId: "ws-1", token: "t" });
    const back = (await handlers.get("auth:get-config")!()) as AuthConfig;
    expect(back.baseUrl).toBe("http://x");
    expect(back.workspaceId).toBe("ws-1");
    expect(back.token).toBeUndefined();
  });
});
