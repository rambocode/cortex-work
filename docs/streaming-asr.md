# 流式 ASR（sherpa-onnx streaming zipformer）

本地实时语音识别的第二条通道：**边说边解码**，VAD 判停时文本已经就绪。
与 SenseVoice（见 `docs/sensevoice-asr.md`）并列共存，由 `AsrSettings.protocol` 分流，不是替代关系。

| | SenseVoice（`local-sensevoice`） | 流式 Zipformer（`local-zipformer-stream`） |
|---|---|---|
| 解码时机 | VAD 判停后整段推理 | 喂音频的同时增量解码 |
| finish 耗时 | 与句子长度成正比，用户能感到等待 | 实测约 6–7ms（只剩尾部一两个 chunk） |
| 运行时 | llama.cpp sidecar 进程 | sherpa-onnx 原生模块，主进程内 |
| 模型 | 单文件 GGUF，约 254MB | transducer 三件套 + 词表，约 199MB |

## 为什么要它

SenseVoice 只能在 VAD 判停之后才开始算，长句尤其明显：说完还要等一段时间文字才出来。
transducer 在音频流入的同时就把 token 解出来了，收尾只需处理最后一两个 chunk，
主观体验是「话音落 = 文本到」。这就是 P1 的全部目的。

## 组成

- `packages/core/asr/streaming-models.ts` — 模型清单（白名单 modelId、钉死的 commit revision、
  逐文件 SHA-256 与大小）。与 `local-models.ts` 同构，差别是**一个模型对应四个文件**。
- `apps/desktop/src/main/capabilities/sherpa-asr/models.ts` — 下载 / 校验 / 删除 / 源探测。
  四个文件串行下载，逐个校验 size + SHA-256 后原子落盘；已就绪的文件会跳过，
  所以中断重试不必重传 181MB 的 encoder。落盘在 `<userData>/models/speech/zipformer/`。
- `apps/desktop/src/main/capabilities/sherpa-asr/engine.ts` — 懒加载的 `OnlineRecognizer` 单例，
  每个 stream 一个 `OnlineStream`；60 秒空闲回收模型内存。
- `apps/desktop/src/main/ipc/stt.ts` — 协议分流。
- `packages/views/.../settings/SttLocalZipformerPanel.tsx` — 下载/进度/删除 UI。

## IPC 约定

模型管理走 `stt:streaming:*`（与 SenseVoice 的 `stt:local:*` 并列，互不影响）。

实时 PCM 通道 `stt:stream:*` 是**两个本地协议共用**的：

- `stt:stream:start` 带 `protocol` 字段决定用哪个引擎，并在主进程建立会话归属；
- 之后的 `audio` / `finish` / `cancel` 由主进程按 `requestId` 反查归属，
  renderer **不需要**在每片音频上重复带 protocol。省略 `protocol` 时按 SenseVoice 处理（旧渲染端兼容）。

## 两条必须知道的红线

### 1. sherpa-onnx native 1.13.x 在 darwin-arm64 上是坏的

流式 transducer 全程只吐 blank，**不报任何错误**。用官方 example + 官方模型 + 官方 test wav
可以逐字复现；降到 1.12.40 同样输入立刻正确。

因此 root `package.json` 的 `pnpm.overrides` 把 `sherpa-onnx-darwin-arm64` /
`sherpa-onnx-darwin-x64` / `sherpa-onnx-win-x64` 全部钉死在 `1.12.40`。
**注意平台二进制包在 `sherpa-onnx-node` 里是 `^` 范围**——只钉 `sherpa-onnx-node` 的版本，
原生库仍会偷偷浮回 1.13.x，症状是「装完没报错但识别不出东西」。

升级 sherpa 前必须先跑 `pnpm --filter @cortex-work/desktop verify:sherpa-asr`，
判据是**识别结果非空且包含期望关键词**，不能只验「模块能加载」——静默失效正是从那里漏过去的。

### 2. Electron 禁用 external buffer

`sherpa.readWave()` 之类返回 external buffer 的 API 在 Electron 下直接抛
`External buffers are not allowed`。引擎与验证脚本都自己从 PCM16LE 转 `Float32Array`，
这也正是生产路径（renderer 推来的本来就是 PCM16LE）。不要为了图方便改回 `readWave`。

## 实测数据（Apple Silicon，int8，numThreads=2）

Electron 39.8.10 / sherpa native 1.12.40，按 100ms 分片模拟实时推流：

```
识别器创建耗时 428ms
[0.wav] 时长 10.05s · 流式解码 218ms (RTF 0.022) · partial 更新 17 次 · finish 收尾 7ms
  昨天是 MONDAY TODAY IS LIBR THE DAY AFTER TOMORROW是星期三
[1.wav] 时长 5.10s · 流式解码 104ms (RTF 0.020) · partial 更新 9 次 · finish 收尾 7ms
  这是第一种第二种叫呃与 ALWAYS ALWAYS什么意思啊
```

`finish 收尾 7ms` 就是这个功能的意义所在——对比 SenseVoice 的整句推理耗时。

## 其它实现取舍

- **`enableEndpoint: 0`**：端点检测交给 renderer 侧的 Silero VAD（`vad.ts` 的 `silenceMs`），
  否则 sherpa 自己的 rule2 会提前切段、把一句话拆成两次结果。
- **finish 补 0.4s 尾部静音**：transducer 的最后一个 chunk 需要右侧上下文才会吐出来，
  不补会稳定丢句尾一两个字。0.4s 取自 sherpa 官方 example。
- **解码逐 chunk `setImmediate` 让出**：解码是同步原生调用，长句一次性跑完会连续占用主进程
  事件循环。RTF 虽低，但「不卡 UI」应当是结构性保证而不是靠性能赌。
- **decoder 用 fp32、encoder/joiner 用 int8**：decoder 只是嵌入表，量化收益极小。
- **打包**：`electron-builder.yml` 的 `asarUnpack` 需包含 `sherpa-onnx-node` 与
  `sherpa-onnx-darwin-*` 两个作用域——`.node` 及其 dylib 由 dlopen 按真实路径加载，asar 内必失败。

## 已知限制

- 目前只有一个模型（中英双语 int8）。清单是数组，加模型时
  `core/asr/streaming-models.ts` 与 `media-gen-types.ts` 里的
  `STREAMING_ASR_MODEL_NAMES` 兜底列表**两处都要加**（后者刻意不 import 前者，
  因为它被逐字镜像进主进程 `ipc/types.ts`）。
- 该模型不带标点与 ITN，输出是连续文本；需要标点可后接 `stt:polish` 的 LLM 纠错。
- 尚未接 partial 上屏：引擎在解码过程中已有中间结果（实测一句 10s 音频有 17 次更新），
  但当前 IPC 只在 finish 时返回终稿。把 partial 推给 renderer 做「边说边显示」是自然的下一步。
