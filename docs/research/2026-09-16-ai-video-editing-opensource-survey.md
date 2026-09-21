# AI 视频剪辑开源方案调研（2026-09-16）

> 面向 Electron + React + TS 桌面端选型。数据来源：GitHub API / npm registry / 项目 README（2026-09-16 采集）。
> 结论与选型见 `docs/superpowers/specs/2026-09-16-ai-clip-mixcut-solution-spec.md` §2。

## A. 端到端 AI 剪辑 / 自动成片

| 项目 | Stars | 栈 | 许可 | 活跃度 | 核心能力 | Node 可调用性 | 缺点 |
|---|---|---|---|---|---|---|---|
| FireRed-OpenStoryline（小红书） | 3.4k | Python, FastAPI, MCP, ffmpeg/MoviePy | Apache-2.0 | 2026-07 | LLM/VLM 意图路由 → Storyline → MCP 原子工具（素材检索、场景检测、ASR 粗剪、转场、配乐卡点） | 本身是 MCP server | Python 运行时须随包；VLM/转场靠外部 API |
| HKUDS/VideoAgent | 1.9k | Python CLI | MIT | 2026-07 | 理解/剪辑/二创一体 | CLI，8GB VRAM | 研究向，依赖极重 |
| OpenMontage | 59k | Python skills 驱动 | AGPL-3.0 | 2026-09 | 12 条流水线、100+ 工具、700+ skill | skill 包 + CLI | AGPL |
| NarratoAI | 11.1k | Python, Streamlit | MIT | 2026-09 | VLM 逐段理解 → 解说 → TTS → 合成 | 仅 Streamlit | 单一解说场景 |
| MoneyPrinterTurbo | 124k | Python, FastAPI | MIT | 2026-09 | 主题 → 文案 → 素材 → 字幕 → 成片 | HTTP API sidecar | 是生成非剪辑 |
| FunClip（阿里） | 6.3k | Python, Gradio, FunASR | MIT | 2026-09 | Paraformer 中文 ASR + 说话人 + LLM 选段剪辑 | 无 Node 绑定 | torch 全家桶 |
| AutoCut（李沐） | 7.8k | Python, whisper | Apache-2.0 | 2024-10 停更 | 文稿剪辑最简实现 | CLI | 停更 |
| VideoLingo | 18.4k | Python | Apache-2.0 | 2026-09 | 字幕翻译配音 | Streamlit | 非剪辑 |
| ShortGPT | 8k | Python | MIT | 2025-02 停滞 | 短视频自动化框架 | CLI | 停更 |
| auto-editor | 5.2k | Nim 单二进制 | Unlicense | 2026-09 | 去静音/去无运动粗剪，导 NLE XML/JSON | 单二进制 sidecar | 只做粗剪 |
| LosslessCut / Kdenlive / Shotcut | 43.8k / — | Electron / C++ Qt | GPL | 活跃 | Kdenlive Speech Editor = 文稿剪辑 | 完整 App | GPL，不可嵌 |

## B. 语音转写 / 字幕

| 引擎 | Stars | 许可 | 活跃 | Node 可用性 | 模型体积 | 中文 | 字级时间戳 | 说话人 | 缺点 |
|---|---|---|---|---|---|---|---|---|---|
| whisper.cpp | 53.7k | MIT | 2026-09 | 官方 addon.node 示例；社区 whisper-node-addon / nodejs-whisper；最稳是 spawn whisper-cli | tiny 75MB … large-v3 2.9GB | 中等 | 实验性 | tinydiarize 仅英文 | 中文弱于 Paraformer/SenseVoice |
| sherpa-onnx ⭐（本仓库已用） | 14.8k | Apache-2.0 | 2026-09 | 官方 sherpa-onnx-node 预编译 | SenseVoice int8 228MB | 强 | token 级 | 有 | 打包需 asarUnpack |
| FunASR | 20.4k | MIT | 2026-09 | Python sidecar（有 MCP 模式） | ~900MB | 最佳 | 有 | CAM++ | torch |
| SenseVoice | 9.3k | MIT | 2026-09 | 经 sherpa-onnx | 同上 | 强 | token 级 | 无 | — |
| faster-whisper | 25.4k | MIT | 2025-10 | Python only | 同 whisper | 中 | 词级 | 无 | CTranslate2 |
| WhisperX | 24k | BSD-2 | 2026-05 | Python only | whisper + wav2vec2 | 中文对齐一般 | 词级强制对齐最准 | pyannote | torch |

## C. 视频处理引擎

| 项目 | Stars | 许可 | 活跃 | 能力 | 进程 | 缺点 |
|---|---|---|---|---|---|---|
| node-av | 373 | MIT（内嵌 FFmpeg 8.1.1 静态链接，GPL 义务自负） | 2026-09 | N-API FFmpeg 绑定，预编译 6 平台，Electron 免重编，硬件加速 | 主进程 | 单人维护 |
| mediabunny | 7.1k | MPL-2.0 | 2026-09 | 纯 TS mux/demux + WebCodecs，Remotion 已迁入 | 渲染进程 | 无滤镜合成 |
| fluent-ffmpeg | — | MIT | 2025-05 归档 | — | — | 不要用 |
| ffmpeg-static | 1.4k | GPL-3.0 构建 | 2025-11 | 静态 ffmpeg 下载 | 主进程 | GPL 构建 |
| @ffmpeg/ffmpeg wasm | 17.8k | MIT | 2025-04 | 浏览器 ffmpeg | 渲染进程 | 0.12 不支持 Node，慢 10x |
| Remotion | 59.5k | source-available，≥4 人公司付费 | 2026-09 | React 即视频 | 均可 | 许可成本，React 树无法反向映射时间线 |
| Motion Canvas | 19.1k | MIT | 2024-12 release | 动画工具 | 渲染进程 | 非 NLE |
| Diffusion Studio core | 1.2k | 许可混乱（README 称非商用） | 2025-11 | WebCodecs 合成 | 渲染进程 | 不推荐 |
| omniclip | 1.5k | MIT | 2026-09 | Web Components + WebCodecs | 渲染进程 | 非 React |
| OpenCut | 89.6k | MIT | 2026-08 | Rust 核心重写中，规划 MCP server | 未来 | 现在无可用库 |
| Editly / FFCreator / Etro | 5.5k / 3.2k / 1.1k | MIT / MIT / GPL | 停更 | JSON → ffmpeg | 主进程 | 停更或 GPL |

