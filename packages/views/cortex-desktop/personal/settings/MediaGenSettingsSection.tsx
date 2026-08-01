// 媒体生成设置分区（壳）：总览说明卡 + 四张模态卡组装。
//
// 实现全部在 ./media-gen/ 子目录（1200 行红线拆分）：
//   · useMediaGenProviders —— 媒体供应商目录 × Provider 认证快照的数据层；
//   · MediaGenRows        —— 共享行（Provider/Protocol/BaseUrl/Model/Format/Timeout）；
//   · MediaSecretKeyField —— 密钥金库控件（明文不落 store，只写 ${secret:NAME} 引用）；
//   · ImageGenCard / SpeechGenCard / MusicGenCard / VideoGenCard —— 各模态卡。
// 供应商下拉数据源是 core 的 MEDIA_PROVIDER_DIRECTORY（不再读旧 providerSettings.providers）。

import { useTranslation } from "@cortex-work/core/i18n";

import { SettingCard } from "./settingsControls";
import { ImageGenCard } from "./media-gen/ImageGenCard";
import { SpeechGenCard } from "./media-gen/SpeechGenCard";
import { MusicGenCard } from "./media-gen/MusicGenCard";
import { VideoGenCard } from "./media-gen/VideoGenCard";

export function MediaGenSettingsSection() {
  const { t } = useTranslation("settings");

  return (
    <>
      {/* 总览说明卡 */}
      <SettingCard title={t("mediaGen.overviewCard")}>
        <div className="pw-srow-desc">{t("mediaGen.overviewDesc")}</div>
      </SettingCard>

      <ImageGenCard />
      <SpeechGenCard />
      <MusicGenCard />
      <VideoGenCard />
    </>
  );
}
