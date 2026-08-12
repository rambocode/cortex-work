// 禅模式预设:环境音清单(对应桌面端 resources/zen/sounds/*.mp3,取自 Metion zen 资源)
// 与背景/音色的循环切换工具。背景照片清单是**动态**的 —— 由主进程枚举 resources/zen/backgrounds
// 返回 id 列表(bridge.writingZenAssets),此处只提供列表上的循环游标,不落任何硬编码背景 id。
// id 持久化在 WritingUiState(spaces store 的 zenBackgroundId / zenSoundId);脏值兜底:
// 背景由主进程 show 时回落清单首张,音色由 zenSoundById 回落清单首项。

// 一种环境音:id = mp3 文件名去后缀;name 为菜单展示名。
export interface ZenSound {
  id: string;
  name: string;
}

// 与 resources/zen/sounds 的 8 首 mp3 一一对应(缺文件时播放静默失败,菜单仍可切换)。
export const ZEN_SOUNDS: ZenSound[] = [
  { id: "morning_bird", name: "晨莺" },
  { id: "rain", name: "细雨" },
  { id: "sea_and_wind", name: "海风" },
  { id: "sea_and_bird", name: "海鸟" },
  { id: "summer_night", name: "夏夜" },
  { id: "summer_cicada", name: "夏蝉" },
  { id: "morning_city", name: "晨市" },
  { id: "mixed_nature", name: "山野" },
];

// 按 id 查找背景音;脏值回落清单首项(默认「晨莺」)。
export function zenSoundById(id: string): ZenSound {
  return ZEN_SOUNDS.find((s) => s.id === id) ?? ZEN_SOUNDS[0]!;
}

// 循环取下一个背景音 id(菜单「背景音」点击即切换)。
export function nextZenSoundId(id: string): string {
  const idx = ZEN_SOUNDS.findIndex((s) => s.id === id);
  return ZEN_SOUNDS[(idx + 1) % ZEN_SOUNDS.length]!.id;
}

// 动态清单上的循环游标(背景照片用):当前 id 不在清单(含空串)视为首项。清单空回 null。
export function nextInList(ids: string[], currentId: string): string | null {
  if (ids.length === 0) return null;
  const idx = ids.indexOf(currentId);
  return ids[(idx + 1) % ids.length]!;
}

// 当前 id 在清单中的序号(1 起,用于菜单「k / N」展示);不在清单视为首项。
export function indexInList(ids: string[], currentId: string): number {
  const idx = ids.indexOf(currentId);
  return idx >= 0 ? idx + 1 : 1;
}
