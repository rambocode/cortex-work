// 翻译 key 类型增强(R4/R11)。以 zh-Hans 资源为 key 形状的权威源。
// 命名空间随提取单元增长时,在 resources 里追加对应 ns —— 之后由 U4 的
// `i18next-cli types` 自动重新生成本文件,避免手维护漂移。
// 注:暂用标准 string-key 类型(非 enableSelector),保持 t('a.b') 调用约定不变;
// 资源树过大致 tsc 变慢时,U13 再评估切到选择器式类型。

import "i18next";
import type common from "./resources/zh-Hans/common.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
    };
    returnNull: false;
  }
}
