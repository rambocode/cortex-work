// Deep Research 中栏：一次研究的执行视图（计划 → 轮次 → 失败 → 报告）+ 控制按钮。
//
// **按钮可用性完全由 status 决定**，判定委托给 ./labels 里那三个由 core 状态机推导的函数。
// UI 不发明第二套规则：亮着但点了报错，是最难排查的一类问题。
//
// 本组件不自行拉取详情：view 由宿主（ResearchWorkspace）按 "full" 级别取好后传入。
// 这样「什么时候拉、拉到什么级别」只有一个地方决定，证据正文不会被中栏悄悄带出来。
import { useMemo, useState, type AnchorHTMLAttributes, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ResearchActivity,
  ResearchProgress,
  ResearchWarning,
} from "@cortex-work/core/research/ui-store";
import { NON_TERMINAL_RESEARCH_STATUSES } from "@cortex-work/core/research/session-status";
import type {
  ResearchReport,
  ResearchSessionSummary,
  ResearchSessionView,
} from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchActivityFeed } from "./ResearchActivityFeed";
import {
  RESEARCH_STAGE_LABELS,
  RESEARCH_STATUS_META,
  canCancelSession,
  canPauseSession,
  canRerunSession,
  canResumeSession,
  canStartSession,
  fetchFailureLabel,
} from "./labels";
import { prepareReportMarkdown } from "./reportDisplay";

/// 链接 href 的展示层白名单：报告内容源自抓取的外部网页与 LLM 输出，
/// 自定义锚点组件不能默认信任 href——只放行 http(s) / mailto 与页内/相对地址，
/// 其余（javascript:、data: 等）剥掉 href 按纯文本渲染。
/// （react-markdown 的默认 urlTransform 已有一层协议过滤，这里是纵深防御的第二层。）
function isSafeHref(href: string): boolean {
  if (href === "") return true;
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("?")) return true;
  try {
    // 带占位 base 解析：相对路径也会落成 https:，只有自带危险协议的绝对 URL 被拦下。
    const protocol = new URL(href, "https://report.invalid").protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    // 解析失败的未知形态一律不放行。
    return false;
  }
}

/// 引用 chip 的锚点渲染：prepareReportMarkdown 已把 [^chunkId] 转成 [[n]](#cite-n) 链接，
/// 这里拦截 #cite- 前缀渲染成上标 chip，点击平滑滚动到文末对应的参考来源条目。
/// 其余链接先过 isSafeHref 白名单再渲染。滚动 API 在 jsdom 里不存在，用可选调用兜底。
function ReportAnchor(props: AnchorHTMLAttributes<HTMLAnchorElement>): ReactElement {
  const href = props.href ?? "";
  if (!href.startsWith("#cite-")) {
    if (isSafeHref(href)) return <a {...props} />;
    // 危险协议：剥掉 href 与 target，只保留文字内容，宁可不可点也不放出 javascript: URL。
    const { href: _dropHref, target: _dropTarget, ...rest } = props;
    return <a {...rest} />;
  }
  return (
    <a
      className="pw-res-cite"
      href={href}
      title={props.title}
      onClick={(e) => {
        e.preventDefault();
        document
          .getElementById(href.slice(1))
          ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      }}
    >
      {props.children}
    </a>
  );
}

/// react-markdown 的组件映射。模块级常量，避免每次渲染换引用导致整棵 markdown 树重建。
const REPORT_MD_COMPONENTS = { a: ReportAnchor };

