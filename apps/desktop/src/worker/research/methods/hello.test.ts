// hello 单测：握手结果的字段契约。
import { describe, expect, it } from "vitest";
import {
  RESEARCH_PROTOCOL_VERSION,
  WORKER_METHODS,
  parseWorkerResult,
} from "@cortex-work/core/research/protocol";
import { runHello } from "./hello";

describe("runHello", () => {
  it("回报自身版本、支持的全部 method 与最大协议版本", () => {
    const result = runHello(
      { protocol_version: 1, desktop_version: "0.1.48" },
      { workerVersion: "0.1.0", browserAvailable: false },
    );
    expect(parseWorkerResult("hello", result)).toEqual(result);
    expect(result.max_protocol_version).toBe(RESEARCH_PROTOCOL_VERSION);
    expect(result.methods).toEqual([...WORKER_METHODS]);
    expect(result.worker_version).toBe("0.1.0");
    expect(result.browser_available).toBe(false);
  });

  it("browser_available 由注入的能力探测决定", () => {
    const result = runHello(
      { protocol_version: 1, desktop_version: "0.1.48" },
      { workerVersion: "0.1.0", browserAvailable: true },
    );
    expect(result.browser_available).toBe(true);
  });
});
