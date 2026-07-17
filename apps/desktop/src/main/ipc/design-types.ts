// 设计工作台（design）持久化契约：设置、设计稿索引、画布 UI 态。
// ⚠️ 与 packages/core/desktop/design-types.ts 逐字镜像（双写契约，改动两处必须同步）。
// 来源：移植自 Kun 的 DesignSettingsV1（src/shared/app-settings-types.ts），字段语义保持一致，
// 去掉了 Kun runtime 专属项；命名去掉 V1 后缀以符合本仓库惯例。

// 设计系统预设（14 种 + none）：种子化 token/voice 的命名风格包。
export type DesignSystemPreset =
  | "none"
  | "shadcn"
  | "radix"
  | "material"
  | "ios"
  | "fluent"
  | "ant"
  | "chakra"
  | "carbon"
  | "polaris"
  | "bootstrap"
  | "geist"
  | "brutalism"
  | "editorial";

// 以下 setting 联合类型均以 "" 表示「未设置」，与 Kun 语义一致。
export type DesignSurfaceSetting = "" | "brand" | "product";
export type DesignRadiusSetting = "" | "sharp" | "soft" | "rounded" | "pill";
export type DesignDensitySetting = "" | "compact" | "cozy" | "spacious";
export type DesignFontStyleSetting = "" | "system" | "geometric" | "humanist" | "serif" | "mono";
export type DesignViewportSetting = "mobile" | "tablet" | "desktop";
export type DesignCanvasViewSetting = "preview" | "code";
export type DesignBackgroundSetting = "light" | "dark";

// 设计工作台设置（设置页「设计」分区；渲染端归一化后经 store:save 落盘）。
export interface DesignSettings {
  // 设计产物工作目录；空 = 默认 ~/Documents/cortex/design（fs 白名单内零配置可用）。
  defaultWorkspaceRoot: string;

  // --- 设计系统（设计 + 代码共享的事实源） ---
  brandColor: string;
  tone: string[];
  designSystemPreset: DesignSystemPreset;
  designType: DesignSurfaceSetting;
  designGuidelines: string;
  radius: DesignRadiusSetting;
  density: DesignDensitySetting;
  fontStyle: DesignFontStyleSetting;

  // --- 设计 agent（"" = 继承个人工作区当前 agent/model 选择） ---
  // 设计助手栏选中的 agent 种类("" = 跟随系统「新会话默认 Agent」);切 agent 时须联动清/配 model+providerId。
  agent: string;
  // 选中的派生 agent id("" = 内置);spawn 时 req.agent = derivedAgentId || 内置 base。
  derivedAgentId: string;
  model: string;
  providerId: string;
  reasoningEffort: string;
  // 单文件 HTML 生成契约的自定义覆盖；"" = 内置默认 prompt。
  generationPrompt: string;

  // --- 设计 → 代码集成 ---
  implementStackHint: string;
  injectIntoCode: boolean;
  publishDesignSystem: boolean;

  // --- 画布默认值 ---
  defaultViewport: DesignViewportSetting;
  defaultCanvasView: DesignCanvasViewSetting;
  canvasBackground: DesignBackgroundSetting;
  liveRefresh: boolean;
  deviceFrame: boolean;
}

// 设计稿索引项（轻量元数据；重数据 vN.html/meta.json/canvas.json 留在工作区磁盘）。
export interface DesignDocMeta {
  id: string;
  title: string;
  // 该设计稿的工作区根目录（绝对路径）；须并入 fs 白名单方可读写。
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
}

// 画布 UI 态 KV 分片：替代 Kun 侧 localStorage（core 禁 localStorage），
// key 沿用 Kun browser-storage 的键名，value 一律字符串（JSON 自行序列化）。
export type DesignUiState = Record<string, string>;
