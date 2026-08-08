// KWS 隐藏窗口入口：读配置 → 加载 openWakeWord 三级模型 → 常驻采集推理 → 命中上报。
//
// 隐私红线：本窗口零落盘、零文本日志；音频只在内存滚动分析，跨 IPC 的仅有概率分数与
// 状态枚举（见 preload/kws.ts）。判定策略：概率 ≥ 灵敏度阈值 + 连续 2 帧确认（抑制单帧
// 毛刺）+ 主进程侧 2s 冷却。suspend（语音助手活跃期）只停推理不放流：track 保持打开，
// 避免设备重新上电延迟；macOS 橙点常亮本身就是"正在监听"的系统级指示。

import * as ort from "onnxruntime-web";
import type { KwsRunState } from "../../../preload/kws";
import { startKwsCapture, type KwsCapture } from "./capture";
import { createOpenWakeWordPipeline, type OpenWakeWordPipeline } from "./openWakeWord";

interface WakeWordConfig {
  enabled: boolean;
  wordId: "hey-jarvis";
  sensitivity: "low" | "medium" | "high";
}

interface KwsApi {
  getConfig(): Promise<WakeWordConfig>;
  reportHit(score: number): void;
  reportState(state: KwsRunState): void;
  onControl(cb: (action: "suspend" | "resume") => void): () => void;
  onConfigChanged(cb: (settings: WakeWordConfig) => void): () => void;
}

// 灵敏度 → 概率阈值（与设置页文案一致：越高越易触发也越易误唤醒）。
const THRESHOLD_BY_SENSITIVITY = { low: 0.7, medium: 0.5, high: 0.35 } as const;
const CONFIRM_FRAMES = 2;
const WORD_MODEL_BY_ID = { "hey-jarvis": "hey_jarvis_v0.1.onnx" } as const;

// dev 页面是 http://localhost（同源 /kws/、/vad/ 由 vite 中间件服务）；打包态是 file://，
// 走主进程只读协议。wasm 复用 vad 目录那份（版本经 package.json pin 对齐，不重复打包）。
const packaged = location.protocol === "file:";
const KWS_BASE = packaged ? "cortex-kws://assets/" : "/kws/";
const VAD_BASE = packaged ? "cortex-vad://assets/" : "/vad/";

const api = (window as unknown as { desktopAPI?: { kws?: KwsApi } }).desktopAPI?.kws;

async function boot(): Promise<void> {
  if (!api) return; // 预期外的裸加载（无 preload）：静默退出
  let suspended = false;
  let capture: KwsCapture | null = null;
  let pipeline: OpenWakeWordPipeline | null = null;
  let threshold: number = THRESHOLD_BY_SENSITIVITY.medium;
  let overCount = 0;
  // 推理串行化：ScriptProcessor 回调快于 wasm 推理时丢帧而不是排队（排队会越积越远）。
  let busy = false;

  api.onControl((action) => {
    suspended = action === "suspend";
    pipeline?.reset();
    overCount = 0;
    api.reportState(suspended ? "suspended" : "running");
  });
  api.onConfigChanged((settings) => {
    threshold = THRESHOLD_BY_SENSITIVITY[settings.sensitivity] ?? THRESHOLD_BY_SENSITIVITY.medium;
  });

  try {
    api.reportState("starting");
    const config = await api.getConfig();
    threshold = THRESHOLD_BY_SENSITIVITY[config.sensitivity] ?? THRESHOLD_BY_SENSITIVITY.medium;
    // onnxruntime-web 的 wasm 资产基址；单线程避免 COOP/COEP 头要求。
    ort.env.wasm.wasmPaths = VAD_BASE;
    ort.env.wasm.numThreads = 1;
    pipeline = await createOpenWakeWordPipeline(KWS_BASE, WORD_MODEL_BY_ID[config.wordId]);
    capture = await startKwsCapture((chunk) => {
      if (suspended || busy || !pipeline) return;
      busy = true;
      void pipeline
        .push(chunk)
        .then((score) => {
          busy = false;
          if (score === null || suspended) return;
          // 连续 2 帧确认：单帧毛刺（关门声、电视爆音）不触发。
          overCount = score >= threshold ? overCount + 1 : 0;
          if (overCount >= CONFIRM_FRAMES) {
            overCount = 0;
            pipeline?.reset();
            api.reportHit(score);
          }
        })
        .catch(() => {
          busy = false;
        });
    });
    api.reportState("running");
  } catch {
    // 模型缺失(未跑 prepare 脚本)/权限被拒/wasm 初始化失败：明确降级，不无限重试。
    capture?.stop();
    api.reportState("degraded");
  }
}

void boot();
