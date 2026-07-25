// evidence.ts 的运行时契约测试。类型本身由 tsc 保证，这里只测带运行时行为的跨模块契约：
// 1) TRUST_ZONES / FETCH_FAILURE_CODES 与各自的 TS union 完整对齐；
// 2) 三组枚举（trust_zone、fetch_failure.code、fetch_method）与 ./protocol 同集合。
//
// 为什么必须从 protocol 的 schema 反查而不是手抄一份期望值：protocol.ts 是 Worker 进程间
// 协议的真源，两处手写常量一旦漂移，症状是运行时 zod 校验失败（跨进程、难定位），
// 而不是编译错误。反查让漂移在单测阶段就变红。
import { describe, expect, it } from "vitest";

import {
  FETCH_FAILURE_CODES,
  TRUST_ZONES,
  type FetchFailureCode,
  type FetchMethod,
  type TrustZone,
} from "./evidence";
import { WORKER_RESULT_SCHEMAS } from "./protocol";

describe("TRUST_ZONES", () => {
  it("与 TrustZone union 完整对齐（新增成员漏加常量会在此处炸）", () => {
    // Record<TrustZone, true> 强制编译期穷尽：union 加成员而这里没加 key 就编译失败。
    const exhaustive: Record<TrustZone, true> = {
      public_web: true,
      authenticated_web: true,
      local_file: true,
      enterprise: true,
      memory: true,
    };
    expect([...TRUST_ZONES].sort()).toEqual(Object.keys(exhaustive).sort());
  });

  it("没有重复项", () => {
    expect(new Set(TRUST_ZONES).size).toBe(TRUST_ZONES.length);
  });

  it("与 protocol.ts 的 trust_zone 枚举同集合", () => {
    // 从 fetch_prepare 的 documents.trust_zone 反查协议侧枚举。
    const protocolZones: string[] =
      WORKER_RESULT_SCHEMAS.fetch_prepare.shape.documents.element.shape.trust_zone.options;
    expect([...TRUST_ZONES].sort()).toEqual([...protocolZones].sort());
  });
});

// FetchMethod 决定 Browser 降级配额的计数口径（browser 是最贵的路径），
// 协议侧多出或少掉一个取值都会让 main 的配额统计静默错位。
describe("FetchMethod", () => {
  it("与 protocol.ts 的 fetch_method 枚举同集合", () => {
    const protocolMethods: string[] =
      WORKER_RESULT_SCHEMAS.fetch_prepare.shape.documents.element.shape.fetch_method.options;
    // 这份手写镜像的类型是 Record<FetchMethod, true>：漏一个取值会在 typecheck 就报错，
    // 不用等到断言执行。stealth = main 经服务端（Camoufox）抓回、再交给 Worker 抽取。
    const exhaustive: Record<FetchMethod, true> = {
      http: true,
      browser: true,
      pdf: true,
      local_file: true,
      stealth: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...protocolMethods].sort());
  });
});

describe("FETCH_FAILURE_CODES", () => {
  it("与 protocol.ts 的 fetch_failure code 枚举同集合", () => {
    // 从 fetch_prepare 的 result schema 反查协议侧枚举，避免两处手抄漂移。
    const protocolCodes: string[] =
      WORKER_RESULT_SCHEMAS.fetch_prepare.shape.failures.element.shape.code.options;
    expect([...FETCH_FAILURE_CODES].sort()).toEqual([...protocolCodes].sort());
  });

  it("与 FetchFailureCode union 完整对齐", () => {
    const exhaustive: Record<FetchFailureCode, true> = {
      blocked_by_policy: true,
      dns_failure: true,
      connect_failure: true,
      tls_failure: true,
      http_error: true,
      too_large: true,
      timeout: true,
      unsupported_media: true,
      empty_content: true,
      browser_unavailable: true,
      cancelled: true,
      internal_error: true,
    };
    expect([...FETCH_FAILURE_CODES].sort()).toEqual(Object.keys(exhaustive).sort());
  });
});
