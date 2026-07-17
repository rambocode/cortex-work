// pickPresentDisplays 纯几何决策测试:少于 2 屏退单窗、双屏观众落非主屏、顺序无关、3 屏取第一非主屏。
import { describe, expect, it } from "vitest";
import { pickPresentDisplays, type DisplayLike } from "./present-display-geometry";

function display(id: number, x = 0): DisplayLike {
  return { id, bounds: { x, y: 0, width: 1920, height: 1080 } };
}

describe("pickPresentDisplays", () => {
  it("只有一块屏 → null(调用方走单窗)", () => {
    expect(pickPresentDisplays([display(1)], 1)).toBeNull();
  });

  it("空列表 → null", () => {
    expect(pickPresentDisplays([], 1)).toBeNull();
  });

  it("两块屏都是主屏 id(无非主屏)→ null", () => {
    // 极端异常:两块屏 id 相同,找不到外接屏,退单窗。
    expect(pickPresentDisplays([display(1), display(1, 1920)], 1)).toBeNull();
  });

  it("两块屏 → speaker=主屏,audience=外接屏", () => {
    const primary = display(1);
    const external = display(2, 1920);
    const pick = pickPresentDisplays([primary, external], 1);
    expect(pick).not.toBeNull();
    expect(pick!.speaker.id).toBe(1);
    expect(pick!.audience.id).toBe(2);
  });

  it("主屏不在列表首位:顺序无关,仍正确分屏", () => {
    const external = display(2, 1920);
    const primary = display(1);
    const pick = pickPresentDisplays([external, primary], 1);
    expect(pick!.speaker.id).toBe(1);
    expect(pick!.audience.id).toBe(2);
  });

  it("三块屏:audience 取第一块非主屏", () => {
    const pick = pickPresentDisplays([display(1), display(3, 1920), display(4, 3840)], 1);
    expect(pick!.speaker.id).toBe(1);
    expect(pick!.audience.id).toBe(3);
  });
});
