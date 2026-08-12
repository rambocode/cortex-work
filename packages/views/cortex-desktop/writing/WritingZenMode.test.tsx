// 禅模式单测:工具栏入口 → store 瞬态开关与偏好持久化 → 左下菜单交互 → 预设/游标工具。
// 全屏效果(幕布窗口/隐菜单栏/去绿灯)在主进程,窗口内样式是 CSS,这里守住的是
// 「入口按钮 / 偏好序列化口径(zenMode 瞬态不落盘)/ 菜单行为 / 循环游标」几条接线。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WritingToolbar } from "./WritingToolbar";
import { WritingZenMenu } from "./zen/WritingZenMenu";
import { ZEN_SOUNDS, indexInList, nextInList, nextZenSoundId, zenSoundById } from "./zen/zen-presets";
import {
  WRITING_ZEN_BACKGROUND_DEFAULT,
  WRITING_ZEN_SOUND_DEFAULT,
  useWritingSpacesStore,
} from "@cortex-work/core/writing/spaces";

afterEach(cleanup);
beforeEach(() => {
  useWritingSpacesStore.setState({
    zenMode: false,
    zenBackgroundId: WRITING_ZEN_BACKGROUND_DEFAULT,
    zenSoundOn: false,
    zenSoundId: WRITING_ZEN_SOUND_DEFAULT,
  });
});

// 工具栏公共 props(仅禅模式入口相关字段在各用例内变化)。
const toolbarProps = {
  fileName: "a.md",
  fileLabel: "a.md",
  charCount: 3,
  mode: "rich" as const,
  onModeChange: vi.fn(),
  fontSizePx: 16,
  saveStatus: "idle" as const,
  saveLabel: "已保存",
  onSave: vi.fn(),
};

describe("禅模式", () => {
  it("顶栏入口按钮触发 onEnterZen;无文本文件时不渲染", () => {
    const onEnterZen = vi.fn();
    render(<WritingToolbar {...toolbarProps} hasTextFile onEnterZen={onEnterZen} />);
    fireEvent.click(screen.getByLabelText("进入禅模式"));
    expect(onEnterZen).toHaveBeenCalledTimes(1);

    cleanup();
    render(<WritingToolbar {...toolbarProps} hasTextFile={false} onEnterZen={onEnterZen} />);
    expect(screen.queryByLabelText("进入禅模式")).toBeNull();
  });

  it("偏好进出持久化分片;zenMode 瞬态不落盘、回灌一律回普通态", () => {
    const s = useWritingSpacesStore.getState();
    s.setZenMode(true);
    s.setZenBackground("unsplash-Ellen Qin");
    s.setZenSoundOn(true);
    s.setZenSound("rain");
    const persisted = useWritingSpacesStore.getState().serialize();
    // zenMode 不进分片(瞬态);三项偏好落盘。
    expect("zenMode" in persisted).toBe(false);
    expect(persisted.zenBackgroundId).toBe("unsplash-Ellen Qin");
    expect(persisted.zenSoundOn).toBe(true);
    expect(persisted.zenSoundId).toBe("rain");

    useWritingSpacesStore.getState().hydrate(persisted);
    const after = useWritingSpacesStore.getState();
    expect(after.zenMode).toBe(false); // 处于禅模式时落盘,重启后也回普通态
    expect(after.zenBackgroundId).toBe("unsplash-Ellen Qin");
    expect(after.zenSoundOn).toBe(true);
    expect(after.zenSoundId).toBe("rain");

    // 旧档缺字段回落默认。
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null });
    const legacy = useWritingSpacesStore.getState();
    expect(legacy.zenBackgroundId).toBe(WRITING_ZEN_BACKGROUND_DEFAULT);
    expect(legacy.zenSoundOn).toBe(false);
    expect(legacy.zenSoundId).toBe(WRITING_ZEN_SOUND_DEFAULT);
  });

  it("菜单:循环切背景 / 开关背景音 / 循环切背景音 / 还原默认 / 退出", () => {
    useWritingSpacesStore.getState().setZenMode(true);
    render(<WritingZenMenu backgroundIds={["bg-a", "bg-b", "bg-c"]} />);
    fireEvent.click(screen.getByLabelText("禅模式设置"));

    // 背景图像:当前 id(默认值)不在清单 → 视为首项,点击循环到清单首项。
    fireEvent.click(screen.getByText("背景图像"));
    expect(useWritingSpacesStore.getState().zenBackgroundId).toBe("bg-a");
    fireEvent.click(screen.getByText("背景图像"));
    expect(useWritingSpacesStore.getState().zenBackgroundId).toBe("bg-b");

    // 背景音开关。
    fireEvent.click(screen.getByText("开关“背景音”"));
    expect(useWritingSpacesStore.getState().zenSoundOn).toBe(true);

    // 背景音:循环到下一种音色。
    fireEvent.click(screen.getByText("背景音"));
    expect(useWritingSpacesStore.getState().zenSoundId).toBe(ZEN_SOUNDS[1]!.id);

    // 还原默认:三项偏好回默认。
    fireEvent.click(screen.getByText("将设置还原成默认"));
    const reset = useWritingSpacesStore.getState();
    expect(reset.zenBackgroundId).toBe(WRITING_ZEN_BACKGROUND_DEFAULT);
    expect(reset.zenSoundOn).toBe(false);
    expect(reset.zenSoundId).toBe(WRITING_ZEN_SOUND_DEFAULT);

    // 退出禅模式。
    fireEvent.click(screen.getByText("退出禅模式"));
    expect(useWritingSpacesStore.getState().zenMode).toBe(false);
  });

  it("背景清单为空/单张时「背景图像」行禁用", () => {
    useWritingSpacesStore.getState().setZenMode(true);
    render(<WritingZenMenu backgroundIds={["only-one"]} />);
    fireEvent.click(screen.getByLabelText("禅模式设置"));
    const row = screen.getByText("背景图像").closest("button")!;
    expect(row.hasAttribute("disabled")).toBe(true);
  });

  it("音色预设与循环游标:脏 id 回落首项(晨莺),清单游标回绕", () => {
    expect(zenSoundById("no-such").id).toBe(ZEN_SOUNDS[0]!.id);
    // 音色默认 id 必须真实存在于预设表(core 默认值与 views 预设清单的跨包契约)。
    expect(ZEN_SOUNDS.some((s) => s.id === WRITING_ZEN_SOUND_DEFAULT)).toBe(true);
    // 末项的下一个回绕到首项。
    expect(nextZenSoundId(ZEN_SOUNDS[ZEN_SOUNDS.length - 1]!.id)).toBe(ZEN_SOUNDS[0]!.id);
    // 动态清单游标:不在清单视为首项;末项回绕;空清单回 null。
    expect(nextInList(["a", "b"], "zz")).toBe("a");
    expect(nextInList(["a", "b"], "b")).toBe("a");
    expect(nextInList([], "a")).toBeNull();
    expect(indexInList(["a", "b"], "b")).toBe(2);
    expect(indexInList(["a", "b"], "zz")).toBe(1);
  });
});
