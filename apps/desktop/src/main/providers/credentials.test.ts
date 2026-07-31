// 凭据金库单测：safeStorage 加解密往返、只读降级、modify 串行、明文不落盘。
//
// safeStorage 与 paths 走替身：前者用 "enc:" 前缀模拟加密（可读地断言"密文里没有明文"），
// 后者把金库指到临时目录，避免污染真实的 ~/.cortex-desktop。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = vi.hoisted(() => ({ available: true, home: "" }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("bad cipher");
      return s.slice(4);
    },
  },
}));

vi.mock("../paths", () => ({ cortexHome: () => state.home }));

vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  createSafeStorageCredentialStore,
  deleteStoredCredential,
  getCredentialStoreHealth,
  listSecretNames,
  listStoredCredentialMetas,
  modifyStoredCredential,
  readSecrets,
  readStoredCredential,
  resetCredentialVaultForTests,
  setApiKeyCredential,
  setSecrets,
  vaultPath,
} from "./credentials";

const readVaultText = () => fsp.readFile(vaultPath(), "utf8");

beforeEach(() => {
  state.available = true;
  state.home = mkdtempSync(join(tmpdir(), "cortex-vault-"));
  resetCredentialVaultForTests();
});

afterEach(async () => {
  await fsp.rm(state.home, { recursive: true, force: true });
});

describe("safeStorage 加解密往返", () => {
  it("写入的 API Key 能原样读回", async () => {
    await setApiKeyCredential("acme", "sk-live-ABCDEF");
    expect(await readStoredCredential("acme")).toEqual({ type: "api_key", key: "sk-live-ABCDEF" });
  });

  it("落盘文件里没有明文 key，只有非秘密元数据", async () => {
    await setApiKeyCredential("acme", "sk-live-ABCDEF");
    const text = await readVaultText();
    expect(text).not.toContain("sk-live-ABCDEF");
    expect(JSON.parse(text).credentials.acme.type).toBe("api_key");
  });

  it("金库文件权限是 0600", async () => {
    await setApiKeyCredential("acme", "k");
    const stat = await fsp.stat(vaultPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("空串视为删除", async () => {
    await setApiKeyCredential("acme", "k");
    await setApiKeyCredential("acme", "   ");
    expect(await readStoredCredential("acme")).toBeUndefined();
  });

  it("换 key 时保留已有的 provider env", async () => {
    await modifyStoredCredential("cf", async () => ({
      type: "api_key",
      key: "old",
      env: { CLOUDFLARE_ACCOUNT_ID: "acc-1" },
    }));
    await setApiKeyCredential("cf", "new");
    expect(await readStoredCredential("cf")).toEqual({
      type: "api_key",
      key: "new",
      env: { CLOUDFLARE_ACCOUNT_ID: "acc-1" },
    });
  });

  it("OAuth 凭据的过期时间以明文元数据形式可读（免解密列状态）", async () => {
    await modifyStoredCredential("oa", async () => ({
      type: "oauth",
      access: "AT",
      refresh: "RT",
      expires: 1234,
    }));
    expect(await listStoredCredentialMetas()).toEqual([{ providerId: "oa", type: "oauth", expiresAt: 1234 }]);
    const text = await readVaultText();
    expect(text).not.toContain("AT");
    expect(text).not.toContain("RT");
  });
});

describe("safeStorage 不可用时的只读降级", () => {
  it("健康状态报告不可用及原因", () => {
    state.available = false;
    const health = getCredentialStoreHealth();
    expect(health.available).toBe(false);
    expect(health.reason).toBeTruthy();
  });

  it("禁止新增/修改密钥，且不做任何明文回写", async () => {
    state.available = false;
    await expect(setApiKeyCredential("acme", "sk-live-ABCDEF")).rejects.toThrow(/密钥库不可用/);
    // 连文件都不该产生——绝不能出现「加密失败就存明文」的兜底。
    await expect(fsp.access(vaultPath())).rejects.toBeTruthy();
  });

  it("已有凭据不被破坏：恢复后仍可正常读回", async () => {
    await setApiKeyCredential("acme", "sk-live-ABCDEF");
    state.available = false;
    resetCredentialVaultForTests();
    expect(await readStoredCredential("acme")).toBeUndefined();
    expect((await listStoredCredentialMetas())[0]?.providerId).toBe("acme");

    state.available = true;
    resetCredentialVaultForTests();
    expect(await readStoredCredential("acme")).toEqual({ type: "api_key", key: "sk-live-ABCDEF" });
  });
});

describe("modify 串行（并发 OAuth 刷新不互相覆盖）", () => {
  // pi 的 Models.getAuth() 会在 modify 锁内跑 OAuth 刷新。两个并发请求同时发现 token 过期时，
  // 若没有互斥就会各自基于同一份旧凭据刷新、后写覆盖先写 —— 其中一份 refresh token 被作废。
  it("两次并发 modify 都基于对方的写入结果，无丢失更新", async () => {
    const bump = () =>
      modifyStoredCredential("p", async (current) => {
        const n = Number((current?.type === "api_key" ? current.env?.n : undefined) ?? "0");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: "api_key", key: "k", env: { n: String(n + 1) } };
      });

    await Promise.all([bump(), bump(), bump()]);

    const final = await readStoredCredential("p");
    expect(final?.type === "api_key" ? final.env?.n : undefined).toBe("3");
  });

  it("一次 modify 抛错不会卡死后续写入", async () => {
    await expect(
      modifyStoredCredential("p", async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");

    await setApiKeyCredential("p", "still-works");
    expect(await readStoredCredential("p")).toEqual({ type: "api_key", key: "still-works" });
  });

  it("fn 返回 undefined 表示不改动（pi 契约）", async () => {
    await setApiKeyCredential("p", "k1");
    const result = await modifyStoredCredential("p", async () => undefined);
    expect(result).toEqual({ type: "api_key", key: "k1" });
  });

  it("delete 幂等且与 modify 互斥", async () => {
    await setApiKeyCredential("p", "k");
    await deleteStoredCredential("p");
    await deleteStoredCredential("p");
    expect(await readStoredCredential("p")).toBeUndefined();
  });
});

describe("注入给 pi 的 CredentialStore", () => {
  it("read/list/modify/delete 满足 pi 契约语义", async () => {
    const store = createSafeStorageCredentialStore();
    expect(await store.read("missing")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    await store.modify("acme", async () => ({ type: "api_key", key: "k" }));
    expect(await store.list()).toEqual([{ providerId: "acme", type: "api_key" }]);

    await store.delete("acme");
    expect(await store.read("acme")).toBeUndefined();
  });
});

describe("命名 Secret", () => {
  it("写入后可列名、可解密，且明文不落盘", async () => {
    await setSecrets({ CORP_TOKEN: "tok-XYZ", OTHER: "v" });
    expect(await listSecretNames()).toEqual(["CORP_TOKEN", "OTHER"]);
    expect(await readSecrets()).toEqual({ CORP_TOKEN: "tok-XYZ", OTHER: "v" });
    expect(await readVaultText()).not.toContain("tok-XYZ");
  });

  it("空串表示删除该项", async () => {
    await setSecrets({ A: "1", B: "2" });
    await setSecrets({ A: "" });
    expect(await listSecretNames()).toEqual(["B"]);
  });

  it("密钥库不可用时拒绝写入", async () => {
    state.available = false;
    await expect(setSecrets({ A: "1" })).rejects.toThrow(/密钥库不可用/);
  });
});
