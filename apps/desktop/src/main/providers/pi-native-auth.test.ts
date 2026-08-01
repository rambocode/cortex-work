// pi 原生凭据文件（auth.json）↔ Cortex 金库的 OAuth 同步回归测试。
//
// 事故背景：设置页登录只写金库，spawn 的 pi 二进制读自己的 auth.json——旧 token 留在
// 文件里导致「测试通过、会话 deactivated_workspace」。这里验证同步的四条硬规则：
// 金库新则推文件、文件新则导回金库、金库为空不复活/不误删、注销显式清文件。

import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "@earendil-works/pi-ai";

// 金库依赖 electron safeStorage，单测里整体 mock 掉，只验同步逻辑本身。
const readStoredCredential = vi.fn<(id: string) => Promise<Credential | undefined>>();
const modifyStoredCredential = vi.fn(
  async (_id: string, fn: (c: Credential | undefined) => Promise<Credential | undefined>) => fn(undefined),
);
vi.mock("./credentials", () => ({
  readStoredCredential: (id: string) => readStoredCredential(id),
  modifyStoredCredential: (id: string, fn: (c: Credential | undefined) => Promise<Credential | undefined>) =>
    modifyStoredCredential(id, fn),
}));

import { piNativeAuthPath, removeFromPiNativeStore, setPiNativeAuthPathForTest, syncOAuthWithPiNativeStore } from "./pi-native-auth";

const oauth = (expires: number, tag: string): Credential =>
  ({ type: "oauth", access: `at-${tag}`, refresh: `rt-${tag}`, expires }) as unknown as Credential;

function readFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(piNativeAuthPath(), "utf8")) as Record<string, unknown>;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-native-auth-"));
  setPiNativeAuthPathForTest(join(dir, "auth.json"));
  readStoredCredential.mockReset();
  modifyStoredCredential.mockClear();
});
afterEach(() => setPiNativeAuthPathForTest(null));

describe("syncOAuthWithPiNativeStore", () => {
  it("金库有、文件无 → 写入文件（0600），其余条目保留", async () => {
    writeFileSync(piNativeAuthPath(), JSON.stringify({ other: oauth(999, "other") }));
    readStoredCredential.mockResolvedValue(oauth(2000, "new"));
    await syncOAuthWithPiNativeStore("openai-codex");
    const file = readFile();
    expect((file["openai-codex"] as { access: string }).access).toBe("at-new");
    expect((file.other as { access: string }).access).toBe("at-other");
    // token 明文文件必须 0600（与 pi CLI 同权限）。
    expect(statSync(piNativeAuthPath()).mode & 0o777).toBe(0o600);
  });

  it("金库较新 → 覆盖文件里的旧 token（deactivated_workspace 事故的直接回归）", async () => {
    writeFileSync(piNativeAuthPath(), JSON.stringify({ "openai-codex": oauth(1000, "stale") }));
    readStoredCredential.mockResolvedValue(oauth(2000, "fresh"));
    await syncOAuthWithPiNativeStore("openai-codex");
    expect((readFile()["openai-codex"] as { access: string }).access).toBe("at-fresh");
    expect(modifyStoredCredential).not.toHaveBeenCalled();
  });

  it("文件较新（会话进程自己刷新过）→ 导回金库，不动文件", async () => {
    const fresher = oauth(3000, "session-refreshed");
    writeFileSync(piNativeAuthPath(), JSON.stringify({ "openai-codex": fresher }));
    readStoredCredential.mockResolvedValue(oauth(1000, "vault-stale"));
    await syncOAuthWithPiNativeStore("openai-codex");
    expect(modifyStoredCredential).toHaveBeenCalledTimes(1);
    const imported = await modifyStoredCredential.mock.results[0]!.value;
    expect((imported as { access: string }).access).toBe("at-session-refreshed");
    expect((readFile()["openai-codex"] as { access: string }).access).toBe("at-session-refreshed");
  });

  it("金库为空 → 不导入（注销后的旧 token 不得复活）也不删（保护纯 CLI 登录态）", async () => {
    writeFileSync(piNativeAuthPath(), JSON.stringify({ "openai-codex": oauth(1000, "cli") }));
    readStoredCredential.mockResolvedValue(undefined);
    await syncOAuthWithPiNativeStore("openai-codex");
    expect(modifyStoredCredential).not.toHaveBeenCalled();
    expect((readFile()["openai-codex"] as { access: string }).access).toBe("at-cli");
  });

  it("api_key 型凭据不写入 auth.json（明文 key 不多落一处盘）", async () => {
    readStoredCredential.mockResolvedValue({ type: "api_key", key: "sk-x" } as unknown as Credential);
    await syncOAuthWithPiNativeStore("deepseek");
    expect(existsSync(piNativeAuthPath())).toBe(false);
  });

  it("文件损坏 → 跳过同步且不覆盖用户文件", async () => {
    writeFileSync(piNativeAuthPath(), "{broken json");
    readStoredCredential.mockResolvedValue(oauth(2000, "new"));
    await syncOAuthWithPiNativeStore("openai-codex");
    expect(readFileSync(piNativeAuthPath(), "utf8")).toBe("{broken json");
  });
});

describe("removeFromPiNativeStore", () => {
  it("删除指定条目、保留其余；文件不存在时是 no-op", async () => {
    writeFileSync(piNativeAuthPath(), JSON.stringify({ "openai-codex": oauth(1, "a"), other: oauth(2, "b") }));
    await removeFromPiNativeStore("openai-codex");
    const file = readFile();
    expect(file["openai-codex"]).toBeUndefined();
    expect(file.other).toBeDefined();
    setPiNativeAuthPathForTest(join(dir, "missing.json"));
    await expect(removeFromPiNativeStore("x")).resolves.toBeUndefined();
  });
});
