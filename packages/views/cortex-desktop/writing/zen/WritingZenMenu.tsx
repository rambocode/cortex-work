// 禅模式左下角悬浮菜单(对齐目标截图):圆形月亮按钮 + 上弹菜单。
// 菜单五行分三组:背景图像(点击循环切照片,右侧显示「k / N」游标)/ 将设置还原成默认 |
// 开关背景音 / 背景音(点击循环切音色)| 退出禅模式。
// 切换类行点击后菜单保持打开(便于连续循环预览),仅「退出禅模式」收起;外点/Esc/移出自动收起走
// useDismissableMenu。状态直读写作 spaces store;背景照片清单是动态资产,由 WritingWorkspace
// 经 props 注入(主进程枚举 resources/zen/backgrounds)。
import type { ReactElement } from "react";
import { Image as ImageIcon, MoonStar, Music2, Paintbrush } from "lucide-react";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useDismissableMenu } from "../../personal/shared/useDismissableMenu";
import { indexInList, nextInList, nextZenSoundId, zenSoundById } from "./zen-presets";

export interface WritingZenMenuProps {
  // 背景照片 id 清单(主进程资产枚举);空表(web 壳/资产缺失)时背景行禁用。
  backgroundIds: string[];
}

export function WritingZenMenu({ backgroundIds }: WritingZenMenuProps): ReactElement {
  const zenBackgroundId = useWritingSpacesStore((s) => s.zenBackgroundId);
  const zenSoundOn = useWritingSpacesStore((s) => s.zenSoundOn);
  const zenSoundId = useWritingSpacesStore((s) => s.zenSoundId);
  const setZenMode = useWritingSpacesStore((s) => s.setZenMode);
  const setZenBackground = useWritingSpacesStore((s) => s.setZenBackground);
  const setZenSoundOn = useWritingSpacesStore((s) => s.setZenSoundOn);
  const setZenSound = useWritingSpacesStore((s) => s.setZenSound);
  const resetZenSettings = useWritingSpacesStore((s) => s.resetZenSettings);
  const menu = useDismissableMenu();

  const sound = zenSoundById(zenSoundId);
  const canCycleBackground = backgroundIds.length > 1;

  return (
    <div
      className="pw-zen-fab-wrap"
      ref={menu.wrapRef}
      onMouseEnter={menu.onMouseEnter}
      onMouseLeave={menu.onMouseLeave}
    >
      {menu.open ? (
        <div className="pw-zen-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="pw-zen-menu-item"
            disabled={!canCycleBackground}
            title="点击切换下一张背景照片"
            onClick={() => {
              const next = nextInList(backgroundIds, zenBackgroundId);
              if (next) setZenBackground(next);
            }}
          >
            <span>背景图像</span>
            <span className="pw-zen-menu-r">
              {backgroundIds.length > 0 ? (
                <span className="pw-zen-menu-val">
                  {`${indexInList(backgroundIds, zenBackgroundId)} / ${backgroundIds.length}`}
                </span>
              ) : null}
              <ImageIcon size={16} strokeWidth={1.75} />
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pw-zen-menu-item"
            onClick={() => resetZenSettings()}
          >
            <span>将设置还原成默认</span>
            <span className="pw-zen-menu-r">
              <Paintbrush size={16} strokeWidth={1.75} />
            </span>
          </button>
          <div className="pw-zen-menu-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={zenSoundOn}
            className="pw-zen-menu-item"
            onClick={() => setZenSoundOn(!zenSoundOn)}
          >
            <span>开关“背景音”</span>
            <span className="pw-zen-menu-r">
              {/* 纯视觉开关(整行都是点击热区),形态对齐系统 toggle。 */}
              <span className={`pw-zen-switch${zenSoundOn ? " is-on" : ""}`} aria-hidden />
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pw-zen-menu-item"
            title={`当前:${sound.name},点击切换下一种背景音`}
            onClick={() => setZenSound(nextZenSoundId(zenSoundId))}
          >
            <span>背景音</span>
            <span className="pw-zen-menu-r">
              <span className="pw-zen-menu-val">{sound.name}</span>
              <Music2 size={16} strokeWidth={1.75} />
            </span>
          </button>
          <div className="pw-zen-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="pw-zen-menu-item"
            onClick={() => {
              menu.setOpen(false);
              setZenMode(false);
            }}
          >
            <span>退出禅模式</span>
            <span className="pw-zen-menu-r">
              <MoonStar size={16} strokeWidth={1.75} />
            </span>
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="pw-zen-fab"
        title="禅模式设置"
        aria-label="禅模式设置"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.setOpen((v) => !v)}
      >
        <MoonStar size={18} strokeWidth={1.75} />
      </button>
    </div>
  );
}