Electron WebCodecs：Chromium ≥107 硬解、≥108 10-bit/HEVC；Electron ≥33 macOS/Windows HEVC 硬编。

## D. 场景检测 / 画面理解

| 项目 | 许可 | 说明 |
|---|---|---|
| PySceneDetect 5.2k | BSD-3 | CLI sidecar；纯 Node 替代 `ffmpeg -vf "select='gt(scene,0.4)',showinfo"` |
| TransNetV2 1k | MIT | 3D-CNN 镜头边界，渐变更准，可导 ONNX 用 onnxruntime-node |
| Qwen3-VL-8B GGUF | Apache-2.0 | 本地 VLM，M 系列约 1–3 s/帧 |
| Gemini 视频理解 | 云 | ~100 token/s，1 小时视频 ≈ $0.04–0.54 |
| SigLIP 2 ONNX（Transformers.js） | Apache-2.0 | 抽帧向量化做画面检索 |

## E. 时间线 UI

| 项目 | Stars | 许可 | 说明 |
|---|---|---|---|
| @xzdarcy/react-timeline-editor | 790 | MIT | 轻量 React 多轨时间线，无波形/缩略图 |
| Twick | 533 | Sustainable Use License（非 OSI） | React SDK 含 AI 字幕 |
| designcombo/react-video-editor | 1.8k | OpenVideo License（仿 Remotion） | 强绑 Remotion |
| omniclip `<omni-timeline>` | 1.5k | MIT | 非 React |
| OpenCut classic | 251 | MIT，已归档 | 自研 timeline 可抄 |

## F. 文稿剪辑（删词即剪）

思路：字/词级时间戳 → 文稿为 `[{word,start,end,speaker}]` → 删词 = 排除区间 → 合并为 EDL → `-c copy` 快路径或 `trim+concat` 精确路径。

| 项目 | Stars | 许可 | 说明 |
|---|---|---|---|
| CutScript ⭐ | 249 | MIT | Electron + React + FastAPI/WhisperX，架构最像本项目 |
| openscript | 19 | MIT | 纯浏览器，太早期 |
| audapolis | 1.9k | AGPL-3.0 | 文档式音频剪辑 |

## 推荐组合

sherpa-onnx（SenseVoice + VAD）转写 → JSON EDL 唯一真相 → 渲染进程 `<video>`/mediabunny 预览 → 主进程 spawn ffmpeg（备选 node-av）出片 → 自研分镜卡片/时间线 UI。

## 来源

- https://github.com/FireRedTeam/FireRed-OpenStoryline
- https://github.com/HKUDS/VideoAgent
- https://github.com/calesthio/OpenMontage
- https://github.com/linyqh/NarratoAI
- https://github.com/harry0703/MoneyPrinterTurbo
- https://github.com/modelscope/FunClip
- https://github.com/mli/autocut
- https://github.com/Huanshere/VideoLingo
- https://github.com/RayVentura/ShortGPT
- https://github.com/WyattBlue/auto-editor
- https://github.com/mifi/lossless-cut
- https://docs.kdenlive.org/en/effects_and_filters/speech_to_text.html
- https://github.com/ggml-org/whisper.cpp
- https://github.com/k2-fsa/sherpa-onnx
- https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html
- https://github.com/modelscope/FunASR
- https://github.com/QwenAudio/SenseVoice
- https://github.com/SYSTRAN/faster-whisper
- https://github.com/m-bain/whisperX
- https://github.com/seydx/node-av
- https://github.com/Vanilagy/mediabunny
- https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324
- https://github.com/ffmpegwasm/ffmpeg.wasm/issues/897
- https://github.com/eugeneware/ffmpeg-static
- https://www.remotion.dev/docs/license/faq
- https://www.remotion.dev/docs/webcodecs/
- https://github.com/motion-canvas/motion-canvas
- https://github.com/diffusionstudio/core
- https://github.com/omni-media/omniclip
- https://github.com/OpenCut-app/OpenCut
- https://github.com/OpenCut-app/opencut-classic
- https://github.com/mifi/editly
- https://github.com/tnfe/FFCreator
- https://github.com/etro-js/etro
- https://github.com/Breakthrough/PySceneDetect
- https://github.com/soCzech/TransNetV2
- https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://huggingface.co/blog/siglip2
- https://github.com/xzdarcy/react-timeline-editor
- https://github.com/ncounterspecialist/twick
- https://github.com/designcombo/react-video-editor
- https://github.com/DataAnts-AI/CutScript
- https://github.com/preston176/openscript
- https://github.com/bugbakery/audapolis
