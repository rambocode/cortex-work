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
    expect(rpc).toHaveBeenCalledWith(CREDENTIAL_KEY_LIST, "list");

    await expect(createRpcCredentialStore(async () => null).list()).resolves.toEqual([]);
    await expect(createRpcCredentialStore(async () => "{}").list()).resolves.toEqual([]);
  });
});

describe("createRpcCredentialStore · 写路径（真写回主进程金库）", () => {
  /** 读回旧值、写请求原样回显——模拟主进程金库不做归一化的常见情形。 */
  function echoingVault(current: unknown) {
    return vi.fn(async (_key: string, op?: string, value?: string) =>
      op === "write" ? (value ?? null) : op === "delete" ? null : JSON.stringify(current),
    );
  }

  it("modify 把新值写回主进程，且本会话后续读走覆盖层不再 RPC", async () => {
    const rpc = echoingVault({ type: "api_key", key: "旧" });
    const store = createRpcCredentialStore(rpc);

    const next = await store.modify("anthropic", async (cur) => {
      expect(cur).toEqual({ type: "api_key", key: "旧" });
      return { type: "api_key", key: "新" };
    });
    expect(next).toEqual({ type: "api_key", key: "新" });

    // 关键：真的发了 write（只落内存的话 OAuth 刷新结果会随进程消失 → 下次开会话被登出）。
    expect(rpc).toHaveBeenCalledWith(
      "provider:anthropic",
      "write",
      JSON.stringify({ type: "api_key", key: "新" }),
    );

    rpc.mockClear();
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "新" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("以主进程写回的那份为准（金库归一化不会与下次读产生漂移）", async () => {
    // 金库补了一个字段：若以本地值为准，下次读会读到多出来的 env，前后不一致。
    const rpc = vi.fn(async (_key: string, op?: string) =>
      op === "write" ? JSON.stringify({ type: "api_key", key: "新", env: "ANTHROPIC_API_KEY" }) : null,
    );
    const store = createRpcCredentialStore(rpc);
    const next = await store.modify("anthropic", async () => ({ type: "api_key", key: "新" }));
    expect(next).toEqual({ type: "api_key", key: "新", env: "ANTHROPIC_API_KEY" });
  });

  it("写失败必须抛出，且不落覆盖层——否则本会话看似成功、下次开会话被登出且极难查", async () => {
    const rpc = vi.fn(async (_key: string, op?: string) => {
      if (op === "write") throw new Error("金库不可写");
      return JSON.stringify({ type: "api_key", key: "旧" });
    });
    const store = createRpcCredentialStore(rpc);

    await expect(store.modify("anthropic", async () => ({ type: "api_key", key: "新" }))).rejects.toThrow(
      "金库不可写",
    );
    // 覆盖层没被污染：再读仍是主进程里的旧值，与金库真实状态一致。
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "旧" });
  });

  it("delete 真回主进程删，失败同样抛出（不能谎报已登出）", async () => {
    const ok = echoingVault({ type: "api_key", key: "旧" });
    const store = createRpcCredentialStore(ok);
    await store.delete("anthropic");
    expect(ok).toHaveBeenCalledWith("provider:anthropic", "delete");
    await expect(store.read("anthropic")).resolves.toBeUndefined();

    const bad = vi.fn(async (_k: string, op?: string) => {
      if (op === "delete") throw new Error("删除失败");
      return null;
    });
    await expect(createRpcCredentialStore(bad).delete("x")).rejects.toThrow("删除失败");
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