/// 运行视图的 props。onExportMarkdown 可覆盖默认的浏览器下载（宿主可改走桌面桥写盘）。
export interface ResearchRunViewProps {
  /// 为 null 表示没有桌面桥（Web 端）；此时所有控制按钮禁用，内容仍可只读展示。
  bridge: ResearchBridgeLike | null;
  session: ResearchSessionSummary | null;
  /// "full" 级别的详情（计划 / 轮次 / 报告）。不含文档与证据正文——那是右栏的事。
  view?: ResearchSessionView;
  /// 实时阶段进度（来自 ui-store 的事件派生态）。
  progress?: ResearchProgress;
  /// 非终态错误累积的警告，按 FetchFailureCode 翻成中文说明。
  warnings?: ResearchWarning[];
  /// 实时活动流水（事件派生态）。缺省或为空时整段不渲染。
  activities?: readonly ResearchActivity[];
  /// 报告的流式草稿。只在「撰写中且最终报告还没落库」时展示——
  /// 最终稿到位后必须让位，否则同一份内容会出现两遍（且草稿那份没有引用 chip）。
  reportDraft?: string;
  /// 导出报告 Markdown。由宿主决定落盘方式（下载 / 写文件 / 复制），组件只负责给内容。
  onExportMarkdown?: (markdown: string, session: ResearchSessionSummary) => void;
  /// 新建时自动 run 失败的原因。
  ///
  /// 由宿主透传而不是本组件自己产生：那次 run 发生在创建表单里，而表单在 onCreated 之后
  /// 立刻卸载，局部 state 里的错误随之消失——用户只会看到一个停在「待开始」的会话，
  /// 却没有任何线索（真实踩过：搜索服务未配置导致 run 抛错，界面上毫无提示）。
  startError?: string | null;
  /// 重跑完成后的回调，参数是**新建的**会话。
  ///
  /// 由宿主处理而不是组件自己跳转：重跑产出的是一个新 sessionId，选中它、把它插进列表
  /// 都属于工作区的职责（同 onCreated）。缺省时按钮禁用——没人接管新会话的话，
  /// 用户点完会看到「什么都没发生」，而后台其实已经建了一个会话。
  onRerun?: (created: ResearchSessionSummary) => void;
  /// 原证据重生成成功后的报告；宿主负责替换 detail cache。
  onReportRegenerated?: (report: ResearchReport) => void;
}

