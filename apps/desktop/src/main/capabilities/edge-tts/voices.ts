import type { TtsVoiceOption } from "../../ipc/types";
import { EDGE_TTS_TRUSTED_CLIENT_TOKEN } from "./drm";

const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${EDGE_TTS_TRUSTED_CLIENT_TOKEN}`;
let cachedVoices: TtsVoiceOption[] | null = null;

/** 音色目录近乎不变，进程内缓存避免每次打开设置都请求微软服务。 */
export async function listEdgeTtsVoices(): Promise<TtsVoiceOption[]> {
  if (cachedVoices) return cachedVoices;
  const res = await fetch(VOICES_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Edge TTS 音色列表 HTTP ${res.status}`);
  const data = await res.json() as Array<{ ShortName?: unknown; FriendlyName?: unknown; Locale?: unknown }>;
  const voices = data.flatMap((item) => {
    if (typeof item.ShortName !== "string" || !item.ShortName) return [];
    // FriendlyName 形如「Microsoft Xiaobei Online (Natural) - Chinese (Northeastern Mandarin)」，
    // "Online (Natural)" 在中间而非结尾，剥离用的正则不能带 $ 锚定，否则整条替换是空操作。
    const label = typeof item.FriendlyName === "string"
      ? item.FriendlyName.replace(/^Microsoft\s+/i, "").replace(/\s+Online \(Natural\)/i, "").trim()
      : undefined;
    return [{ id: item.ShortName, ...(label ? { label } : {}), ...(typeof item.Locale === "string" ? { locale: item.Locale } : {}) }];
  });
  voices.sort((a, b) => Number(b.locale?.startsWith("zh")) - Number(a.locale?.startsWith("zh")) || a.id.localeCompare(b.id));
  cachedVoices = voices;
  return voices;
}
