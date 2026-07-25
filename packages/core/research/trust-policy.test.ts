// trust-policy.ts 的测试。这是数据出站的最后一道判定，任何一格判错都是隐私事故，
// 所以 5 个信任区全部显式断言，不做归纳抽查。
import { describe, expect, it } from "vitest";

import type { SourcePolicy, TrustZone } from "./evidence";

import { TRUST_ZONES } from "./evidence";
import {
  canReuseAcrossSessions,
  canSendToCloudModel,
  canSendToSearchServer,
  DEFAULT_SOURCE_POLICIES,
  resolveSourcePolicy,
} from "./trust-policy";

describe("DEFAULT_SOURCE_POLICIES", () => {
  it.each([
    ["public_web", true, true, true],
    ["authenticated_web", false, false, false],
    ["local_file", false, false, false],
    ["enterprise", false, false, true],
    ["memory", false, false, false],
  ] as Array<[TrustZone, boolean, boolean, boolean]>)(
    "%s 的默认矩阵：search=%s cloud=%s reuse=%s",
    (zone, search, cloud, reuse) => {
      expect(DEFAULT_SOURCE_POLICIES[zone]).toEqual({
        trustZone: zone,
        allowSearchServer: search,
        allowCloudModel: cloud,
        allowCrossSessionReuse: reuse,
      });
    },
  );

  it("覆盖全部信任区", () => {
    expect(Object.keys(DEFAULT_SOURCE_POLICIES).sort()).toEqual([...TRUST_ZONES].sort());
  });

  it("只有 public_web 默认允许出站（其余零信任）", () => {
    for (const zone of TRUST_ZONES) {
      if (zone === "public_web") continue;
      expect(DEFAULT_SOURCE_POLICIES[zone].allowSearchServer).toBe(false);
      expect(DEFAULT_SOURCE_POLICIES[zone].allowCloudModel).toBe(false);
    }
  });

  it("默认策略不带 expiresAt（默认授权不过期，过期只在来源级授权时出现）", () => {
    for (const zone of TRUST_ZONES) {
      expect(DEFAULT_SOURCE_POLICIES[zone].expiresAt).toBeUndefined();
    }
  });
});

describe("canSendToSearchServer", () => {
  it.each([
    ["public_web", true],
    ["authenticated_web", false],
    ["local_file", false],
    ["enterprise", false],
    ["memory", false],
  ] as Array<[TrustZone, boolean]>)("%s 默认策略 → %s", (zone, expected) => {
    expect(canSendToSearchServer(DEFAULT_SOURCE_POLICIES[zone])).toBe(expected);
  });
});

describe("canSendToCloudModel（5 个信任区逐格断言）", () => {
  for (const zone of TRUST_ZONES) {
    // 唯一为 true 的格子：public_web —— 其余信任区默认不允许把正文送进模型。
    const expected = zone === "public_web";
    it(`${zone} 默认策略 → ${expected}`, () => {
      expect(canSendToCloudModel(DEFAULT_SOURCE_POLICIES[zone])).toBe(expected);
    });
  }

  it("来源级单独批准后放行（授权流程写入更宽的 policy）", () => {
    const approved: SourcePolicy = {
      ...DEFAULT_SOURCE_POLICIES.authenticated_web,
      allowCloudModel: true,
    };
    expect(canSendToCloudModel(approved)).toBe(true);
  });

  // fail-closed：policy 可能来自持久化数据或被手改的配置，非布尔值一律按「不允许」处理。
  it.each([
    ["undefined", undefined],
    ["字符串 true", "true"],
    ["数字 1", 1],
    ["null", null],
  ])("allowCloudModel 为 %s 时不放行", (_label, value) => {
    const malformed = {
      ...DEFAULT_SOURCE_POLICIES.public_web,
      allowCloudModel: value,
    } as unknown as SourcePolicy;
    expect(canSendToCloudModel(malformed)).toBe(false);
  });
});