/// 单个研究会话的运行视图：进度、轮次、报告正文与来源面板的容器。
export function ResearchRunView({
  bridge,
  session,
  view,
  progress,
  warnings,
  activities,
  reportDraft,
  onExportMarkdown,
  startError,
  onRerun,
  onReportRegenerated,
}: ResearchRunViewProps): ReactElement {
  // 控制类调用的失败提示（暂停/恢复/取消可能因状态已变而被 main 拒绝）。
  const [actionError, setActionError] = useState<string | null>(null);
  const [regeneratingReport, setRegeneratingReport] = useState(false);

  // 报告正文的展示层预处理：剥重复标题、引用标记编号化（见 reportDisplay 的头部注释）。
  // 只影响渲染——导出用的仍是原始 report.markdown。
  // 注意必须放在「!session 提前 return」之前：hook 数量不能随 props 变化。
  const report = view?.report;
  const objective = session?.objective ?? "";
  const reportSourceStats = report
    ? report.generationStats
      ? `${report.generationStats.availableDocumentCount} 篇已抓取 · ${report.generationStats.includedDocumentCount} 篇入选 · ${report.generationStats.citedDocumentCount} 篇引用`
      : `${session?.documentCount ?? 0} 篇已抓取 · ${new Set(report.citations.map((citation) => citation.documentId)).size} 篇引用`
    : null;
  const preparedReport = useMemo(
    () =>
      report
        ? prepareReportMarkdown({
            markdown: report.markdown,
            objective,
            citations: report.citations,
          })
        : null,
    [report, objective],
  );

  if (!session) {
    return (
      <div className="pw-res-run is-empty">
        <div className="pw-res-empty">在左侧选择一个研究，或新建一个</div>
      </div>
    );
  }

  const status = session.status;
  const meta = RESEARCH_STATUS_META[status] ?? { label: status, tone: "idle" as const };
  const plan = view?.plan;
  const rounds = view?.rounds ?? [];
  const failures = warnings ?? [];
  const running = (NON_TERMINAL_RESEARCH_STATUSES as readonly string[]).includes(status);
  // 草稿只在「还没有最终报告」时出场。最终稿一到（done 事件后宿主会重拉 full），
  // 这里自动切回带引用 chip 的正式渲染。
  const draft = !report && reportDraft ? reportDraft : null;

  // 控制动作统一包一层：禁用态直接不触发，失败只提示不改本地状态
  // （状态真源在 main，会经事件回流，本地猜测反而会闪烁）。
  const invoke = async (
    action: "run" | "pause" | "resume" | "cancel",
    label: string,
  ): Promise<void> => {
    if (!bridge) return;
    setActionError(null);
    try {
      await bridge[action](session.sessionId);
    } catch (e) {
      setActionError(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="pw-res-run">
      <div className="pw-res-run-head">
        <div className="pw-res-run-title">{session.objective}</div>
        <div className="pw-res-run-sub">
          <span className={`pw-res-badge is-${meta.tone}`}>{meta.label}</span>
          {progress ? (
            <span className="pw-res-progress">
              {progress.total !== undefined && progress.completed !== undefined
                ? `${RESEARCH_STAGE_LABELS[progress.stage]} ${progress.completed} / ${progress.total}`
                : `${RESEARCH_STAGE_LABELS[progress.stage]}中`}
            </span>
          ) : null}
          {/* 有明确总量时配一条细进度条，纯文字百分比不直观。 */}
          {progress && progress.total !== undefined && progress.completed !== undefined ? (
            <div className="pw-res-progressbar" aria-hidden="true">
              <div
                className="pw-res-progressbar-fill"
                style={{
                  width: `${Math.min(100, Math.round((progress.completed / Math.max(1, progress.total)) * 100))}%`,
                }}
              />
            </div>
          ) : null}
        </div>
        <div className="pw-res-run-actions">
          {/* 按钮分三档（见 research.css 按钮注释）：当前唯一可做的建设性动作
              （开始 / 恢复）用 is-primary 高亮，其余次动作默认描边，导出与收起类弱动作用 is-ghost。
              「开始」只在 created 时可用。新建时的自动 run 失败（如搜索服务未配好）会把会话
              留在 created，没有这个按钮就只能删掉重建——见 canStartSession 的注释。 */}
          {/* 「重跑」：终态会话的唯一出路。它**新建一个会话**而不是就地重置——
              终态在状态机里没有出口，就地改写会让旧报告引用的证据凭空消失
              （见 core/research/session-status 的注释）。旧会话原样保留。 */}
          <button
            type="button"
            className={`pw-res-btn${canRerunSession(status) && onRerun ? " is-primary" : ""}`}
            disabled={!bridge || !canRerunSession(status) || !onRerun}
            onClick={() => {
              if (!bridge || !onRerun) return;
              setActionError(null);
              void bridge
                .rerun(session.sessionId)
                .then(onRerun)
                .catch((e: unknown) =>
                  setActionError(`重跑失败：${e instanceof Error ? e.message : String(e)}`),
                );
            }}
          >
            重跑
          </button>
          <button
            type="button"
            className="pw-res-btn"
            disabled={
              !bridge ||
              status !== "completed" ||
              !report ||
              !onReportRegenerated ||
              regeneratingReport
            }
            onClick={() => {
              if (!bridge || !report || !onReportRegenerated) return;
              setActionError(null);
              setRegeneratingReport(true);
              void bridge
                .regenerateReport(session.sessionId)
                .then(onReportRegenerated)
                .catch((e: unknown) =>
                  setActionError(
                    `重新生成报告失败：${e instanceof Error ? e.message : String(e)}`,
                  ),
                )
                .finally(() => setRegeneratingReport(false));
            }}
          >
            {regeneratingReport ? "正在重新生成…" : "重新生成报告"}
          </button>
          <button
            type="button"
            className={`pw-res-btn${canStartSession(status) ? " is-primary" : ""}`}
            disabled={!bridge || !canStartSession(status)}
            onClick={() => void invoke("run", "开始")}
          >
            开始
          </button>
          <button
            type="button"
            className="pw-res-btn"
            disabled={!bridge || !canPauseSession(status)}
            onClick={() => void invoke("pause", "暂停")}
          >
            暂停
          </button>
          <button
            type="button"
            className={`pw-res-btn${canResumeSession(status) ? " is-primary" : ""}`}
            disabled={!bridge || !canResumeSession(status)}
            onClick={() => void invoke("resume", "恢复")}
          >
            恢复
          </button>
          <button
            type="button"
            className="pw-res-btn"
            disabled={!bridge || !canCancelSession(status)}
            onClick={() => void invoke("cancel", "取消")}
          >
            取消
          </button>
          <button
            type="button"
            className="pw-res-btn is-ghost"
            disabled={!report || !onExportMarkdown}
            onClick={() => report && onExportMarkdown?.(report.markdown, session)}
          >
            导出 Markdown
          </button>
        </div>
        {actionError ? <div className="pw-res-error">{actionError}</div> : null}
        {/* 本地操作错误优先：用户刚点过按钮时，那条更贴近他当下的动作。 */}
        {!actionError && startError ? <div className="pw-res-error">{startError}</div> : null}
        {status === "failed" && session.errorMessage ? (
          <div className="pw-res-error">{session.errorMessage}</div>
        ) : null}
      </div>

      <div className="pw-res-run-body">
        {plan ? (
          <section className="pw-res-sec">
            <div className="pw-res-sec-title">研究计划</div>
            <ul className="pw-res-subq">
              {plan.subquestions.map((q) => (
                <li key={q.id}>
                  <span className="pw-res-subq-text">{q.text}</span>
                  {q.rationale ? <span className="pw-res-subq-why">{q.rationale}</span> : null}
                </li>
              ))}
            </ul>
            <div className="pw-res-sec-sub">初始查询</div>
            <ul className="pw-res-queries">
              {plan.initialQueries.map((q) => (
                <li key={q.queryId}>{q.text}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {rounds.length > 0 ? (
          <section className="pw-res-sec">
            <div className="pw-res-sec-title">{`轮次（共 ${session.roundCount} 轮）`}</div>
            <ul className="pw-res-rounds">
              {rounds.map((r) => (
                <li key={r.roundIndex}>
                  <span className="pw-res-round-idx">{`第 ${r.roundIndex + 1} 轮`}</span>
                  <span className="pw-res-round-meta">
                    {`${r.queryIds.length} 条查询 · ${r.candidateCount} 个候选 · ${r.documentCount} 篇已抓取文档`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <ResearchActivityFeed activities={activities ?? []} running={running} />

        {failures.length > 0 ? (
          <section className="pw-res-sec">
            <div className="pw-res-sec-title">{`未能采信的来源（${failures.length}）`}</div>
            <ul className="pw-res-failures">
              {failures.map((f, i) => (
                <li key={`${f.code}-${i}`}>
                  <span className="pw-res-fail-code">{fetchFailureLabel(f.code)}</span>
                  <span className="pw-res-fail-msg">{f.message}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 报告草稿：模型边写边推的正文。刻意**不做**引用 chip 化——引用表要等报告落库后
            才存在，草稿阶段把 [^chunkId] 硬渲染成 chip 只会得到一串指向空处的编号。 */}
        {draft ? (
          <section className="pw-res-sec">
            <div className="pw-res-sec-title">
              研究报告
              <span className="pw-res-draft-tag">正在撰写…</span>
            </div>
            <div className="pw-res-report-card is-draft">
              <div className="pw-res-md">
                <Markdown remarkPlugins={[remarkGfm]} components={REPORT_MD_COMPONENTS}>
                  {draft}
                </Markdown>
              </div>
            </div>
          </section>
        ) : null}

        {report && preparedReport ? (
          <section className="pw-res-sec">
            <div className="pw-res-sec-title">研究报告</div>
            {reportSourceStats ? <div className="pw-res-sec-sub">{reportSourceStats}</div> : null}
            {report.unsupportedSections.length > 0 ? (
              <div className="pw-res-warn">
                {`有 ${report.unsupportedSections.length} 处结论缺少有效引用，已标注为待核实`}
              </div>
            ) : null}
            {report.generationStats?.qualityPassed === false ? (
              <div className="pw-res-warn">
                {`报告未完全达到研究完整度标准：${report.generationStats.qualityIssues?.join("；") || "请检查内容与证据覆盖"}`}
              </div>
            ) : null}
            {/* 报告正文放进纸张式卡片并限宽，长文阅读不靠整栏铺满。 */}
            <div className="pw-res-report-card">
              <div className="pw-res-md">
                <Markdown remarkPlugins={[remarkGfm]} components={REPORT_MD_COMPONENTS}>
                  {preparedReport.markdown}
                </Markdown>
              </div>
              {/* 参考来源：编号与正文 chip 一一对应，锚点 id 供 chip 点击滚动定位。 */}
              {preparedReport.refs.length > 0 ? (
                <div className="pw-res-refs">
                  <div className="pw-res-refs-title">{`参考来源（${preparedReport.refs.length}）`}</div>
                  <ol className="pw-res-refs-list">
                    {preparedReport.refs.map((ref) => (
                      <li key={ref.chunkId} id={`cite-${ref.index}`}>
                        <span className="pw-res-refs-idx">{`[${ref.index}]`}</span>
                        <span className="pw-res-refs-name" title={ref.url}>
                          {ref.title ?? ref.chunkId}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
