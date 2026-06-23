// 单面板单归属仲裁(U5/KTD9/R18)。多并发主会话共享一个可见面板:归属 = 最近发起改动型工具
// (navigate/click/type)的会话,在最近活动后 OWNER_TTL_MS 内保持;期内其它会话的改动型工具被拒,
// 只读型(screenshot/readDom/readConsole)不受限。空闲超 TTL → 他会话可接管。
export const OWNER_TTL_MS = 60_000;

let owner: string | null = null;
let lastActivityMs = 0;

// 改动型操作请求归属:无归属 / 归属自己 / 当前归属已空闲超 TTL → 认领并放行;否则拒。
// now 由调用方传(便于单测;运行时传 Date.now())。sessionId 为 null(无会话头)→ 固定占位,
// 即所有无标识请求共享一个归属(退化为单 owner,仍安全)。
export function claimForMutation(sessionId: string | null, now: number): boolean {
  const sid = sessionId ?? "<anonymous>";
  if (owner === null || owner === sid || now - lastActivityMs > OWNER_TTL_MS) {
    owner = sid;
    lastActivityMs = now;
    return true;
  }
  return false;
}

export function currentOwner(): string | null {
  return owner;
}

// 仅供测试重置模块态。
export function __resetOwnership(): void {
  owner = null;
  lastActivityMs = 0;
}
