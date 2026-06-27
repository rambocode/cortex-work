import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { PetKind } from "@cortex-work/core";
import { PET_SPRITES } from "./sprites";
import { SpriteLayer } from "./SpriteLayer";

const petCss = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");

describe("SpriteLayer", () => {
  afterEach(cleanup);

  it("有 sprite 的角色渲染 .pet-sprite 并注入帧数 / 时长 / 背景", () => {
    const { container } = render(<SpriteLayer kind="cat" state="idle" walking={false} />);
    const el = container.querySelector(".pet-sprite") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.getPropertyValue("--sprite-frames")).toBe("4");
    // steps = N(jump-none 命中 N 帧),非 N-1,否则 50% 落在两帧间出现重影
    expect(el.style.getPropertyValue("--sprite-steps")).toBe("4");
    // dur = frames/fps = 4/2 = 2s
    expect(el.style.getPropertyValue("--sprite-dur")).toBe("2s");
    expect(el.style.backgroundImage).toContain(PET_SPRITES.cat!.idle!.src);
  });

  it("状态切换改变所选 anim(idle→happy)", () => {
    const { container, rerender } = render(<SpriteLayer kind="cat" state="idle" walking={false} />);
    let el = container.querySelector(".pet-sprite") as HTMLElement;
    expect(el.getAttribute("data-anim-frames")).toBe("4");
    expect(el.getAttribute("data-anim")).toBe("cat:idle:still");

    rerender(<SpriteLayer kind="cat" state="happy" walking={false} />);
    el = container.querySelector(".pet-sprite") as HTMLElement;
    expect(el.getAttribute("data-anim-frames")).toBe("5"); // happy 5 帧
    // happy loop:false → 播一次停末帧
    expect(el.style.animationIterationCount).toBe("1");
    expect(el.style.animationFillMode).toBe("forwards");
  });

  it("散步覆盖状态,选中 walk anim", () => {
    const { container } = render(<SpriteLayer kind="cat" state="happy" walking={true} />);
    const el = container.querySelector(".pet-sprite") as HTMLElement;
    expect(el.getAttribute("data-anim")).toBe("cat:happy:walk");
    expect(el.style.backgroundImage).toContain(PET_SPRITES.cat!.walk!.src);
  });

  it("sleeping 为 pingpong 往复", () => {
    const { container } = render(<SpriteLayer kind="cat" state="sleeping" walking={false} />);
    const el = container.querySelector(".pet-sprite") as HTMLElement;
    expect(el.style.animationDirection).toBe("alternate");
  });

  it("manifest 中无该角色时渲染 null(交由 Pet 回退 SVG)", () => {
    // cat/dog 均有 sprite;用越界 kind 触发 null 渲染分支
    const { container } = render(<SpriteLayer kind={"ghost" as PetKind} state="idle" walking={false} />);
    expect(container.querySelector(".pet-sprite")).toBeNull();
  });

  it("CSS 用 steps(...) 逐帧且声明百分比 sprite 尺寸", () => {
    expect(petCss).toMatch(/\.pet-sprite\s*\{[^}]*background-size:\s*calc\(var\(--sprite-frames[^)]*\) \* 100%\) 100%/s);
    expect(petCss).toMatch(/animation-timing-function:\s*steps\(var\(--sprite-steps, 1\), jump-none\)/s);
    expect(petCss).toMatch(/@keyframes pet-sprite-run/s);
  });
});
