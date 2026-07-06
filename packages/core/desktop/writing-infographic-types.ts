// 写作信息图生成(U7)IPC 契约类型。
// ⚠️ 与 apps/desktop/src/main/ipc/writing-infographic-types.ts 逐字镜像(双写契约,改动两处必须同步)。
// 选区文本 → Kun 默认信息图提示词 → 对接 media-gen(openai-images 协议)生成 PNG →
// 落 <spaceRoot>/img/infographic-<ts>.png;返回落盘绝对路径,渲染端复用 U1 的 relativeImageLink
// 换算相对当前 md 的链接插入正文(与 fs:writingSaveImage 一致的「主进程落盘、渲染端换算」分工)。
// 独立成文件(不并入 writing-types.ts)是为降低与并行单元在 writing-types.ts 上的编辑冲突。

// 生成请求:spaceRoot(空间根,落盘 img/ 目标与白名单校验基准)+ text(选区正文,超限截断)。
export interface WritingInfographicRequest {
  spaceRoot: string;
  text: string;
}

// 生成结果:ok 时给落盘绝对路径与文件名(渲染端据 absolutePath 换算相对链接);失败给可读 message。
// 失败(未配置 / 生成异常 / 落盘越权)时不写任何文件,渲染端据 message toast。
export type WritingInfographicResult =
  | { ok: true; absolutePath: string; fileName: string }
  | { ok: false; message: string };
