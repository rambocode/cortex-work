# AI 剪辑（智能混剪）整体解决方案

- 日期：2026-09-16
- 状态：方案（未实施）
- 参考：小飞影 AI 剪辑客户端操作手册 v1.0（抽取稿见 `docs/research/2026-09-16-xiaofeiying-ai-clip-manual-extract.txt`）
- 输入：项目基础设施勘察（本文 §3）、开源方案调研（本文 §2）

---

## 1. 目标与范围

### 1.1 参考产品在做什么

小飞影客户端有三块视频能力，只有第三块是「剪辑」：

| 能力 | 本质 | 本项目对应 |
|---|---|---|
| AI 创作（图片 → 成片） | 生成式视频（图生视频 + 提示词） | **已有**：`capabilities/media-gen/` 的 `generate_video`（MiniMax / Grok / 火山方舟） |
| 长片复刻（换品） | 生成式视频（圈选片段 → 视频模型重绘商品） | 依赖外部视频模型的首末帧 / 参考图能力，**阶段 3 再评估** |
| **AI 剪辑（混剪）** | 真剪辑：多源素材 → 自动分镜 → 智能组合 → 批量出 N 条差异化成片 → 叠字幕 / 贴纸 / 通用片头片尾 | **本方案主体，从零建** |

围绕混剪的配套功能：按商品管理源素材（本地上传 / 链接导入）、通用素材（标记开头 / 结尾）、成片方案（数量 / 字幕 / 贴纸）、AI 分镜（可选：参考图生成额外片段参与混剪）、结果预览 / 下载 / 历史入库。

### 1.2 本项目的范围裁剪

**做**（阶段 1–2）：

1. 商品 + 源素材 + 通用素材的本地管理（工作区目录，不上云）。
2. 自动分镜拆解：镜头边界检测 + 每镜头缩略图 / 时长 / 画面描述 / 音轨转写。
3. LLM 编排出 N 条差异化 EDL（编辑决策表，JSON），带节奏 / 时长 / 去重约束。
4. 批量渲染：拼接 + 卖点字幕 + 贴纸 + 片头片尾 + 背景音乐（可选）。
5. 结果面板：预览、筛选、导出、重新生成；任务可取消 / 断点续跑。
6. 作为 Agent 工具暴露（会话里说「把这 8 条素材混剪成 10 条 15 秒的」就能跑）。

**先不做**：

- 抖音链接导入（涉及第三方平台抓取与版权，需要用户单独决策；技术上是 `yt-dlp` sidecar，一天可接）。
- 罗盘数据采集（网页自动化抓竞品数据，与剪辑无关，且是灰色抓取）。
- 积分 / 团队 / 租户（那是 SaaS 计费，本项目是本地优先桌面端）。
- 长片复刻（换品）：等视频供应商「参考图 + 视频片段重绘」接口稳定再做。
- 精细非线性时间轴（NLE）：混剪是「批量出片」，用分镜卡片列表 + 单片段微调即可；NLE 放阶段 3。

---

## 2. 开源方案调研结论

### 2.1 端到端「AI 剪辑」项目（只借思路，不引运行时）

| 项目 | Stars | 许可 | 活跃 | 可借鉴点 | 不采用原因 |
|---|---|---|---|---|---|
| FireRed-OpenStoryline（小红书） | 3.4k | Apache-2.0 | 2026-07 | **最贴近混剪**：LLM 意图 → Storyline 中间件 → MCP 原子工具（素材检索 / 场景检测 / ASR 粗剪 / 转场 / 配乐卡点）；本身是 MCP server | Python 3.11 运行时得随包，VLM / 转场靠外部 API |
| FunClip（阿里） | 6.3k | MIT | 2026-09 | 中文 ASR + 说话人 + 「选文字即剪」+ LLM 选段 | torch 全家桶，GB 级 |
| NarratoAI | 11.1k | MIT | 2026-09 | VLM 逐段理解 → 解说 → TTS → 合成 | 单一「解说成片」场景，Streamlit 无 API |
| MoneyPrinterTurbo | 124k | MIT | 2026-09 | 主题 → 文案 → 素材 → 字幕 → 成片 HTTP API | 是「生成」不是「剪辑」，不处理用户已有素材 |
| auto-editor | 5.2k | Unlicense | 2026-09 | **Nim 单二进制**去静音 / 去无运动粗剪，可导 NLE 工程 | 只做粗剪，作为可选 sidecar |
| OpenMontage | 59k | AGPL-3.0 | 2026-09 | 流水线 + skill 驱动的「制片厂」思路 | AGPL 与闭源桌面端冲突 |
| AutoCut / ShortGPT | 7.8k / 8k | Apache / MIT | 停更 | 文稿剪辑最简实现 | 不活跃 |
| CutScript | 249 | MIT | 2026-03 | **Electron + React + Python sidecar（WhisperX）** 删词即剪，架构最像本项目 | 口播精剪，与混剪目标不同，阶段 3 参考 |

