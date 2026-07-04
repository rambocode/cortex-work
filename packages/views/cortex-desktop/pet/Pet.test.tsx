import { cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePetStore } from "@cortex-work/core";
import { PET_ENABLED_KEY, PET_MODE_KEY, PET_WALK_KEY, WALK_IDLE_DELAY_MS } from "./behavior";
import { PET_KIND_KEY } from "./designs";
import { Pet } from "./Pet";

function resetStore() {
  usePetStore.setState({
    state: "idle",
    kind: "cat",
    mode: "free",
    walk: true,
    enabled: true,
    size: 1,
    color: null,
    lastActivity: Date.now(),
  });
}

// jsdom 视口 1024 宽,巡逻道最右侧 = innerWidth - PET_W(110) - 18
const RIGHT_X = 1024 - 110 - 18;
const petCss = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");

describe("Pet 行为模式", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("enabled=false(持久化为关)时不渲染", () => {
    localStorage.setItem(PET_ENABLED_KEY, "0");
    const { container } = render(<Pet />);
    expect(container.querySelector(".pet")).toBeNull();
  });

  it("默认自由放置:free 模式、不进巡逻道、不自动走动", () => {
    const { container } = render(<Pet />); // 默认 walk 关
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.getAttribute("data-mode")).toBe("free");
    expect(pet.classList.contains("is-walking")).toBe(false);
    expect(pet.classList.contains("is-gliding")).toBe(false);
  });

  it("显式开启走动:安静满 10 分钟才开始走动;一有事件平滑归位最右侧", () => {
    vi.useFakeTimers();
    localStorage.setItem(PET_WALK_KEY, "1"); // 走动为隐藏能力,显式开启才生效
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;

    // 9 分钟:还不走
    act(() => {
      usePetStore.setState({ lastActivity: Date.now() - (WALK_IDLE_DELAY_MS - 60_000) });
      vi.advanceTimersByTime(600);
    });
    expect(pet.classList.contains("is-walking")).toBe(false);

    // 超过 10 分钟:开始走动
    act(() => {
      usePetStore.setState({ lastActivity: Date.now() - (WALK_IDLE_DELAY_MS + 1000) });
      vi.advanceTimersByTime(600);
    });
    expect(pet.classList.contains("is-walking")).toBe(true);

    // 有输入事件:停止走动,归位最右(is-gliding 由 CSS transition 平滑过渡)
    act(() => {
      usePetStore.getState().set("typing");
      vi.advanceTimersByTime(600);
    });
    expect(pet.classList.contains("is-walking")).toBe(false);
    expect(pet.classList.contains("is-gliding")).toBe(true);
    expect(parseFloat(pet.style.left)).toBe(RIGHT_X);
    expect(pet.getAttribute("data-state")).toBe("typing");
  });

  it("走动开关关闭(纯自由放置):不进巡逻道,安静 10 分钟也不走", () => {
    vi.useFakeTimers();
    localStorage.setItem(PET_WALK_KEY, "0");
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.classList.contains("is-gliding")).toBe(false);
    act(() => {
      usePetStore.setState({ lastActivity: Date.now() - (WALK_IDLE_DELAY_MS + 1000) });
      vi.advanceTimersByTime(600);
    });
    expect(pet.classList.contains("is-walking")).toBe(false);
    expect(pet.querySelector(".pet-3d")).not.toBeNull();
  });

  it("纯自由拖拽时根节点坐标更新", () => {
    localStorage.setItem(PET_WALK_KEY, "0");
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    pet.getBoundingClientRect = () =>
      ({ left: 100, top: 200, width: 110, height: 100, right: 210, bottom: 300, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(pet, { clientX: 110, clientY: 220, pointerId: 1 });
    fireEvent.pointerMove(pet, { clientX: 170, clientY: 260, pointerId: 1 });
    fireEvent.pointerUp(pet, { clientX: 170, clientY: 260, pointerId: 1 });

    expect(parseFloat(pet.style.left)).toBe(160);
    expect(parseFloat(pet.style.top)).toBe(240);
    expect(JSON.parse(localStorage.getItem("cortex_pet_pos")!)).toEqual({ x: 160, y: 240 });
  });

  it("宠物根节点有稳定视觉盒,避免阴影按过宽块级盒居中偏移", () => {
    expect(petCss).toMatch(/\.pet\s*\{[^}]*width:\s*calc\(110px \* var\(--pet-scale, 1\)\)/s);
    expect(petCss).toMatch(/\.pet\s*\{[^}]*height:\s*calc\(100px \* var\(--pet-scale, 1\)\)/s);
    expect(petCss).toMatch(/\.pet-3d\s*\{[^}]*width:\s*100%/s);
  });

  it("有 sprite 的角色(cat)走序列帧层 + 配件叠加层,不渲染内联 SVG 造型", () => {
    const { container } = render(<Pet />); // 默认 kind=cat
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.querySelector(".pet-3d > .pet-sprite")).not.toBeNull();
    // 浮动配件叠加层存在(状态反馈),但没有 body 造型 svg
    expect(pet.querySelector(".pet-3d > svg.pet-accessories")).not.toBeNull();
    expect(pet.querySelector(".pet-3d > svg:not(.pet-accessories)")).toBeNull();
  });

  it("dog 角色同样走 sprite 序列帧层", () => {
    localStorage.setItem(PET_KIND_KEY, "dog");
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.querySelector(".pet-3d > .pet-sprite")).not.toBeNull();
    expect(pet.querySelector(".pet-3d > svg:not(.pet-accessories)")).toBeNull();
  });

  it("点击 ✕ 隐藏宠物并持久化", () => {
    const { container } = render(<Pet />);
    fireEvent.click(container.querySelector(".pet-x")!);
    expect(container.querySelector(".pet")).toBeNull();
    expect(usePetStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(PET_ENABLED_KEY)).toBe("0");
  });

  it("perch 已退役:历史持久化的 perch 强制迁回 free(走 sprite,不进趴姿)", () => {
    localStorage.setItem(PET_MODE_KEY, "perch");
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.getAttribute("data-mode")).toBe("free");
    expect(pet.classList.contains("is-perched")).toBe(false);
    expect(pet.querySelector(".pet-3d > .pet-sprite")).not.toBeNull(); // 默认 cat,走 sprite
  });

  // 独立 pet-overlay 窗口专用模式:宠物固定居中在一个刚好包住它的小窗口里,挪动窗口本身
  // (原生 app-region:drag)而不是在窗口内部用 CSS 拖拽——多显示器下靠 CSS 在一个铺满全屏
  // 的透明窗口内挪动会被 macOS 裁剪,原生窗口拖拽不受此限(见 Pet.tsx/pet-overlay-window.ts
  // 头部注释)。
  describe("windowFollowsPet(独立 pet-overlay 窗口)", () => {
    it("固定居中显示,不读取/写入 localStorage 记忆位置", () => {
      localStorage.setItem("cortex_pet_pos", JSON.stringify({ x: 1, y: 2 }));
      const { container } = render(<Pet windowFollowsPet />);
      const pet = container.querySelector(".pet") as HTMLElement;
      // OVERLAY_WINDOW_W/H = 260/240,size=1 时宠物 110x100,居中偏移 = (260-110)/2, (240-100)/2
      expect(parseFloat(pet.style.left)).toBe(75);
      expect(parseFloat(pet.style.top)).toBe(70);
    });

    // 根节点应标 -webkit-app-region:drag、关闭按钮标 no-drag(原生窗口拖拽,不接管点击的
    // CSS 依据),但 jsdom 的 CSSStyleDeclaration 用 cssstyle 包做属性名校验,不认识这个
    // 非标准属性,赋值会被静默丢弃(真实 Chromium/Electron 环境没有这个问题)——单测校验不
    // 到,只能靠打包后手动验证:悬停宠物应能原生拖拽窗口,悬停关闭按钮不触发拖拽。

    it("巡逻走动禁用:即使开着走动开关、安静超过 10 分钟也不进巡逻道", () => {
      vi.useFakeTimers();
      act(() => usePetStore.setState({ walk: true }));
      const { container } = render(<Pet windowFollowsPet />);
      const pet = container.querySelector(".pet") as HTMLElement;
      act(() => {
        usePetStore.setState({ lastActivity: Date.now() - (WALK_IDLE_DELAY_MS + 1000) });
        vi.advanceTimersByTime(600);
      });
      expect(pet.classList.contains("is-walking")).toBe(false);
      expect(pet.classList.contains("is-gliding")).toBe(false);
    });

    it("点击仍触发 happy(未经自定义拖拽判定,onPointerDown 整个跳过)", () => {
      const { container } = render(<Pet windowFollowsPet />);
      const pet = container.querySelector(".pet") as HTMLElement;
      fireEvent.pointerDown(pet, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerUp(pet, { clientX: 10, clientY: 10, pointerId: 1 });
      expect(usePetStore.getState().state).toBe("happy");
    });
  });
});
