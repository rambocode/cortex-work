// Cortex Research Engine（CRE）在 DesktopBridge 上的桥契约 —— **跨进程契约真源**。
//
// 单独成文件而不是并进 desktop/types.ts / desktop/bridge.ts：前者已远超仓库 1200 行硬上限，
// 只能减不能加；主进程侧也有同样理由的先例（apps/desktop/src/main/ipc/types-research.ts）。
//
// 三处必须同形，改任一处都要同步另两处：
//   1. 本文件（core 真源，DesktopBridge.research 的类型）；
//   2. apps/desktop/src/preload/research-bridge.ts（contextBridge 暴露的实现）；
//   3. packages/views/cortex-desktop/research/bridge-like.ts（组件侧的注入契约镜像）。
// 其中 1 与 3 的一致性由 bridge-like.ts 的编译期哨兵 + 本文件的哨兵共同兜住。
import type { ResearchEngineFacade, ResearchEvent } from "../research/types";
import type {
  ResearchDirectSearchSettings,
  ResearchSearchServerSettings,
} from "../research/settings";
import type { DirectSearchProviderId } from "../research/direct-search";
import type { GatherRequest, GatherResult } from "../research/quick-types";
import type { KnowledgeItem, MemoryCandidate } from "../research/knowledge";

/// Search Server 连接测试结果（设置页「连接测试」按钮消费）。
///
/// 刻意**不回传任何凭据**：main 用已加密的 PAT 自行发起探测，只把成败与一句人话回给 renderer。
export interface ResearchSearchServerProbe {
  ok: boolean;
  /// 可直接展示给用户的一句话（成功时是版本/工作区名之类，失败时是脱敏后的原因）。
  message: string;
}

/// 设置 Search Server 凭据的入参。
///
/// **明文 PAT 只在此处单向流向 main**（用户点「保存」时传一次），main 立刻用 safeStorage
/// 加密落盘；回读永远只给密文或「已配置」布尔。renderer 不得持久化明文，也不得反向索取。
export interface ResearchSearchServerCredentialInput {
  baseUrl: string;
  workspaceId: string;
  /// 明文 PAT。省略 = 只改 baseUrl/workspaceId，保留已存密文。
  token?: string;
}

/// 设置直连搜索密钥的入参。明文 API key 的流向与 PAT 相同：只在此处单向流向 main。
export interface ResearchDirectSearchCredentialInput {
  provider: DirectSearchProviderId;
  /// 明文 API key。省略 = 只改供应商；**换供应商时旧密钥会被丢弃**
  /// （A 家的 key 在 B 家必然无效，留着只会让设置页显示"已配置"而每次搜索都失败）。
  apiKey?: string;
}

/// 研究引擎的桌面桥。
///
/// 必选方法 = ResearchEngineFacade 的九件套 + onEvent，与 main 的 9 个 IPC channel 一一对应。
/// **入参里刻意没有** 模型 API key / Search token / Worker 路径 / 任意本地输出路径（spec §16）：
/// main 侧 zod schema 是 .strict()，多传字段会被直接拒绝，所以桥这层就不提供这些参数。
export interface CortexResearchBridge extends ResearchEngineFacade {
  /// 订阅 main 推来的研究事件；**返回退订函数**，调用方卸载时必须调用，
  /// 否则整窗覆盖层反复开合会累积监听器。
  onEvent(listener: (event: ResearchEvent) => void): () => void;

  // ── 以下为设置页用的可选能力（M1 主进程尚未提供对应 channel）──────────────────
  // 全部 `?:`：旧壳 / Web 端 / 尚未实现时 UI 走禁用降级，而不是点了没反应。
  /// 写入 Search Server 连接配置（含明文 PAT，main 侧加密后落盘）。
  ///
  /// **返回落盘后的配置切片（含密文，不含明文）**，调用方必须把它写回自己的 store。
  /// 不这么做会有一个隐蔽的数据丢失：renderer 的 store 副本里没有 encryptedToken，
  /// 而设置页的全量写回以该副本为基线，用户随后动任何一个开关都会把刚存的 PAT 覆盖掉。
  /// 回传密文本身是安全的——renderer 本来就持有它（只有 main 能解）。
  setSearchServerCredential?(
    input: ResearchSearchServerCredentialInput,
  ): Promise<ResearchSearchServerSettings>;
  /// 用已保存的凭据做一次连通性探测；不接受也不回传凭据。
  testSearchServer?(): Promise<ResearchSearchServerProbe>;

  /// 写入直连商业搜索配置（含明文 API key，main 侧加密后落盘）。
  ///
  /// 与 setSearchServerCredential 同样**必须把返回的切片写回 store**（理由同上）。
  /// 入参刻意没有 endpoint/baseUrl：端点常量在 core/research/direct-search，
  /// 让 renderer 指定它等于开一个任意 URL 出站通道。
  setDirectSearchCredential?(
    input: ResearchDirectSearchCredentialInput,
  ): Promise<ResearchDirectSearchSettings>;
  /// 用已保存的密钥对直连搜索做一次连通性探测；不接受也不回传凭据。
  testDirectSearch?(): Promise<ResearchSearchServerProbe>;

  /// 一次「搜一下并把前几条读回来」——会话内自动检索与写作检索共用。
  ///
  /// **入参里没有 urls**，这是刻意的：抓哪几条由主进程从搜索结果里选。
  /// 若开放 urls，就等于给了渲染端一条「指挥主进程抓任意地址」的通道，
  /// 与 ipc/research.ts 拒绝 local_file sourceScope 是同一条边界。
  gather?(request: GatherRequest): Promise<GatherResult>;

  /// 列出记忆候选（U10）。缺省列全部；传 status 只列该状态。
  listMemoryCandidates?(status?: MemoryCandidateStatus): Promise<ResearchMemoryCandidateView[]>;
  /// 审阅一条候选。
  ///
  /// **入参是「动作」不是「目标状态」**：开放 status 直传等于让渲染端把一条候选直接置成
  /// approved，绕开用户逐条批准这道闸（KTD10）。
  reviewMemoryCandidate?(candidateId: string, action: ResearchMemoryReviewAction): Promise<void>;
}

/// 候选状态（与 core/research/knowledge 的 MemoryCandidate["status"] 同源）。
export type MemoryCandidateStatus = MemoryCandidate["status"];

/// 用户可执行的三个审阅动作。
export type ResearchMemoryReviewAction = "approve" | "reject" | "revoke";

/// 候选 + 派生它的知识条目（UI 展示来源用）。与 main 的 MemoryCandidateView 同形。
export interface ResearchMemoryCandidateView {
  candidate: MemoryCandidate;
  knowledge: KnowledgeItem | null;
}

/// 「A 必须可赋给 B」的编译期断言载体（同 views/bridge-like.ts 的写法）。
type AssertExtends<A extends B, B> = A;

/// **编译期对齐哨兵**：facade 改签名时本行立刻编译失败，而不是等到运行时 IPC 报错。
export type CortexResearchBridgeFacadeAlignment = AssertExtends<
  CortexResearchBridge,
  ResearchEngineFacade
>;