结论：没有一个能当库直接嵌 Node 主进程，且都是 Python 运行时。**不引入任何一个的运行时**，只抄 OpenStoryline 的工具切分和 FunClip 的交互。

### 2.2 基础引擎选型

| 层 | 首选 | 备选 | 理由 |
|---|---|---|---|
| 出片 / 探测 / 抽帧 | **spawn 独立 ffmpeg / ffprobe 静态二进制**（LGPL 构建，随包 `extraResources`） | `node-av`（MIT，N-API 预编译，Electron 友好） | 进程边界隔离 GPL；仓库已有 5 类随包二进制的成熟范式；`fluent-ffmpeg` 已归档不用；`ffmpeg.wasm` 桌面端无意义。`node-av` 静态链接含 x264 的 ffmpeg（GPL 义务）且单人维护 373 star，先留作逃生口 |
| 镜头边界检测 | **ffmpeg `select='gt(scene,T)'` 场景分数**（零依赖） | TransNetV2 导 ONNX 跑 `onnxruntime-node`（渐变 / 擦除更准）；PySceneDetect sidecar | 电商实拍素材硬切为主，ffmpeg 分数够用；阶段 2 视效果再上 TransNetV2 |
| 音轨转写 | **已有** `capabilities/sensevoice/`（SenseVoice int8 228MB，中 / 粤 / 英 / 日 / 韩，token 时间戳）+ `sherpa-asr` | whisper.cpp 二进制 | 零新增依赖，中文优于 whisper |
| 画面理解 / 标注 | **走用户已配置的多模态供应商**（Provider Catalog 里的 VLM，抽帧后逐镜头描述 + 打标签）；成本估算：每镜头 1–3 帧，10 条素材 ≈ 60–150 镜头 ≈ 数百次图片调用 | 本地 Qwen3-VL-8B GGUF（Ollama / llama.cpp）；SigLIP 2 ONNX（`@huggingface/transformers`）做画面向量检索 | 项目已有 Model Gateway 与供应商目录，不新造；云端 Gemini 整片理解约 100 token/s 是最省事的备选 |
| 预览 | **`<video>` + 自定义只读流式协议 `cortex-media://`**（MVP） | `mediabunny`（MPL-2.0，WebCodecs 硬解 + Canvas 合成，Remotion 都在迁过去） | 混剪成片是普通 mp4，`<video>` 足够；分镜卡片用 ffmpeg 抽的缩略图；阶段 3 NLE 再上 mediabunny |
| 字幕 / 贴纸 | ffmpeg `subtitles`（ASS，样式可控）+ `overlay`（PNG / 动图贴纸） | `drawtext` | ASS 能做卖点字幕条动画与描边，贴纸模板即带 alpha 的 PNG / WebP 序列 |
| 时间线 UI | **不做 NLE**，做「成片 = 分镜卡片序列」的可拖拽列表（`@dnd-kit` 或复用 `@xyflow/react` 交互经验） | `@xzdarcy/react-timeline-editor`（MIT）起步 | Twick / designcombo / Remotion 系列都是非 OSI 许可或绑 Remotion，与「本地优先、可商用」冲突 |
| 时间线数据 | **自定义 JSON EDL**（tracks / clips / 源区间 / 字幕 / 贴纸），可选导 OTIO | — | LLM 工具只读写 EDL：可 diff、可撤销、可审计、可换渲染引擎 |
| 粗剪（可选） | `auto-editor` 单二进制 sidecar | 自己用 silero VAD | 去静音 / 去无运动开箱即用 |

