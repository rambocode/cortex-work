// 写作磁盘基线模块单测:hash 确定性、基线建立/读取/清除、自写回声抑制(U5)。
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetWritingBaselines,
  clearBaseline,
  getBaseline,
  hashContent,
  isSelfEcho,
  recordSelfWrite,
  setBaseline,
} from "./baseline";

const P = "/space/a.md";

describe("writing baseline", () => {
  beforeEach(() => __resetWritingBaselines());

  it("hashContent 确定性:同内容同 hash,不同内容大概率不同", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).not.toBe(hashContent("hello world"));
    expect(hashContent("")).toBe(hashContent(""));
  });

  it("setBaseline/getBaseline:建立后可取回内容与匹配的 hash", () => {
    const bl = setBaseline(P, "# 标题\n正文");
    expect(bl.content).toBe("# 标题\n正文");
    expect(bl.hash).toBe(hashContent("# 标题\n正文"));
    expect(getBaseline(P)).toEqual(bl);
    expect(getBaseline("/other.md")).toBeUndefined();
  });

  it("setBaseline 覆盖:重复建立以最新内容为准", () => {
    setBaseline(P, "v1");
    setBaseline(P, "v2");
    expect(getBaseline(P)?.content).toBe("v2");
  });

  it("clearBaseline:清除基线与自写记录", () => {
    setBaseline(P, "x");
    recordSelfWrite(P, "x");
    clearBaseline(P);
    expect(getBaseline(P)).toBeUndefined();
    expect(isSelfEcho(P, "x")).toBe(false);
  });

  it("自写回声:记录后同内容判为回声,异内容不判为回声", () => {
    recordSelfWrite(P, "saved content");
    expect(isSelfEcho(P, "saved content")).toBe(true);
    expect(isSelfEcho(P, "agent edited")).toBe(false);
    // 未记录过的路径永不判回声。
    expect(isSelfEcho("/none.md", "saved content")).toBe(false);
  });

  it("自写回声持久:同一次记录可多次命中(watch 去抖多次回声)", () => {
    recordSelfWrite(P, "c");
    expect(isSelfEcho(P, "c")).toBe(true);
    expect(isSelfEcho(P, "c")).toBe(true);
  });
});
