// RPC-backed CredentialStore 的单测（KTD1）。
//
// 这一层出问题的表现都是「用户明明配了却说未认证」或「密钥莫名其妙没了」，
// 所以每条降级路径都要有断言钉住：读失败 = 未配置（不抛），写 = 只落内存（且留痕）。

import { describe, expect, it, vi } from "vitest";

import {
  CREDENTIAL_KEY_LIST,
  createRpcCredentialStore,
  requestNamedSecret,
} from "./credentials";

describe("createRpcCredentialStore · read", () => {
  it("按 provider:<id> 取，JSON 反序列化成 Credential", async () => {
    const rpc = vi.fn(async () => JSON.stringify({ type: "api_key", key: "sk-1" }));
    const store = createRpcCredentialStore(rpc);
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-1" });
    expect(rpc).toHaveBeenCalledWith("provider:anthropic");
  });

  it("null = 未配置 → undefined（空串是合法凭据值，绝不能混为一谈）", async () => {
    const store = createRpcCredentialStore(async () => null);
    await expect(store.read("openai")).resolves.toBeUndefined();
  });

  it("空串凭据能正常取回（不被当成未配置）", async () => {
    const store = createRpcCredentialStore(async () => JSON.stringify({ type: "api_key", key: "" }));
    await expect(store.read("openai")).resolves.toEqual({ type: "api_key", key: "" });
  });

  it("RPC 抛错 → 按未配置处理但不冒泡（一次通道抖动不该打挂会话）", async () => {
    const store = createRpcCredentialStore(async () => {
      throw new Error("通道断了");
    });
    await expect(store.read("openai")).resolves.toBeUndefined();
  });

  it("返回值不是合法 JSON → 按未配置处理", async () => {
    const store = createRpcCredentialStore(async () => "不是 JSON");
    await expect(store.read("openai")).resolves.toBeUndefined();
  });
});

describe("createRpcCredentialStore · list", () => {
  it("走 credentials:list，非数组/未实现一律降级为空列表", async () => {
    const rpc = vi.fn(async () => JSON.stringify([{ providerId: "x", type: "api_key" }]));
    await expect(createRpcCredentialStore(rpc).list()).resolves.toEqual([
      { providerId: "x", type: "api_key" },
    ]);
    expect(rpc).toHaveBeenCalledWith(CREDENTIAL_KEY_LIST);

    await expect(createRpcCredentialStore(async () => null).list()).resolves.toEqual([]);
    await expect(createRpcCredentialStore(async () => "{}").list()).resolves.toEqual([]);
  });
});

describe("createRpcCredentialStore · 写路径（当前只落内存）", () => {
  it("modify 的新值在本 worker 内可见，且不再回主进程取", async () => {
    const rpc = vi.fn(async () => JSON.stringify({ type: "api_key", key: "旧" }));
    const store = createRpcCredentialStore(rpc);

    const next = await store.modify("anthropic", async (cur) => {
      expect(cur).toEqual({ type: "api_key", key: "旧" });
      return { type: "api_key", key: "新" };
    });
    expect(next).toEqual({ type: "api_key", key: "新" });

    rpc.mockClear();
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "新" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("modify 回 undefined = 不改动，覆盖层不受影响", async () => {
    const store = createRpcCredentialStore(async () => JSON.stringify({ type: "api_key", key: "旧" }));
    await expect(store.modify("openai", async () => undefined)).resolves.toEqual({
      type: "api_key",
      key: "旧",
    });
    await expect(store.read("openai")).resolves.toEqual({ type: "api_key", key: "旧" });
  });

  it("delete 之后读到 undefined，不会把主进程里的旧凭据又取回来", async () => {
    const store = createRpcCredentialStore(async () => JSON.stringify({ type: "api_key", key: "旧" }));
    await store.delete("openai");
    await expect(store.read("openai")).resolves.toBeUndefined();
  });
});

describe("requestNamedSecret", () => {
  it("按 secret:<NAME> 取命名 Secret", async () => {
    const rpc = vi.fn(async () => "s3cr3t");
    await expect(requestNamedSecret(rpc, "MY_KEY")).resolves.toBe("s3cr3t");
    expect(rpc).toHaveBeenCalledWith("secret:MY_KEY");
  });
});
