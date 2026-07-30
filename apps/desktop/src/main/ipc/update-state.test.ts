import { describe, it, expect } from "vitest";
import { reduceUpdate, normalizeReleaseNotes, type UpdaterEvent } from "./update-state";
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
    s = run([{ type: "progress", percent: 42.4, transferred: 23_000_000, total: 54_900_000, bytesPerSecond: 1_200_000 }], s);
    expect(s).toEqual({
      phase: "downloading",
      version: "0.2.0",
      percent: 42.4,
      transferred: 23_000_000,
      total: 54_900_000,
      bytesPerSecond: 1_200_000,
    });
    s = run([{ type: "downloaded", version: "0.2.0" }], s);
    expect(s).toEqual({ phase: "downloaded", version: "0.2.0" });
  });

  it("progress 缺字节字段(向后兼容)时不带字节信息也能正常流转", () => {
    const s = run([{ type: "available", version: "0.2.0" }, { type: "progress", percent: 10 }]);
    expect(s.phase).toBe("downloading");
    expect(s.transferred).toBeUndefined();
    expect(s.total).toBeUndefined();
    expect(s.bytesPerSecond).toBeUndefined();
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
    expect(s).toEqual({ phase: "error", version: undefined, error: "HttpError: 404", releaseNotes: undefined });
  });

  it("available 携带 releaseNotes,并在 downloading/error 全程保留", () => {
    let s = run([{ type: "available", version: "0.2.0", releaseNotes: "## 0.2.0\n- 修复 A" }]);
    expect(s).toEqual({ phase: "available", version: "0.2.0", releaseNotes: "## 0.2.0\n- 修复 A" });
    // 下载中保留 releaseNotes,弹窗仍可展示
    s = run([{ type: "progress", percent: 30 }], s);
    expect(s.releaseNotes).toBe("## 0.2.0\n- 修复 A");
    // 失败保留 releaseNotes
    s = run([{ type: "error", message: "net::ERR" }], s);
    expect(s).toEqual({ phase: "error", version: "0.2.0", error: "net::ERR", releaseNotes: "## 0.2.0\n- 修复 A" });
  });

  it("downloaded 自带 releaseNotes;缺省时回退到此前保留的值", () => {
    // 自带 notes
    const withNotes = reduceUpdate(
      { phase: "downloading", version: "0.2.0", percent: 99, releaseNotes: "旧" },
      { type: "downloaded", version: "0.2.0", releaseNotes: "新" },
    );
    expect(withNotes.releaseNotes).toBe("新");
    // 缺省回退
    const fallback = reduceUpdate(
      { phase: "downloading", version: "0.2.0", percent: 99, releaseNotes: "旧" },
      { type: "downloaded", version: "0.2.0" },
    );
    expect(fallback.releaseNotes).toBe("旧");
  });
});

describe("normalizeReleaseNotes", () => {
  it("null / undefined → undefined", () => {
    expect(normalizeReleaseNotes(null)).toBeUndefined();
    expect(normalizeReleaseNotes(undefined)).toBeUndefined();
  });

  it("空串 / 纯空白 → undefined", () => {
    expect(normalizeReleaseNotes("")).toBeUndefined();
    expect(normalizeReleaseNotes("   \n  ")).toBeUndefined();
  });

  it("普通字符串 → 原样 trim", () => {
    expect(normalizeReleaseNotes("  ## 0.2.0\n- A  ")).toBe("## 0.2.0\n- A");
  });

  it("数组兜底分支 → 取各 note 拼接（不可达,仅类型完备）", () => {
    expect(normalizeReleaseNotes([{ note: "a" }, { note: "b" }])).toBe("a\n\nb");
    expect(normalizeReleaseNotes([{ note: null }, {}])).toBeUndefined();
  });
});
