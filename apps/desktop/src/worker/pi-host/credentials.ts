// RPC-backed `CredentialStore`（gateway 方案的 KTD1）。
//
// ── 为什么必须是 RPC 而不是把密钥随 open 一起发过来 ────────────────────────────────────
// `safeStorage` 是主进程 API，worker 拿不到。最省事的做法是主进程在 `pi:open` 时把解密后的
// 凭据塞进 open 参数——但那样密钥会在 worker 里**常驻整个会话生命周期**，而 pi 真正用到它
// 只有发请求那一刻。所以这里给 `ModelRuntime.create({ credentials })` 注入一个「要用时才回
// 主进程要」的实现：密钥只在一次 RPC 往返里跨进程存在，不落盘、不常驻。
// 这比 binary 路径（烘焙进 0600 的 .js 文件 + spawn env）严格更好。
//
// ── key 的命名空间（与主进程侧 gateway 客户端的解析器约定，改一处必须改两处）────────────
//   · `provider:<providerId>` → 该 provider 的 `Credential`，**JSON 序列化后**放进
//     `HostCredentialResponse.value`；未配置返回 `null`（**不是**空串——空串是合法凭据值）。
//   · `credentials:list`      → `CredentialInfo[]` 的 JSON。主进程未实现时返回 null，
//     本模块降级为空列表（pi 只拿它做账号枚举/状态展示，不影响发请求）。
//   · `secret:<NAME>`         → 命名 Secret 明文，给自定义 Provider 的 `${secret:NAME}` 用。
//     本模块不消费它，导出 `requestNamedSecret` 让 key 空间只有这一处定义。
//
// ── 写路径（modify / delete）────────────────────────────────────────────────────────
// pi 在 `Models.getAuth()` 里用 `modify()` 落 **OAuth 刷新后的 token**。这条必须真的写回主进程
// 金库：只落 worker 内存的话，刷新结果随进程消失，下次开会话仍拿旧 refresh token——而服务端
// 很可能已把它轮换作废，表现为**用户莫名其妙被登出**（`providers/credentials.ts` 文件头记的
// 正是这个事故形态）。
//
// 协议的 `op`/`value` 就是为此存在的。两条实现约束：
//   1. **写失败必须抛出，且不落内存覆盖层**。落了覆盖层会让本会话读到「看起来成功」的新值，
//      而金库里还是旧的——下次开会话照样被登出，却更难查（本会话一切正常）。宁可让 pi 当场
//      看到写失败：它的重试/报错路径比我们的静默兜底可靠。
//   2. **以主进程写回的那份为准**。金库可能对凭据做归一化（补字段、去多余键），拿我们发出去
//      的那份当结果会与下次读到的产生漂移。

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

import { createLogger } from "./log";

const log = createLogger("pi-host-credentials");

/**
 * 一次凭据反向调用。由 host 实现：发一条 `WorkerCredentialRequest`，等对应的
 * `HostCredentialResponse`。返回 `null` = 未配置 / 主进程不认识这个 key。
 */
export type CredentialRpc = (
  key: string,
  op?: "read" | "list" | "write" | "delete",
  value?: string,
) => Promise<string | null>;

/** key 命名空间。两侧共用的字面量集中在这里，避免散落成魔法字符串。 */
export const CREDENTIAL_KEY_PROVIDER_PREFIX = "provider:";
export const CREDENTIAL_KEY_LIST = "credentials:list";
export const CREDENTIAL_KEY_SECRET_PREFIX = "secret:";

/** 取一条命名 Secret（`${secret:NAME}`）。给自定义 Provider 解析用。 */
export function requestNamedSecret(rpc: CredentialRpc, name: string): Promise<string | null> {
  return rpc(`${CREDENTIAL_KEY_SECRET_PREFIX}${name}`);
}

/** 建一个「读写都走 RPC 回主进程金库」的 `CredentialStore`。 */
export function createRpcCredentialStore(rpc: CredentialRpc): CredentialStore {
  // 内存覆盖层只做**已成功写回主进程**之后的本地缓存，避免同一会话内反复 RPC 读。
  // 用 `null` 表示「已删除」，与「没有覆盖」（undefined）区分开——
  // 两者合并会让 delete 之后的读取又把主进程里的旧凭据取回来。
  const overrides = new Map<string, Credential | null>();

  const read = async (providerId: string): Promise<Credential | undefined> => {
    const override = overrides.get(providerId);
    if (override !== undefined) return override ?? undefined;

    let raw: string | null;
    try {
      raw = await rpc(`${CREDENTIAL_KEY_PROVIDER_PREFIX}${providerId}`);
    } catch (err) {
      // 读失败**不吞**：pi 会把 undefined 当成「未登录」，用户看到的是一句莫名其妙的
      // 「provider 未认证」。留痕后仍返回 undefined（不抛），避免一次通道抖动直接打挂会话。
      log.warn("凭据读取失败（本次按未配置处理）", { providerId, error: errText(err) });
      return undefined;
    }
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as Credential;
    } catch (err) {
      log.warn("凭据反序列化失败（本次按未配置处理）", { providerId, error: errText(err) });
      return undefined;
    }
  };

  return {
    read,

    list: async (): Promise<readonly CredentialInfo[]> => {
      let raw: string | null;
      try {
        raw = await rpc(CREDENTIAL_KEY_LIST, "list");
      } catch (err) {
        log.warn("凭据列表读取失败（降级为空列表）", { error: errText(err) });
        return [];
      }
      if (raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as CredentialInfo[]) : [];
      } catch (err) {
        log.warn("凭据列表反序列化失败（降级为空列表）", { error: errText(err) });
        return [];
      }
    },

    /**
     * 读-改-写。`fn` 返回 undefined 表示不改动（pi 的契约），此时原样返回当前值。
     *
     * 不做 per-provider 串行化：worker 是单事件循环，且 pi 侧对同一 provider 的刷新本来
     * 就走它自己的队列，两个 modify 不会交错到「后写覆盖先写」。
     */
    modify: async (
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> => {
      const current = await read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;

      // 写失败**抛出**且不落覆盖层（见文件头约束 1）：让 pi 当场看到失败，
      // 而不是本会话「看起来成功」、下次开会话被登出。
      const written = await rpc(
        `${CREDENTIAL_KEY_PROVIDER_PREFIX}${providerId}`,
        "write",
        JSON.stringify(next),
      );

      // 以主进程写回的那份为准（约束 2：金库可能做归一化）；它没回内容时才退回我们发出去的。
      let effective = next;
      if (written !== null) {
        try {
          effective = JSON.parse(written) as Credential;
        } catch (err) {
          // 回包坏了不代表没写成功，故不抛；但要留痕，否则归一化漂移无从追查。
          log.warn("凭据写回结果反序列化失败（以本地值为准）", { providerId, error: errText(err) });
        }
      }
      overrides.set(providerId, effective);
      return effective;
    },

    delete: async (providerId: string): Promise<void> => {
      // 同样不吞错：删除失败却告诉 pi「已登出」，用户会以为账号已清掉而实际还在金库里。
      await rpc(`${CREDENTIAL_KEY_PROVIDER_PREFIX}${providerId}`, "delete");
      overrides.set(providerId, null);
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
