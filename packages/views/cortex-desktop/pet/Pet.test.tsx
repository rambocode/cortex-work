import { cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePetStore, type DesktopBridge } from "@cortex-work/core";
import { petActivity } from "@cortex-work/core/pet";
import { PET_ENABLED_KEY, PET_SIZE_KEY } from "./prefs";
import { Pet } from "./Pet";
import { PetBridge } from "./PetBridge";

function resetStore() {
  usePetStore.setState({
    state: "idle",
    kind: "cat",
    enabled: true,
    size: 1,
  });
}

const petCss = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");
const TEST_WS_ID = "test-ws";
const TEST_IDENTITY = { userId: "me", name: "我" };

describe("Pet", () => {
  beforeEach(() => {
    localStorage.clear();
    petActivity.__reset();
    resetStore();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // 设置的恢复归 PetBridge 一处负责(见该组件头注释),Pet 只消费 store。
  it("enabled=false 时不渲染", () => {
    act(() => usePetStore.setState({ enabled: false }));
    const { container } = render(<Pet />);
    expect(container.querySelector(".pet")).toBeNull();
  });

  it("点击(非拖拽)置庆祝位,由状态机派生成 happy——不直接写 store", () => {
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    fireEvent.pointerDown(pet, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(pet, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(petActivity.snapshot().celebrate).toBe(true);
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

  // 宽高由 JS 按 sprite 格子比例算好写在内联样式上——内置 110:100、petdex 192:208,
  // 写死在 CSS 里会让其中一种被拉变形。
  it("根节点尺寸走内联样式,CSS 不再写死宽高", () => {
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(parseFloat(pet.style.width)).toBe(110);
    expect(parseFloat(pet.style.height)).toBe(100);
    expect(petCss).not.toMatch(/\.pet\s*\{[^}]*height:\s*calc\(100px/s);
    expect(petCss).toMatch(/\.pet-3d\s*\{[^}]*width:\s*100%/s);
  });

  it("渲染 canvas 逐帧层,不再有 sprite 背景层或 SVG 造型", () => {
    const { container } = render(<Pet />);
    const pet = container.querySelector(".pet") as HTMLElement;
    expect(pet.querySelector(".pet-3d > canvas.pet-canvas")).not.toBeNull();
    expect(pet.querySelector(".pet-sprite")).toBeNull();
    expect(pet.querySelector("svg")).toBeNull();
  });

  // petdex 的 sheet 没有睡眠行,这是唯一保留的 DOM 配件。
  it("保留 Zzz 配件用于睡眠语义", () => {
    const { container } = render(<Pet />);
    expect(container.querySelector(".pet-3d > .pet-zzz")).not.toBeNull();
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
      localStorage.setItem(PET_SIZE_KEY, "1.5");
      localStorage.setItem(PET_ENABLED_KEY, "0");
      act(() => usePetStore.setState({ size: 2, enabled: true }));

      render(<Pet windowFollowsPet />);

      expect(usePetStore.getState()).toMatchObject({ size: 2, enabled: true });
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

    // overlay 里没有状态机(它是纯镜像),点击不能自己写 store——会被下一次广播顶回去。
    // 改为报给宿主做本地显示覆写(见 pet-overlay.tsx 的 pokePet)。
    it("点击报给宿主而不是写 store", () => {
      const onPoke = vi.fn();
      const { container } = render(<Pet windowFollowsPet onPoke={onPoke} />);
      const pet = container.querySelector(".pet") as HTMLElement;
      fireEvent.pointerDown(pet, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerUp(pet, { clientX: 10, clientY: 10, pointerId: 1 });
      expect(onPoke).toHaveBeenCalledOnce();
      expect(petActivity.snapshot().celebrate).toBe(false);
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
    petActivity.__reset();
    resetStore();
  });
  afterEach(() => cleanup());

  it("首次同步前从主窗口 localStorage 恢复宠物设置", () => {
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
      expect.objectContaining({ kind: "cat", size: 2, enabled: false }),
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