### 2.3 许可红线

- ffmpeg 二进制用 LGPL 构建（不含 x264 / x265 时可用 `libopenh264` 或系统 VideoToolbox 编码 `h264_videotoolbox`，macOS 上首选硬编，画质与速度都好）。
- 不引入 AGPL（OpenMontage、audapolis）、GPL 库（etro、ffmpeg-static 的 GPL 构建）、Remotion 系许可。

---

## 3. 项目内可复用的基础设施

勘察结论：**ffmpeg / 视频链路为零，媒体预览组件为零，但六条基础设施能直接抄。**

| 需要 | 已有范例 | 位置 |
|---|---|---|
| 随包二进制定位 + 打包 | SenseVoice sidecar / agent-browser | `capabilities/sensevoice/locate.ts`、`electron-builder.yml` 的 `extraResources`、`scripts/before-pack.cjs` |
| 重活隔离子进程 | research worker / pi-host | `main/research/worker/`、`agents/pi-gateway/`（utilityProcess + 入口解析优先 `app.asar.unpacked`） |
| 长任务持久化 + 暂停 / 恢复 / 崩溃恢复 | 深度研究 CRE | `main/research/`（SQLite repository + migrations + startup-recovery）、`ipc/research.ts` 九件套、`core/desktop/research-bridge.ts` 独立桥文件 |
| 进度事件 | 事件信封 | `ipc/run-events.ts` 的 `sendRunEvent`，`RunEventEnvelope.domain` 枚举加 `"clip"`；低频变更走 `sync:invalidate` |
| 大文件流式落盘 + 工作区边界 | 媒体生成 | `capabilities/media-gen/download.ts`、`client.ts` 的 `assertRealWithinWorkspace` |
| 生成型工作台三端脚手架 | Slides | `ipc/slides.ts` + `capabilities/slides/`（MCP host 按会话头注册工具）+ `core/design/slides/` + `views/design/slides/`；右栏面板 = descriptor + `registry.ts` 加一行 |
| Agent 工具注入 | media-gen MCP | `ipc/pi-session.ts` 的 `preparePiOpenRequest()` 加 `buildClipMcpServerConfig()`；门控不过整包不注入 |
| 只读流式协议喂渲染端 | petdex / vad / kws | `protocol-schemes.ts`（特权条目单次注册）、`ipc/petdex-security.ts`（host 白名单 / 防穿越） |
| 音轨转写 / 重采样 | STT | `ipc/stt.ts`、`capabilities/sensevoice/pcm.ts`；前端 `encodeWav.ts` |
| 配音（AI 分镜口播可选） | edge-tts | `capabilities/edge-tts/` |
| 二进制文件 IPC | fs 域 | `fs:readFileBinary` / `fs:writeFileBinary`（base64，小文件用）；**缺「选文件」对话框，需新增** |
| 多模态供应商调用 | Model Gateway | `providers/gateway.ts`、`ipc/model-gateway.ts` |

---

## 4. 整体架构

### 4.1 数据模型（SQLite，仿 research repository）

```
Product        商品：id, name, coverImage, sellingPoints[], createdAt
Asset          源素材：id, productId | null(通用), path, kind(source|generic|generated),
               role(none|intro|outro|transition), probe(duration/fps/w/h/codec), status
Shot           分镜：id, assetId, inPoint, outPoint, thumb, motionScore, transcript,
               vlm{caption, tags[], shotType(closeup|wide|usage|packshot), hasProduct, quality}
ClipTask       剪辑任务：id, productId, assetIds[], plan{count, duration, aspect, subtitle, sticker,
               useGeneric, aiShots}, status(queued|analyzing|planning|rendering|done|failed|cancelled)
Edl            成片方案（每条成片一份 JSON）：taskId, index, clips[{shotId, in, out, speed}],
               subtitles[{start,end,text,style}], stickers[{start,end,templateId,pos}], bgm, hash
Render         渲染产物：edlId, outputPath, status, progress, error
```

