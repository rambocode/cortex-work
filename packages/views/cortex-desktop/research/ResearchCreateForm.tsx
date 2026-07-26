// 新建研究表单：目标 + 强度档位 + 来源范围，提交后 create，**启动交给宿主**。
//
// 预算数字全部取自 core 的 MODE_BUDGETS，不在 UI 里重抄一份——抄一份的结果必然是
// core 调了预算而界面还在展示旧值，用户按旧承诺规划时间。
//
// 为什么本表单不再自己调 run（这条是真实踩过的坑）：run 必须发生在「会话已经进入
// ui-store 的列表」之后，而那件事由宿主在 onCreated 里做。表单自己 run 的话，编排开头
// 发出的事件会落到一个列表里还不存在的会话上，被 ui-store 直接丢弃——界面在整个执行
// 期间毫无反应。启动与启动失败的展示都收在 ResearchWorkspace 一处。
import { useState, type ReactElement } from "react";
import { MODE_BUDGETS } from "@cortex-work/core/research/budget";
import type {
  ResearchConsumer,
  ResearchMode,
  ResearchRequest,
  ResearchSessionSummary,
  SourceScope,
} from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { RESEARCH_MODE_LABELS } from "./labels";
import type { ResearchModelDisplay } from "./modelDisplay";

/// 新建研究表单的 props。
export interface ResearchCreateFormProps {
  bridge: ResearchBridgeLike;
  /// 发起方（决定 main 侧的默认配置，见 core 的 consumer.ts）。整窗 Deep Research 固定 deep_research。
  consumer?: ResearchConsumer;
  /// 本次研究将使用的模型（展示名 + 是否本机 + 出站说明），由宿主按设置解析后注入。
  ///
  /// 由宿主注入而不是表单自己读 store：views 层不依赖 personal store（那是个人工作区的
  /// 设置容器），保持组件可在任意宿主里复用。缺省则不显示这一行。
  model?: ResearchModelDisplay;
  /// 创建完成。宿主负责把会话放进列表、选中它，**并发起 run**（顺序见文件头注释）。
  onCreated: (summary: ResearchSessionSummary) => void;
  onCancel: () => void;
}

/// 可勾选的来源范围。enterprise 需要 tenantId，桌面个人版没有该概念，暂不提供。
///
/// **local_file 在 M1 是禁用的，这条与 IPC schema 是硬对齐关系**：
/// main 的 ipc/research.ts 里 sourceScopeSchema 只认 public_web / memory，且整个请求是 .strict()，
/// 因为 local_file 带 roots（本地路径）＝ 让 renderer 指挥主进程去读哪些目录，属 spec §16 禁止项。
/// 放开它必须等 U9 的目录授权流程（main 侧弹目录选择器、把授权结果存进设置、由 main 自行注入），
/// 在那之前允许勾选只会让用户点完「开始研究」收到一条 zod 报错。
const SCOPE_OPTIONS = [
  { key: "public_web", label: "公开网页", disabled: false },
  { key: "local_file", label: "本地文件", disabled: true },
  { key: "memory", label: "个人记忆", disabled: false },
] as const;

type ScopeKey = (typeof SCOPE_OPTIONS)[number]["key"];

/// 勾选项 → SourceScope。local_file 的 roots 先给空数组：
/// 「来源可用但尚未选定目录」是 core 定义的合法中间态（见 types.ts SourceScope），
/// 具体目录白名单由后续接线阶段接系统目录选择器补上。
function toScope(key: ScopeKey): SourceScope {
  if (key === "local_file") return { kind: "local_file", roots: [] };
  if (key === "memory") return { kind: "memory" };
  return { kind: "public_web" };
}

/// 把模式预算压成一行人话摘要（时长按分钟取整，毫秒对用户无意义）。
function budgetSummary(mode: ResearchMode): string {
  const b = MODE_BUDGETS[mode];
  return `最多 ${b.maxRounds} 轮 · ${b.maxDocuments} 篇文档 · ${Math.round(b.maxDurationMs / 60000)} 分钟`;
}

