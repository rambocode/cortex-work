// 禅模式背景音播放器:播放桌面端随包的真实环境音 mp3(resources/zen/sounds,取自 Metion)。
// 取数经 bridge.writingZenSoundData 拿整文件 base64 → 转 blob URL 交 <audio> 循环播放 ——
// dev 渲染端是 http origin,直接引用 file:// 会被 webSecurity 拦,故必须走 bytes 中转。
// 无 bridge 能力(web 壳)或取数失败时静默不播,菜单开关仍可切换不报错。

// 音量刻意压低:背景音是陪伴不是主角,避免盖过打字与思绪。
const VOLUME = 0.35;

export class ZenAudioEngine {
  private audio: HTMLAudioElement | null = null;
  private blobUrl: string | null = null;
  private currentId: string | null = null;
  // 播放序号:play 是异步取数,快速连点切音色时旧请求返回后按序号丢弃,避免双声道叠播。
  private seq = 0;

  // 播放指定音色;已在播同一 id 则 no-op。fetchData 由调用方注入(bridge 取 base64)。
  async play(
    soundId: string,
    fetchData: (id: string) => Promise<string | null> | undefined,
  ): Promise<void> {
    if (this.currentId === soundId && this.audio) return;
    const mySeq = ++this.seq;
    this.stop();
    this.currentId = soundId;
    let base64: string | null = null;
    try {
      base64 = (await fetchData(soundId)) ?? null;
    } catch {
      base64 = null;
    }
    // 取数期间被 stop/切曲(序号已变)则本次作废。
    if (mySeq !== this.seq || !base64) return;
    if (typeof Audio === "undefined" || typeof atob === "undefined") return;
    try {
      // base64 → bytes → blob URL(比 data: URL 省一次内存拷贝,且可显式 revoke)。
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      this.blobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      const audio = new Audio(this.blobUrl);
      audio.loop = true;
      audio.volume = VOLUME;
      this.audio = audio;
      // 播放失败(编解码/策略)静默:禅模式不该因音频弹错误。
      void audio.play().catch(() => undefined);
    } catch {
      this.stop();
    }
  }

  // 停止播放并释放 blob。
  stop(): void {
    this.seq++;
    this.currentId = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}
