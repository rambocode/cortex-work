import { createHash } from "node:crypto";

export const EDGE_TTS_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/**
 * 生成 Microsoft Edge Read Aloud 所需的 Sec-MS-GEC 防重放签名。
 *
 * 服务端按五分钟窗口校验 Windows FileTime；本机时钟偏差超过一个窗口会收到 403，
 * 因而不能缓存这个值，也不能把毫秒误当成 FileTime ticks。
 */
export function secMsGecToken(nowMs = Date.now()): string {
  const unixSeconds = Math.floor(nowMs / 1000 / 300) * 300;
  const windowsEpochSeconds = unixSeconds + 11_644_473_600;
  const windowsFileTimeTicks = BigInt(windowsEpochSeconds) * 10_000_000n;
  return createHash("sha256")
    .update(`${windowsFileTimeTicks}${EDGE_TTS_TRUSTED_CLIENT_TOKEN}`)
    .digest("hex")
    .toUpperCase();
}