/// 新建研究表单：目标、模式、来源范围的采集入口，提交后交给宿主发起 create。
export function ResearchCreateForm({
  bridge,
  consumer = "deep_research",
  model,
  onCreated,
  onCancel,
}: ResearchCreateFormProps): ReactElement {
  const [objective, setObjective] = useState("");
  const [mode, setMode] = useState<ResearchMode>("standard");
  const [scopes, setScopes] = useState<ScopeKey[]>(["public_web"]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = objective.trim().length > 0 && scopes.length > 0 && !submitting;

  // 禁用项永远进不了 scopes：只靠 input 的 disabled 是不够的——那是 DOM 层的约定，
  // 而「请求里不得出现带本地路径的来源」是 IPC 契约，必须在状态这一层就成立。
  const toggleScope = (key: ScopeKey) => {
    if (SCOPE_OPTIONS.find((o) => o.key === key)?.disabled) return;
    setScopes((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const request: ResearchRequest = {
      consumer,
      objective: objective.trim(),
      mode,
      // 按 SCOPE_OPTIONS 的固定顺序输出，避免勾选先后影响请求内容（便于去重与测试）。
      // 再过一次 !o.disabled 是**兜底**：即便状态被别的路径污染，未开放的来源也出不了这个函数。
      sourceScopes: SCOPE_OPTIONS.filter((o) => !o.disabled && scopes.includes(o.key)).map((o) =>
        toScope(o.key),
      ),
      output: { format: "report", requireCitations: true },
    };
    let summary: ResearchSessionSummary;
    try {
      summary = await bridge.create(request);
    } catch (e) {
      setError(`创建失败：${e instanceof Error ? e.message : String(e)}`);
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    onCreated(summary);
  };

  return (
    <div className="pw-res-form">
      <div className="pw-res-form-title">新建研究</div>

      <label className="pw-res-field">
        <span className="pw-res-lbl">研究目标</span>
        <textarea
          className="pw-res-textarea"
          rows={4}
          value={objective}
          placeholder="想弄清楚什么？描述得越具体，拆解出的子问题越准"
          onChange={(e) => setObjective(e.target.value)}
        />
      </label>

      <fieldset className="pw-res-fieldset">
        <legend className="pw-res-lbl">研究强度</legend>
        {(["quick", "standard", "deep"] as const).map((m) => (
          <label key={m} className={`pw-res-opt${mode === m ? " is-on" : ""}`}>
            <input
              type="radio"
              name="research-mode"
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            <span className="pw-res-opt-l">{RESEARCH_MODE_LABELS[m].label}</span>
            <span className="pw-res-opt-hint">{RESEARCH_MODE_LABELS[m].hint}</span>
            <span className="pw-res-opt-budget">{budgetSummary(m)}</span>
          </label>
        ))}
      </fieldset>

      {/* 模型是**只读告知**而不是选择项：研究用哪个模型在设置里定，这里只让用户在按下
          「开始研究」之前看清楚「会用谁、正文会不会出本机」。放在这里而不是折叠起来，
          是因为「数据发给谁」必须在动作发生前可见。 */}
      {model ? (
        <div className={`pw-res-notice is-${model.isLocal ? "local" : "remote"}`}>
          <div className="pw-res-notice-title">
            {model.label ? `本次研究将使用：${model.label}` : "尚未配置可用的模型"}
          </div>
          <div className="pw-res-notice-summary">{model.egressZh}</div>
        </div>
      ) : null}

      <fieldset className="pw-res-fieldset">
        <legend className="pw-res-lbl">来源范围</legend>
        {SCOPE_OPTIONS.map((o) => (
          <label key={o.key} className={`pw-res-check${o.disabled ? " is-disabled" : ""}`}>
            <input
              type="checkbox"
              checked={scopes.includes(o.key)}
              disabled={o.disabled}
              onChange={() => toggleScope(o.key)}
            />
            <span>{o.label}</span>
            {/* 说明为什么不能选，否则用户只会看到一个没反应的勾选框。 */}
            {o.disabled ? <span className="pw-res-soon">即将支持</span> : null}
          </label>
        ))}
      </fieldset>

      {error ? <div className="pw-res-error">{error}</div> : null}

      <div className="pw-res-form-actions">
        <button type="button" className="pw-res-btn" onClick={onCancel}>
          取消新建
        </button>
        <button
          type="button"
          className="pw-res-btn is-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          开始研究
        </button>
      </div>
    </div>
  );
}
