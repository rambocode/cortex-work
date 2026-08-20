// pi Provider 相关的共享纯函数。
//
// 历史：本文件曾把用户配置的供应商渲染成 pi extension（registerProvider 的 .js 文件，
// `$CORTEX_PI_KEY` 占位 + spawn env 注入真值）供二进制的 `-e` 加载。binary 路径删除后，
// Provider 注册全部走 `providers/pi-inproc-models.ts` 的原生 `ModelRuntime` 注册表
// （内建目录只覆盖 endpoint、自定义完整下发 models、密钥请求时才从 safeStorage 解出），
// 渲染/落盘链路（renderPiExtension / writePiExtension 等）一并删除。
//
// 保留 `safeId`：它是 pi 侧 provider 注册名的唯一归一化出处，`pi-inproc-models.ts`、
// `pi-provider-input.ts`、`custom-provider-registry.ts` 都用它做匹配键——注册名与查询键
// 必须同源，否则 id 含空格/大写时选不中。

// provider 名/文件名安全化:仅保留字母数字与 - _,其余替换为 -。
// `registerProvider` 的注册名与 Catalog / 自定义列表的匹配键都经它归一。
// ⚠️ 渲染端 `packages/views/.../provider/customProviderRules.ts` 的 `slugifyProviderId`
// 是同算法镜像(渲染端不能 import 主进程模块),改一处必须改两处,两侧测试各有镜像用例。
export function safeId(id: string): string {
  const s = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "provider";
}
