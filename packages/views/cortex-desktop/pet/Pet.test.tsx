import { cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePetStore, type DesktopBridge } from "@cortex-work/core";
import { PET_ENABLED_KEY } from "./behavior";
import { PET_KIND_KEY, PET_SIZE_KEY } from "./designs";
import { Pet } from "./Pet";
import { PetBridge } from "./PetBridge";

function resetStore() {
  usePetStore.setState({
    state: "idle",
    kind: "cat",
    enabled: true,
    size: 1,
    lastActivity: Date.now(),
  });
}

const petCss = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");
const TEST_WS_ID = "test-ws";
const TEST_IDENTITY = { userId: "me", name: "我" };

describe("Pet", () => {
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

  it("拖拽时根节点坐标更新并持久化", () => {
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

  // 节拍器是当前唯一的衰减驱动:安静足够久后自动进入 sleeping。
  it("安静满 2 分钟后进入 sleeping", () => {
    vi.useFakeTimers();
    render(<Pet />);
    act(() => {
      usePetStore.setState({ lastActivity: Date.now() - 121_000 });
      vi.advanceTimersByTime(600);
    });
    expect(usePetStore.getState().state).toBe("sleeping");
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

  // 独立 pet-overlay 窗口专用模式:宠物固定居中在一个刚好包住它的小窗口里,挪动窗口本身
  // (原生 app-region:drag)而不是在窗口内部用 CSS 拖拽——多显示器下靠 CSS 在一个铺满全屏
  // 的透明窗口内挪动会被 macOS 裁剪,原生窗口拖拽不受此限(见 Pet.tsx/pet-overlay-window.ts
  // 头部注释)。
  describe("windowFollowsPet(独立 pet-overlay 窗口)", () => {
    it("只消费主窗口同步状态,不使用 overlay 页面的 localStorage 覆盖", () => {
      localStorage.setItem(PET_KIND_KEY, "dog");
      localStorage.setItem(PET_SIZE_KEY, "1.5");
      localStorage.setItem(PET_ENABLED_KEY, "0");
      act(() => usePetStore.setState({ kind: "mint", size: 2, enabled: true }));

      render(<Pet windowFollowsPet />);

      expect(usePetStore.getState()).toMatchObject({ kind: "mint", size: 2, enabled: true });
    });

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

    it("点击仍触发 happy(未经自定义拖拽判定,onPointerDown 整个跳过)", () => {
      const { container } = render(<Pet windowFollowsPet />);
      const pet = container.querySelector(".pet") as HTMLElement;
      fireEvent.pointerDown(pet, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerUp(pet, { clientX: 10, clientY: 10, pointerId: 1 });
      expect(usePetStore.getState().state).toBe("happy");
    });

    it("点击关闭时通知 overlay 宿主同步主窗口设置", () => {
      const onEnabledChange = vi.fn();
      const { container } = render(<Pet windowFollowsPet onEnabledChange={onEnabledChange} />);

      fireEvent.click(container.querySelector(".pet-x")!);

      expect(onEnabledChange).toHaveBeenCalledOnce();
      expect(onEnabledChange).toHaveBeenCalledWith(false);
    });
  });
});

describe("PetBridge", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });
  afterEach(() => cleanup());

  it("首次同步前从主窗口 localStorage 恢复宠物设置", () => {
    localStorage.setItem(PET_KIND_KEY, "mint");
    localStorage.setItem(PET_SIZE_KEY, "2");
    localStorage.setItem(PET_ENABLED_KEY, "0");
    const reportPetState = vi.fn();
    const bridge = { reportPetState } as unknown as DesktopBridge;

    render(
      <CoreProvider wsId={TEST_WS_ID} identity={TEST_IDENTITY} desktopBridge={bridge}>
        <PetBridge />
      </CoreProvider>,
    );

    expect(reportPetState).toHaveBeenCalledTimes(1);
    expect(reportPetState).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "mint", size: 2, enabled: false }),
    );
  });

  it("接收 overlay 的隐藏动作后更新主窗口状态并持久化", () => {
    let onEnabledChange: ((enabled: boolean) => void) | undefined;
    const bridge = {
      reportPetState: vi.fn(),
      onPetEnabledChange: vi.fn((cb: (enabled: boolean) => void) => {
        onEnabledChange = cb;
        return vi.fn();
      }),
    } as unknown as DesktopBridge;

    render(
      <CoreProvider wsId={TEST_WS_ID} identity={TEST_IDENTITY} desktopBridge={bridge}>
        <PetBridge />
      </CoreProvider>,
    );
    act(() => onEnabledChange?.(false));

    expect(usePetStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(PET_ENABLED_KEY)).toBe("0");
  });
});