EDL 是 Agent、UI、渲染器三方唯一真相。改字幕 / 换镜头 = 改 EDL 后重渲染。

### 4.2 流水线（主进程 `main/clip/` + utilityProcess `worker/clip-worker`）

```
ingest    ffprobe 探测 → 生成 480p 代理 + 关键帧缩略图（ffmpeg，并发 2）
split     ffmpeg scene score → 镜头边界 → 每镜头 1–3 帧抽图 → 过滤 <0.8s 碎片
analyze   并行：SenseVoice 转写音轨（已有）+ VLM 逐镜头描述 / 打标 / 是否含商品 / 质量分
plan      LLM 结构化输出 N 条 EDL（JSON schema 约束）：
            输入：商品卖点、镜头清单（id/时长/标签/描述）、成片方案、通用素材角色
            约束：目标时长 ±10%、开头必有黄金 3s 镜头、相邻镜头不同景别、
                  N 条成片间镜头序列 Jaccard 相似度 < 0.5、intro/outro 固定位
            字幕：按镜头生成卖点文案（≤12 字/条），可编辑
render    每条 EDL → ffmpeg filter_complex：trim/setpts → concat → subtitles(ASS) → overlay(贴纸)
            → amix(bgm) → h264_videotoolbox 硬编 → 原子 rename 落盘 → 入库
```

- 任务状态机落 SQLite，每步幂等（按输入 hash 缓存分镜 / 标注 / 代理），失败可从断点续跑。
- 进度：`sendRunEvent({domain:"clip", sessionId:taskId, runId:step, event})`，渲染端 React Query 按 `["clip", wsId, taskId]` 失效。
- 并发：ingest / render 各一个受限队列（默认 2），VLM 调用受供应商限速。
- 产物目录：`<素材根>/products/<productId>/{sources,shots,proxies,outputs}/`，通用素材在 `<素材根>/generic/`；根目录可在设置里改（对照参考产品「更换素材存储目录」）。

### 4.3 主进程模块

```
apps/desktop/src/main/
  clip/                      领域逻辑（不依赖 Electron，便于单测）
    ffmpeg/locate.ts         二进制定位（抄 sensevoice/locate.ts）
    ffmpeg/run.ts            spawn 封装：参数数组、进度解析(-progress pipe:1)、取消、超时
    probe.ts / proxy.ts / split.ts / thumbs.ts
    analyze/asr.ts           复用 sensevoice client
    analyze/vlm.ts           抽帧 → Model Gateway 多模态调用 → Shot 标注
    plan/prompt.ts           英文 system prompt（静态前缀 + 变量尾部，命中缓存）
    plan/schema.ts           EDL zod schema + 约束校验（时长/相似度/角色位）
    render/filtergraph.ts    EDL → filter_complex 纯函数（重点单测）
    render/ass.ts            字幕样式 → ASS
    store/repository.ts      SQLite + migrations（抄 research）
    service.ts               任务状态机、队列、断点续跑
  ipc/clip.ts                IPC 域：product/asset/task/edl/render CRUD + onEvent
  ipc/clip-types.ts          契约（与 core/desktop/clip-types.ts 逐字镜像）
  capabilities/clip/         MCP server：clip_list_products/assets, clip_split_shots,
                             clip_plan_outputs, clip_render, clip_task_status
  media-protocol.ts          cortex-media:// 只读流式协议（Range 支持）
  worker/clip-worker         utilityProcess：跑 ffmpeg 队列，主进程只做编排
```

### 4.4 core / views

```
packages/core/clip/          types、EDL schema、query hooks(useClipTasks/useShots…)、
                             zustand 只放选中态与草稿；exports 加 @cortex-work/core/clip
packages/core/desktop/clip-bridge.ts   独立桥文件（bridge.ts 已近 1200 行上限）
packages/views/cortex-desktop/clip/
  ClipWorkspace.tsx          全窗工作台：左栏商品/素材，中区任务与成片网格，右栏成片详情
  assets/                    素材上传（新增 fs:pickFiles 对话框）、通用素材角色标记
  shots/                     分镜卡片墙（缩略图 + 标签 + 转写），可标「排除」
  plan/                      成片方案表单（数量/时长/画幅/字幕/贴纸/通用素材/AI 分镜）
  results/                   成片网格：<video src="cortex-media://…"> 预览、导出、重渲染
  edl/                       单条成片编辑：镜头序列拖拽、字幕文本编辑、贴纸位置
  descriptor.tsx + panel.tsx 右栏面板（会话内进度 / 结果），registry.ts 加一行
```

