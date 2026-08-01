// 媒体生成设置分区（壳）：对齐 Kun 的四 tab 分页布局——顶部「图片/语音/音乐/视频」
// 四等宽 tab 条（带图标），一次只渲染当前模态卡（Kun settings-section-media-generation 同款）。
//
// 实现全部在 ./media-gen/ 子目录（1200 行红线拆分）：
//   · useMediaGenProviders —— 媒体供应商目录 × Provider 认证快照的数据层；
//   · MediaGenRows        —— 共享行（Provider/Protocol/BaseUrl/Model/Format/Timeout）；
//   · MediaSecretKeyField —— 密钥金库控件（明文不落 store，只写 ${secret:NAME} 引用）；
//   · ImageGenCard / SpeechGenCard / MusicGenCard / VideoGenCard —— 各模态卡。
// 供应商下拉数据源是 core 的 MEDIA_PROVIDER_DIRECTORY（不再读旧 providerSettings.providers）。

import { useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";

import { ImageGenCard } from "./media-gen/ImageGenCard";
import { SpeechGenCard } from "./media-gen/SpeechGenCard";
import { MusicGenCard } from "./media-gen/MusicGenCard";
import { VideoGenCard } from "./media-gen/VideoGenCard";

type MediaGenTab = "image" | "speech" | "music" | "video";

// tab 标签复用各模态卡标题的 i18n key，避免同一文案双写。
const TABS: readonly { key: MediaGenTab; labelKey: string; icon: React.ReactNode }[] = [
  { key: "image", labelKey: "mediaGen.image.cardTitle", icon: <Icon.Image size={15} /> },
  { key: "speech", labelKey: "mediaGen.speech.cardTitle", icon: <Icon.Mic size={15} /> },
  { key: "music", labelKey: "mediaGen.music.cardTitle", icon: <Icon.Music size={15} /> },
  { key: "video", labelKey: "mediaGen.video.cardTitle", icon: <Icon.Video size={15} /> },
];

export function MediaGenSettingsSection() {
  const { t } = useTranslation("settings");
  const [tab, setTab] = useState<MediaGenTab>("image");

  return (
    <>
      <div className="pw-mediagen-tabs" role="tablist" aria-label={t("mediaGen.title")}>
        {TABS.map(({ key, labelKey, icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={key === tab}
            className={`pw-mediagen-tab ${key === tab ? "is-active" : ""}`}
            onClick={() => setTab(key)}
          >
            {icon}
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {/* 包一层作用域类：媒体生成行改为「左栏说明自适应占满、控件固定宽贴右」（对齐 Kun，
          见 cortex-desktop.css 的 .pw-mediagen-cards 规则；默认 .pw-srow-l 固定 38% 会把长说明压窄折行）。 */}
      <div className="pw-mediagen-cards">
        {tab === "image" ? <ImageGenCard /> : null}
        {tab === "speech" ? <SpeechGenCard /> : null}
        {tab === "music" ? <MusicGenCard /> : null}
        {tab === "video" ? <VideoGenCard /> : null}
      </div>
    </>
  );
}
