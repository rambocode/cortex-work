// 数据出站策略告知（spec KTD5）：用人话告诉用户「这次研究会有什么数据离开本机、发给谁」。
//
// 文案的单一真源是 core 的 describeEgress——UI 只负责把三个布尔位翻成条目并排版。
// 之所以不在这里另写一套说明：策略语义一旦调整（比如 metadata_only 收紧），core 改一处即可，
// 不会出现「弹窗说不发正文、实际发了」这种最不可接受的漂移。
import type { ReactElement } from "react";
import { describeEgress } from "@cortex-work/core/research/model-policy";
import type { ModelDataPolicy } from "@cortex-work/core/research/types";
import { MODEL_DATA_POLICY_LABELS } from "./labels";

/// 策略告知条的 props。acknowledged 由宿主持久化，组件本身无状态。
export interface ResearchPolicyNoticeProps {
  /// 当前生效的出站策略。
  policy: ModelDataPolicy;
  /// 用户上次确认过的策略；与 policy 相同则不再打扰（「首次使用或策略变化时展示」）。
  /// 组件本身无状态，是否已确认由宿主持久化后回传，这样重开工作区也不会重复弹。
  acknowledgedPolicy?: ModelDataPolicy | null;
  /// 收件方展示名（供应商名/本机模型名）。evidence_allowed 下尤其重要——
  /// 「正文会出站」和「出站到谁」是两个独立的信息，缺后者用户无法判断风险。
  providerLabel?: string;
  /// 提供时才渲染「我知道了」按钮；不提供表示纯告知模式（例如内嵌在新建表单里）。
  onAcknowledge?: (policy: ModelDataPolicy) => void;
}

/// 出网与数据流向的告知条：把「哪些数据会离开本机、发给谁」在开跑前显式讲清楚（spec §6）。
export function ResearchPolicyNotice({
  policy,
  acknowledgedPolicy,
  providerLabel,
  onAcknowledge,
}: ResearchPolicyNoticeProps): ReactElement | null {
  if (acknowledgedPolicy === policy) return null;

  const egress = describeEgress(policy);
  const meta = MODEL_DATA_POLICY_LABELS[policy];

  // 三个布尔位 → 条目。sendsToRemote 放第一条：用户最关心的就是「有没有东西离开这台机器」。
  const bullets: string[] = [
    egress.sendsToRemote ? "数据会发送到远端服务" : "数据不会离开本机",
    egress.sendsFullText ? "会发送抓取到的正文片段" : "正文不会发给模型",
    egress.sendsMetadata ? "会发送标题、摘要、域名等元数据" : "不发送任何元数据",
  ];
  if (egress.sendsToRemote && providerLabel) bullets.push(`将发送给：${providerLabel}`);

  return (
    <div className={`pw-res-notice is-${egress.sendsToRemote ? "remote" : "local"}`}>
      <div className="pw-res-notice-title">{meta.label}</div>
      <div className="pw-res-notice-summary">{egress.summaryZh}</div>
      <ul className="pw-res-notice-list">
        {bullets.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {onAcknowledge ? (
        <button type="button" className="pw-res-btn" onClick={() => onAcknowledge(policy)}>
          我知道了
        </button>
      ) : null}
    </div>
  );
}