describe("canReuseAcrossSessions", () => {
  const now = new Date("2026-07-25T12:00:00.000Z");

  it("allowCrossSessionReuse 为 false 时恒 false", () => {
    expect(canReuseAcrossSessions(DEFAULT_SOURCE_POLICIES.memory, now)).toBe(false);
  });

  it("允许复用且无 expiresAt 时为 true", () => {
    expect(canReuseAcrossSessions(DEFAULT_SOURCE_POLICIES.public_web, now)).toBe(true);
  });

  it.each([
    ["未来时间未过期", "2026-07-25T12:00:01.000Z", true],
    ["远期未过期", "2027-01-01T00:00:00.000Z", true],
    ["刚好等于 now 视为过期", "2026-07-25T12:00:00.000Z", false],
    ["已过期", "2026-07-25T11:59:59.000Z", false],
    ["无法解析的时间戳 fail-closed", "not-a-date", false],
    ["空字符串 fail-closed", "", false],
  ] as Array<[string, string, boolean]>)("%s", (_name, expiresAt, expected) => {
    const policy: SourcePolicy = { ...DEFAULT_SOURCE_POLICIES.public_web, expiresAt };
    expect(canReuseAcrossSessions(policy, now)).toBe(expected);
  });

  it("过期检查在 allow 为 false 时不改变结论", () => {
    const policy: SourcePolicy = {
      ...DEFAULT_SOURCE_POLICIES.local_file,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(canReuseAcrossSessions(policy, now)).toBe(false);
  });
});

describe("resolveSourcePolicy", () => {
  it.each([...TRUST_ZONES])("%s 无 overrides 时等于默认策略", (zone) => {
    expect(resolveSourcePolicy(zone)).toEqual(DEFAULT_SOURCE_POLICIES[zone]);
  });

  it("返回新对象，改它不会污染 DEFAULT_SOURCE_POLICIES", () => {
    const policy = resolveSourcePolicy("public_web");
    policy.allowCloudModel = false;
    expect(DEFAULT_SOURCE_POLICIES.public_web.allowCloudModel).toBe(true);
  });

  describe("overrides 只能收紧不能放宽（安全不变量）", () => {
    it.each(["allowSearchServer", "allowCloudModel", "allowCrossSessionReuse"] as const)(
      "%s: true → false 生效",
      (field) => {
        expect(resolveSourcePolicy("public_web", { [field]: false })[field]).toBe(false);
      },
    );

    it.each(["allowSearchServer", "allowCloudModel", "allowCrossSessionReuse"] as const)(
      "%s: false → true 被忽略",
      (field) => {
        expect(resolveSourcePolicy("memory", { [field]: true })[field]).toBe(false);
      },
    );

    it("enterprise 的 allowCrossSessionReuse 可被收紧", () => {
      expect(resolveSourcePolicy("enterprise", { allowCrossSessionReuse: false })).toEqual({
        ...DEFAULT_SOURCE_POLICIES.enterprise,
        allowCrossSessionReuse: false,
      });
    });

    it("overrides 里的 trustZone 被忽略（不能借覆盖换信任区）", () => {
      const policy = resolveSourcePolicy("memory", { trustZone: "public_web" });
      expect(policy.trustZone).toBe("memory");
      expect(policy.allowSearchServer).toBe(false);
    });

    it("非布尔脏值不放宽，保持默认", () => {
      const policy = resolveSourcePolicy("memory", {
        allowCloudModel: "false" as unknown as boolean,
      });
      expect(policy.allowCloudModel).toBe(false);
      const wide = resolveSourcePolicy("public_web", {
        allowCloudModel: 0 as unknown as boolean,
      });
      expect(wide.allowCloudModel).toBe(true);
    });
  });

  describe("expiresAt 也只能收紧", () => {
    it("默认无过期时可以设置一个过期时间", () => {
      expect(resolveSourcePolicy("public_web", { expiresAt: "2026-08-01T00:00:00.000Z" }).expiresAt).toBe(
        "2026-08-01T00:00:00.000Z",
      );
    });

    it("设置过期时间后复用判定会随时间失效", () => {
      const policy = resolveSourcePolicy("public_web", { expiresAt: "2026-07-26T00:00:00.000Z" });
      expect(canReuseAcrossSessions(policy, new Date("2026-07-25T00:00:00.000Z"))).toBe(true);
      expect(canReuseAcrossSessions(policy, new Date("2026-07-27T00:00:00.000Z"))).toBe(false);
    });

    it("非字符串 expiresAt 被忽略", () => {
      expect(
        resolveSourcePolicy("public_web", { expiresAt: 123 as unknown as string }).expiresAt,
      ).toBeUndefined();
    });
  });

  it("未知信任区 fail-closed：全部禁止", () => {
    expect(resolveSourcePolicy("intranet" as TrustZone)).toEqual({
      trustZone: "intranet",
      allowSearchServer: false,
      allowCloudModel: false,
      allowCrossSessionReuse: false,
    });
  });
});
