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
    // sprite 必须一并归位:用例里换成 petdex 造型后残留下去,后面按内置 110:100 算
    // 高度的断言会拿到 petdex 的 192:208 比例。
    sprite: null,
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

  // 原生 title 在独立 overlay 窗口里几乎不可用(窗口 focusable:false、尺寸小到会把
  // tooltip 裁掉),状态提示改为自绘气泡,由姿态变化主动触发。
  describe("状态气泡", () => {
    it("首次挂载不弹——开机就冒一句「在待命」是噪音", () => {
      const { container } = render(<Pet />);
      expect(container.querySelector(".pet-tip")?.className).not.toContain("is-open");
    });

    it("姿态变化时冒泡,并在 TIP_MS 后自动收起", () => {
      vi.useFakeTimers();
      const { container } = render(<Pet />);

      act(() => usePetStore.setState({ state: "thinking" }));
      const tip = container.querySelector(".pet-tip") as HTMLElement;
      expect(tip.className).toContain("is-open");
      expect(tip.textContent).toContain("思考");

      act(() => vi.advanceTimersByTime(3200));
      expect(container.querySelector(".pet-tip")?.className).not.toContain("is-open");
    });

    it("悬停时常显,移开即收", () => {
      const { container } = render(<Pet />);
      const pet = container.querySelector(".pet") as HTMLElement;

      fireEvent.pointerEnter(pet);
      expect(container.querySelector(".pet-tip")?.className).toContain("is-open");

      fireEvent.pointerLeave(pet);
      expect(container.querySelector(".pet-tip")?.className).not.toContain("is-open");
    });
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
    // 造型层里不得再有 SVG(缩放手柄的图标 svg 在造型层之外,不算造型)。
    expect(pet.querySelector(".pet-3d svg")).toBeNull();
  });

  // petdex 的 sheet 没有睡眠行,这是唯一保留的 DOM 配件。
  it("保留 Zzz 配件用于睡眠语义", () => {
    const { container } = render(<Pet />);
    expect(container.querySelector(".pet-3d > .pet-zzz")).not.toBeNull();
  });

  // 尺寸调节从设置页搬到宠物本体的右下角手柄上(设置页不再有滑块)。
  describe("缩放手柄", () => {
    it("内嵌模式:拖动改尺寸并直接落盘", () => {
      const { container } = render(<Pet />);
      const pet = container.querySelector(".pet") as HTMLElement;
      const handle = container.querySelector(".pet-resize") as HTMLElement;

      fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 40, clientY: 40, pointerId: 1 });
      // 拖拽中先走本地草稿(store 未变),松手才提交——overlay 下这一步防止被广播顶回。
      // 110(PET_W) + 40 = 150 → size 取两位小数 1.36 → 回算宽度 149.6
      expect(parseFloat(pet.style.width)).toBeCloseTo(149.6, 1);
      expect(usePetStore.getState().size).toBe(1);

      fireEvent.pointerUp(handle, { clientX: 40, clientY: 40, pointerId: 1 });
      // 110(PET_W) + 40 = 150 → 150/110 ≈ 1.36
      expect(usePetStore.getState().size).toBeCloseTo(1.36, 2);
      expect(localStorage.getItem(PET_SIZE_KEY)).toBe("1.36");
    });

    it("尺寸夹在合法区间内,拖过头不会超过上限", () => {
      const { container } = render(<Pet />);
      const handle = container.querySelector(".pet-resize") as HTMLElement;

      fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 900, clientY: 900, pointerId: 1 });

      expect(usePetStore.getState().size).toBe(2);
    });

    it("拖手柄不冒泡成「逗宠物」", () => {
      const { container } = render(<Pet />);
      const handle = container.querySelector(".pet-resize") as HTMLElement;

      fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 20, clientY: 20, pointerId: 1 });

      expect(petActivity.snapshot().celebrate).toBe(false);
    });

    it("overlay 模式:回写宿主而不是写自己的 localStorage(两页面 storage 不同源)", () => {
      const onSizeChange = vi.fn();
      const { container } = render(<Pet windowFollowsPet onSizeChange={onSizeChange} />);
      const handle = container.querySelector(".pet-resize") as HTMLElement;

      fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 40, clientY: 40, pointerId: 1 });

      // 居中定位下右下角只走宽度增量的一半,故位移要乘 2:110 + 80 = 190 → ≈1.73
      expect(onSizeChange).toHaveBeenCalledOnce();
      expect(onSizeChange.mock.calls[0]?.[0]).toBeCloseTo(1.73, 2);
      expect(localStorage.getItem(PET_SIZE_KEY)).toBeNull();
    });
  });

  // 参考实现(hermes-studio)的三个手感:拖着走时朝方向奔跑、双击再庆祝一次、滚轮缩放。
  describe("互动手感", () => {
    // data-sheet 是 `${spriteId}:${row}`,行号即方向:1 朝右、2 朝左、0 是 idle。
    // 内置角色没有奔跑资产,必须用 petdex sprite 才验得到。
    it("拖动时朝拖动方向播奔跑行,往回拖会翻转,松手回到原姿态", () => {
      act(() =>
        usePetStore.setState({
          sprite: { origin: "petdex", id: "dog", url: "cortex-petdex://dog.webp", cols: 8, rows: 9, displayName: "Dog" },
        }),
      );
      const { container } = render(<Pet />);
      const pet = container.querySelector(".pet") as HTMLElement;
      const canvas = pet.querySelector("canvas.pet-canvas") as HTMLCanvasElement;
      pet.getBoundingClientRect = () =>
        ({ left: 100, top: 200, width: 110, height: 100, right: 210, bottom: 300, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect;
      expect(canvas.getAttribute("data-sheet")).toBe("dog:0");

      fireEvent.pointerDown(pet, { clientX: 110, clientY: 220, pointerId: 1 });
      fireEvent.pointerMove(pet, { clientX: 170, clientY: 220, pointerId: 1 });
      expect(canvas.getAttribute("data-sheet")).toBe("dog:1");

      // 往回拖:用「与上一帧的位移」判方向才能翻转(与起点比的话符号还没变过来)
      fireEvent.pointerMove(pet, { clientX: 130, clientY: 220, pointerId: 1 });
      expect(canvas.getAttribute("data-sheet")).toBe("dog:2");

      fireEvent.pointerUp(pet, { clientX: 130, clientY: 220, pointerId: 1 });
      expect(canvas.getAttribute("data-sheet")).toBe("dog:0");
    });

    it("双击再逗一次:重置帧游标让庆祝动作从头播", () => {
      const { container } = render(<Pet />);
      const pet = container.querySelector(".pet") as HTMLElement;

      fireEvent.doubleClick(pet);

      expect(petActivity.snapshot().celebrate).toBe(true);
    });

    it("滚轮缩放:即时预览,停手后才落盘一次", () => {
      vi.useFakeTimers();
      const { container } = render(<Pet />);
      const pet = container.querySelector(".pet") as HTMLElement;

      fireEvent.wheel(pet, { deltaY: -100 }); // 上滚 = 放大
      fireEvent.wheel(pet, { deltaY: -100 });
      // 滚动过程中只走草稿:store 与磁盘都不动,免得几十个 wheel 事件把盘写爆
      expect(parseFloat(pet.style.width)).toBeCloseTo(110 * 1.1, 1);
      expect(usePetStore.getState().size).toBe(1);
      expect(localStorage.getItem(PET_SIZE_KEY)).toBeNull();

      act(() => vi.advanceTimersByTime(260));
      expect(usePetStore.getState().size).toBeCloseTo(1.1, 2);
      expect(localStorage.getItem(PET_SIZE_KEY)).toBe("1.1");
    });

    it("滚轮缩放同样夹在合法区间内", () => {
      vi.useFakeTimers();
      const { container } = render(<Pet />);
      const pet = container.querySelector(".pet") as HTMLElement;

      for (let i = 0; i < 40; i += 1) fireEvent.wheel(pet, { deltaY: 100 }); // 一路缩小
      act(() => vi.advanceTimersByTime(260));

      expect(usePetStore.getState().size).toBe(0.8);
    });
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
      // OVERLAY_WINDOW_W/H = 260/304,size=1 时宠物 110x100,居中偏移 = (260-110)/2, (304-100)/2
      expect(parseFloat(pet.style.left)).toBe(75);
      expect(parseFloat(pet.style.top)).toBe(102);
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

    // 这扇窗口 focusable:false + 整块 app-region:drag,渲染进程收不到鼠标移动事件,
    // :hover / pointerEnter 永远不触发(实测:必须右键点一下 ✕ 和手柄才冒出来)。悬停态
    // 改由主进程轮询光标推坐标过来算(见 main/pet-overlay-window.ts)。
    describe("externalCursor(主进程推来的光标坐标)", () => {
      function stubRect(pet: HTMLElement) {
        pet.getBoundingClientRect = () =>
          ({ left: 75, top: 102, width: 110, height: 100, right: 185, bottom: 202, x: 75, y: 102, toJSON: () => ({}) }) as DOMRect;
      }

      // overlay 形态必须让 CSS :hover 整体让位:Chromium 的 :hover 会卡在上一次命中测试的
      // 元素上(收不到移动事件就永不撤销),两套规则并存的结果是「按一下之后手柄再也不消失」。
      it("overlay 根节点标 is-window-pet,由 CSS 关掉 :hover 那套规则", () => {
        const { container } = render(<Pet windowFollowsPet />);
        expect((container.querySelector(".pet") as HTMLElement).className).toContain("is-window-pet");
        expect(petCss).toMatch(/\.pet:not\(\.is-window-pet\):hover \.pet-resize/);
        // 内嵌模式不加这个 class,:hover 照常生效
        cleanup();
        const web = render(<Pet />);
        expect((web.container.querySelector(".pet") as HTMLElement).className).not.toContain("is-window-pet");
      });

      it("光标落在宠物上时加 is-hovered,移开即撤", () => {
        const { container, rerender } = render(<Pet windowFollowsPet externalCursor={null} />);
        const pet = container.querySelector(".pet") as HTMLElement;
        stubRect(pet);

        rerender(<Pet windowFollowsPet externalCursor={{ x: 130, y: 150 }} />);
        expect(pet.className).toContain("is-hovered");

        rerender(<Pet windowFollowsPet externalCursor={{ x: 5, y: 5 }} />);
        expect(pet.className).not.toContain("is-hovered");

        // 光标离开窗口(null)也要收起来,否则悬停态会一直挂着
        rerender(<Pet windowFollowsPet externalCursor={{ x: 130, y: 150 }} />);
        rerender(<Pet windowFollowsPet externalCursor={null} />);
        expect(pet.className).not.toContain("is-hovered");
      });

      it("拖手柄期间同一份坐标兼作缩放输入(pointermove 是否送达不确定,这是更可靠的一路)", () => {
        const { container, rerender } = render(<Pet windowFollowsPet externalCursor={null} />);
        const pet = container.querySelector(".pet") as HTMLElement;
        stubRect(pet);
        const handle = container.querySelector(".pet-resize") as HTMLElement;

        fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
        rerender(<Pet windowFollowsPet externalCursor={{ x: 40, y: 40 }} />);

        // 居中定位下位移乘 2:110 + 80 = 190 → size 1.73 → 宽度 190.3
        expect(parseFloat(pet.style.width)).toBeCloseTo(190.3, 1);
      });
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

  it("接收 overlay 缩放手柄的尺寸后更新主窗口状态并持久化", () => {
    let onSizeChange: ((size: number) => void) | undefined;
    const bridge = {
      reportPetState: vi.fn(),
      onPetSizeChange: vi.fn((cb: (size: number) => void) => {
        onSizeChange = cb;
        return vi.fn();
      }),
    } as unknown as DesktopBridge;

    render(
      <CoreProvider wsId={TEST_WS_ID} identity={TEST_IDENTITY} desktopBridge={bridge}>
        <PetBridge />
      </CoreProvider>,
    );
    act(() => onSizeChange?.(1.5));

    expect(usePetStore.getState().size).toBe(1.5);
    expect(localStorage.getItem(PET_SIZE_KEY)).toBe("1.5");
  });
});
