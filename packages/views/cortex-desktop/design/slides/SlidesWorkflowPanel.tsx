import type { ReactElement } from 'react'
import { Bot, Check, FlaskConical, MessageSquareText, RefreshCw, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  SlidesPipelineRun,
  SlidesPipelineRunKind,
  SlidesRole,
  SlidesRoleRunStatus
} from '@cortex-work/core/design/slides/slides-pipeline-types'

type Props = {
  open: boolean
  run: SlidesPipelineRun | null
  loading?: boolean
  onClose: () => void
  onStart: (kind: SlidesPipelineRunKind) => void
  onAccept?: (role: SlidesRole) => void
  onReject?: (role: SlidesRole) => void
  onRetry?: (role: SlidesRole) => void
  onCancel?: () => void
}

const ROLE_LABEL: Record<SlidesRole, string> = {
  'topic-researcher': '主题研究',
  'visual-researcher': '视觉研究',
  'narrative-reviewer': '叙事审阅',
  'render-reviewer': '渲染审阅',
  'notes-writer': '备注撰写'
}

const STATUS_LABEL: Record<SlidesRoleRunStatus, string> = {
  queued: '等待中',
  running: '运行中',
  'awaiting-approval': '待批准',
  accepted: '已接受',
  rejected: '已拒绝',
  failed: '失败',
  canceled: '已取消'
}

function elapsed(createdAt: string, updatedAt: string): string {
  const ms = Date.parse(updatedAt) - Date.parse(createdAt)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`
}

export function SlidesWorkflowPanel({
  open,
  run,
  loading = false,
  onClose,
  onStart,
  onAccept,
  onReject,
  onRetry,
  onCancel
}: Props): ReactElement | null {
  const { t } = useTranslation('design')
  if (!open) return null
  return (
    <aside
      aria-label={t('slidesWorkflow')}
      className="absolute right-3 top-3 z-30 flex max-h-[calc(100%-24px)] w-[340px] flex-col overflow-hidden rounded-2xl border border-black/10 bg-ds-main shadow-xl dark:border-white/10"
    >
      <header className="flex items-center justify-between border-b border-black/8 px-4 py-3 dark:border-white/8">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-ds-strong">
          <Bot className="h-4 w-4 text-[#3b82d8]" />
          {t('slidesWorkflow')}
        </div>
        <button type="button" aria-label={t('slidesWorkflowClose')} onClick={onClose} className="rounded-md p-1 text-ds-muted hover:bg-black/5">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="overflow-y-auto p-3">
        <div className="grid gap-2">
          <button type="button" disabled={loading} onClick={() => onStart('research')} className="inline-flex items-center gap-2 rounded-xl border border-black/8 px-3 py-2 text-left text-[12px] text-ds-strong transition hover:bg-black/5 disabled:opacity-50 dark:border-white/8 dark:hover:bg-white/8">
            <Search className="h-4 w-4" />{t('slidesWorkflowResearch')}
          </button>
          <button type="button" disabled={loading} onClick={() => onStart('review')} className="inline-flex items-center gap-2 rounded-xl border border-black/8 px-3 py-2 text-left text-[12px] text-ds-strong transition hover:bg-black/5 disabled:opacity-50 dark:border-white/8 dark:hover:bg-white/8">
            <FlaskConical className="h-4 w-4" />{t('slidesWorkflowReview')}
          </button>
          <button type="button" disabled={loading} onClick={() => onStart('notes')} className="inline-flex items-center gap-2 rounded-xl border border-black/8 px-3 py-2 text-left text-[12px] text-ds-strong transition hover:bg-black/5 disabled:opacity-50 dark:border-white/8 dark:hover:bg-white/8">
            <MessageSquareText className="h-4 w-4" />{t('slidesWorkflowNotes')}
          </button>
        </div>

        {run ? (
          <section className="mt-4" aria-label={`工作流 ${run.id}`}>
            <div className="mb-2 flex items-center justify-between text-[11.5px] text-ds-muted">
              <span>{run.status}</span>
              <span>{elapsed(run.createdAt, run.updatedAt)}</span>
            </div>
            <ul className="space-y-2">
              {run.roles.map((role) => (
                <li key={role.role} className="rounded-xl border border-black/8 p-3 dark:border-white/8">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-ds-strong">{ROLE_LABEL[role.role]}</span>
                    <span className="text-[11px] text-ds-muted">{STATUS_LABEL[role.status]}</span>
                  </div>
                  {role.summary ? <p className="mt-1.5 text-[11.5px] leading-4 text-ds-muted">{role.summary}</p> : null}
                  {role.errorMessage ? <p className="mt-1.5 text-[11.5px] text-[#c0392b]">{role.errorMessage}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {role.status === 'awaiting-approval' && onAccept && onReject ? (
                      <>
                        <button type="button" aria-label={`接受 ${role.role}`} onClick={() => onAccept(role.role)} className="inline-flex items-center gap-1 rounded-md bg-[#2376d2]/10 px-2 py-1 text-[11px] text-[#2376d2]">
                          <Check className="h-3 w-3" />接受
                        </button>
                        <button type="button" aria-label={`拒绝 ${role.role}`} onClick={() => onReject(role.role)} className="rounded-md px-2 py-1 text-[11px] text-ds-muted hover:bg-black/5">
                          拒绝
                        </button>
                      </>
                    ) : null}
                    {(role.status === 'failed' || role.status === 'rejected') && onRetry ? (
                      <button type="button" aria-label={`重试 ${role.role}`} onClick={() => onRetry(role.role)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ds-muted hover:bg-black/5">
                        <RefreshCw className="h-3 w-3" />重试
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {run.status === 'running' || run.status === 'awaiting-approval' ? (
              <button type="button" onClick={onCancel} disabled={!onCancel} className="mt-3 w-full rounded-lg px-3 py-1.5 text-[12px] text-[#c0392b] hover:bg-[#c0392b]/8">
                {t('slidesWorkflowCancel')}
              </button>
            ) : null}
          </section>
        ) : (
          <p className="mt-4 text-[11.5px] leading-5 text-ds-muted">{t('slidesWorkflowEmpty')}</p>
        )}
      </div>
    </aside>
  )
}
