import { i18nReady } from "../i18n/index";
import { loadAllResourcesForTest } from "../i18n/testing";

// core 的 node 环境测试同步灌入全部命名空间资源,使非组件函数(toast / 通知文案)的
// 调用时 i18n.t() 在测试里返回真实 zh 值(规避懒加载异步,U5/R12)。
await i18nReady;
loadAllResourcesForTest();
