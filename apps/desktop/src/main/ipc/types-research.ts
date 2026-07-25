// 研究引擎（CRE）在主进程侧的设置镜像。
//
// 单独成文件而不是并进 types.ts：后者已逼近仓库 1200 行硬上限，再往里加字段会直接越线。
// 此处只放 GeneralSettings.researchEngine 的形状，其余 IPC 类型仍留在 types.ts。
import type {
  ResearchEngineSettings,
  ResearchSearchServerSettings as CoreResearchSearchServerSettings,
} from "@cortex-work/core/research/settings";

/// Search Server 连接配置（与 core 的 ResearchEngineSettings.searchServer 同一份类型）。
///
/// encryptedToken 是 safeStorage 加密后的密文：**只有主进程能解**，解密后的明文既不落盘也不回
/// renderer（spec §19.3.1）。renderer 侧拿到的永远是这份密文，因此把它放在设置里是安全的。
export type ResearchSearchServerSettings = CoreResearchSearchServerSettings;

/// 研究引擎设置在主进程的形状 —— **直接复用 core 的 ResearchEngineSettings，不另立子集**。
///
/// 为什么不像 types.ts 里其它类型那样手抄一份镜像：
///   1. 手抄镜像存在的唯一理由是「core 不能依赖 app 包」。反方向不成立 ——
///      main 本来就依赖 core（ipc/research.ts、research/runtime.ts 都直接 import core 的类型），
///      所以这里没有必须复制的约束，复制只会白白制造漂移点。
///   2. **结构子集在 TS 里是反向不兼容的**：曾把它写成「只镜像 main 真正会读的 3 个字段」，
///      结果 main 的 PersistedState 不可赋给 core 的 PersistedState（少 chatEnabled /
///      slidesEnabled / writingEnabled / memoryEnabled 等必填字段），
///      preload 把 window.desktopAPI.personal 当 DesktopBridge 用时整体崩掉。
///      子集类型只在「作为形参」时兼容，作为**属性值**时必须是超集或等价。
///
/// main 实际只读 enabled / deepResearchEnabled / searchServer（决定是否拉起 Research Worker、
/// 拼搜索请求并解密 token），其余开关只做透明持久化——但"只读三个"是运行时行为，
/// 不该被编码成类型上的子集。
export type ResearchEngineMainSettings = ResearchEngineSettings;

/// 「A 必须可赋给 B」的编译期断言载体（同 core/desktop/research-bridge.ts 的写法）。
type AssertExtends<A extends B, B> = A;

/// **编译期对齐哨兵**：两侧形状一旦漂移，本行立刻在本文件报错，
/// 而不是把错误甩到三个文件外的 renderer/src/App.tsx 上（那里的报错几乎读不出根因）。
export type ResearchEngineMainSettingsAlignment = AssertExtends<
  ResearchEngineMainSettings,
  ResearchEngineSettings
>;