入口：侧栏「AI 剪辑」（对照 `writingOpen` 开关模式）+ 会话 `/skill:clip`。

### 4.5 Agent 集成

- MCP 工具只在 pi 聊天会话路径注入（`ipc/pi-session.ts`），不进 `cli.ts` builtinServers、不进 `automation/runner.ts`。
- 渲染是本地写文件、可撤销，不进审批集；删除素材 / 产物工具进审批集。
- system prompt 全英文，镜头清单等变量放尾部。

### 4.6 AI 分镜（可选扩展）

复用 `generate_video`（media-gen）按参考图生成 5–10 秒片段，落库为 `kind=generated` 的 Asset，走同一 split / analyze / plan 流程参与混剪。零新链路。

---

## 5. 分阶段计划

| 阶段 | 交付 | 估算 |
|---|---|---|
| **P0 地基**（1 周） | ffmpeg / ffprobe 随包 + 定位 + 双架构打包验证；`cortex-media://` 协议；`fs:pickFiles`；`<video>` 预览组件；`clip` 事件域 | 主进程为主 |
| **P1 MVP 混剪**（2 周） | 商品 / 素材 / 通用素材管理；ingest → split → VLM 标注 → LLM 出 N 条 EDL → 渲染（拼接 + ASS 字幕 + 片头片尾）；任务列表与成片网格；module-map 条目 | 端到端跑通 |
| **P2 可用**（1–2 周） | 贴纸模板；BGM；单条成片 EDL 编辑与重渲染；断点续跑；MCP 工具 + `/skill:clip`；AI 分镜接 media-gen；设置页素材根目录 | 对齐参考产品 §6 全部 |
| **P3 增强**（按需） | TransNetV2 镜头检测；SigLIP 画面检索；口播「文稿剪辑」（SenseVoice token 时间戳删词即剪，参考 CutScript）；mediabunny 实时预览 + NLE 时间轴；抖音导入（需决策） | — |

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| ffmpeg 双架构打包与公证（hardenedRuntime） | 走 `extraResources` + `before-pack.cjs`，在 `release:ui` 加一条打包态护栏（spawn `ffmpeg -version`），照 pi 打包护栏 |
| VLM 标注成本与速度（百次级图片调用 / 任务） | 每镜头默认 1 帧，代理分辨率 480p，按镜头 hash 缓存；提供「仅转写不看画面」的降级模式 |
| LLM 出的 EDL 不合法（引用不存在镜头、超时长） | zod 校验 + 自动修复（截断 / 补 outro）+ 最多重试 2 次；不合法条目丢弃不阻塞整任务 |
| N 条成片同质化 | 相似度约束进 prompt + 后置 Jaccard 检查，低于阈值重排 |
| 渲染阻塞主进程 | ffmpeg 在 utilityProcess 队列里 spawn，主进程只收进度 |
| 长视频内存 | 只用文件路径与流式协议，绝不把视频 base64 过桥 |
| 单文件 1200 行上限 | `filtergraph.ts`、`service.ts`、`ClipWorkspace.tsx` 一开始就按职责拆 |

---

## 7. 待用户决策

1. **ffmpeg 形态**：A. spawn 独立 LGPL 二进制（推荐，许可干净、范式现成）；B. `node-av`（更快集成、硬件加速 API 友好，但 GPL 义务与单人维护）。
2. **画面理解默认走哪**：A. 用户已配置的云端多模态供应商（推荐，零新依赖，成本可控）；B. 内置本地 Qwen3-VL（隐私最好，但要再打包一个 GB 级模型与 llama.cpp 运行时）。
3. **抖音链接导入**是否纳入范围（涉及平台抓取与版权）。
