import { beforeEach, describe, expect, it } from "vitest";

import { __resetOwnership, claimForMutation, currentOwner, OWNER_TTL_MS } from "./ownership";

describe("单面板归属仲裁（U5/R18）", () => {
  beforeEach(() => __resetOwnership());

  it("首个改动型调用认领归属", () => {
    expect(claimForMutation("s1", 1000)).toBe(true);
    expect(currentOwner()).toBe("s1");
  });

  it("归属期内其它会话被拒、归属自己放行", () => {
    claimForMutation("s1", 1000);
    expect(claimForMutation("s2", 2000)).toBe(false); // s1 仍归属
    expect(claimForMutation("s1", 3000)).toBe(true); // 自己放行
  });

  it("归属空闲超 TTL → 他会话可接管", () => {
    claimForMutation("s1", 1000);
    expect(claimForMutation("s2", 1000 + OWNER_TTL_MS + 1)).toBe(true);
    expect(currentOwner()).toBe("s2");
  });

  it("null sessionId 退化为单 <anonymous> 归属", () => {
    expect(claimForMutation(null, 1000)).toBe(true);
    expect(currentOwner()).toBe("<anonymous>");
    expect(claimForMutation(null, 2000)).toBe(true);
  });
});
