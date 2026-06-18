import "@testing-library/jest-dom/vitest";
import { i18nReady } from "@cortex-work/core/i18n";
import { loadAllResourcesForTest } from "@cortex-work/core/i18n/testing";

// 等 i18next 初始化完成,再把全部命名空间资源同步灌入,使组件测试的 t() 首渲染即返回
// 真实 zh 值(规避懒加载异步)。zh 为默认/源,既有断言中文串的测试因此保持绿(R12)。
await i18nReady;
loadAllResourcesForTest();
