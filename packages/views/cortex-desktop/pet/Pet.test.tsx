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

  it("默认 free + 走动开:常驻巡逻道最右侧,但不立刻走动", () => {
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.getAttribute("data-mode")).toBe("free");
    expect(pet.classList.contains("is-walking")).toBe(false);
    expect(pet.classList.contains("is-gliding")).toBe(true);
    expect(parseFloat(pet.style.left)).toBe(RIGHT_X);
  });

  it("安静满 10 分钟才开始走动;一有事件平滑归位最右侧", () => {
    vi.useFakeTimers();
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
    expect(pet.querySelector(".pet-shadow")).not.toBeNull();
  });

  it("纯自由拖拽时根节点坐标更新,地面阴影跟随同一个拖拽根节点", () => {
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
    expect(pet.querySelector(".pet-shadow")?.parentElement).toBe(pet);
  });

  it("宠物根节点有稳定视觉盒,避免阴影按过宽块级盒居中偏移", () => {
    expect(petCss).toMatch(/\.pet\s*\{[^}]*width:\s*calc\(110px \* var\(--pet-scale, 1\)\)/s);
    expect(petCss).toMatch(/\.pet\s*\{[^}]*height:\s*calc\(100px \* var\(--pet-scale, 1\)\)/s);
    expect(petCss).toMatch(/\.pet-3d\s*\{[^}]*width:\s*100%/s);
  });

  it("有 sprite 的角色(cat)走序列帧层,不渲染内联 SVG 造型", () => {
    const { container } = render(<Pet />); // 默认 kind=cat
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.querySelector(".pet-3d > .pet-sprite")).not.toBeNull();
    expect(pet.querySelector(".pet-3d > svg")).toBeNull();
  });

  it("无 sprite 的角色(shiba)回退内联 SVG,不渲染 sprite 层", () => {
    localStorage.setItem(PET_KIND_KEY, "shiba");
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.querySelector(".pet-3d > .pet-sprite")).toBeNull();
    expect(pet.querySelector(".pet-3d > svg")).not.toBeNull();
  });

  it("点击 ✕ 隐藏宠物并持久化", () => {
    const { container } = render(<Pet />);
    fireEvent.click(container.querySelector(".pet-x")!);
    expect(container.querySelector(".pet")).toBeNull();
    expect(usePetStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(PET_ENABLED_KEY)).toBe("0");
  });

  it("perch 模式找不到输入框:回退全身造型(不带 is-perched)", () => {
    localStorage.setItem(PET_MODE_KEY, "perch");
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet")!;
    expect(pet.getAttribute("data-mode")).toBe("perch");
    expect(pet.classList.contains("is-perched")).toBe(false);
  });

  it("perch 模式锚定 .composer-wrap:渲染专属趴姿 + 前爪", () => {
    localStorage.setItem(PET_MODE_KEY, "perch");
    const anchor = document.createElement("div");
    anchor.className = "composer-wrap";
    anchor.getBoundingClientRect = () =>
      ({ left: 100, top: 500, width: 400, height: 120, right: 500, bottom: 620, x: 100, y: 500, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(anchor);
    try {
      const { container } = render(<Pet />);
      const pet = container.querySelector(".pet.is-perched");
      expect(pet).not.toBeNull();
      // 专属趴姿:两只垂搭前爪
      expect(pet!.querySelectorAll(".perch-paw").length).toBe(2);
      // 头部中心(x=60,比例 104/140)水平居中于 composer;框沿基线对齐输入框上沿
      expect(parseFloat((pet as HTMLElement).style.left)).toBeCloseTo(100 + 200 - 60 * (104 / 140), 0);
      expect(parseFloat((pet as HTMLElement).style.top)).toBeCloseTo(500 - 80 * (104 / 140), 0);
    } finally {
      anchor.remove();
    }
  });
});
