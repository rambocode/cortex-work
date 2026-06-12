import { describe, it, expect } from "vitest";
import { reduceUpdate, type UpdaterEvent } from "./update-state";
import type { UpdateState } from "./types";

const idle: UpdateState = { phase: "idle" };

function run(events: UpdaterEvent[], from: UpdateState = idle): UpdateState {
  return events.reduce(reduceUpdate, from);
}

describe("reduceUpdate 状态机", () => {
  it("正常流转:idle → checking → available → downloading → downloaded", () => {
    let s = run([{ type: "checking" }]);
    expect(s).toEqual({ phase: "checking" });
    s = run([{ type: "available", version: "0.2.0" }], s);
    expect(s).toEqual({ phase: "available", version: "0.2.0" });
    s = run([{ type: "progress", percent: 42.4 }], s);
    expect(s).toEqual({ phase: "downloading", version: "0.2.0", percent: 42.4 });
    s = run([{ type: "downloaded", version: "0.2.0" }], s);
    expect(s).toEqual({ phase: "downloaded", version: "0.2.0" });
  });

  it("没有新版本:checking → not-available 回 idle", () => {
    expect(run([{ type: "checking" }, { type: "not-available" }])).toEqual({ phase: "idle" });
  });

  it("周期复查不回退已发现/已下载的状态", () => {
    const available: UpdateState = { phase: "available", version: "0.2.0" };
    expect(reduceUpdate(available, { type: "checking" })).toBe(available);

    const downloaded: UpdateState = { phase: "downloaded", version: "0.2.0" };
    expect(reduceUpdate(downloaded, { type: "checking" })).toBe(downloaded);
    expect(reduceUpdate(downloaded, { type: "not-available" })).toBe(downloaded);
    // 同版本再次 available（复查重复发现）保持 downloaded
    expect(reduceUpdate(downloaded, { type: "available", version: "0.2.0" })).toBe(downloaded);
  });

  it("已下载后发现更新的版本,覆盖为新的 available", () => {
    const downloaded: UpdateState = { phase: "downloaded", version: "0.2.0" };
    expect(reduceUpdate(downloaded, { type: "available", version: "0.3.0" })).toEqual({
      phase: "available",
      version: "0.3.0",
    });
  });

  it("下载失败保留 version 供重试,重试后能继续流转", () => {
    let s = run([
      { type: "checking" },
      { type: "available", version: "0.2.0" },
      { type: "progress", percent: 10 },
      { type: "error", message: "net::ERR_CONNECTION_RESET" },
    ]);
    expect(s).toEqual({ phase: "error", version: "0.2.0", error: "net::ERR_CONNECTION_RESET" });
    // 重试下载
    s = run([{ type: "progress", percent: 5 }], s);
    expect(s.phase).toBe("downloading");
    expect(s.version).toBe("0.2.0");
  });

  it("纯检查失败（无 version）进入 error 且不带 version", () => {
    const s = run([{ type: "checking" }, { type: "error", message: "HttpError: 404" }]);
    expect(s).toEqual({ phase: "error", version: undefined, error: "HttpError: 404" });
  });
});
