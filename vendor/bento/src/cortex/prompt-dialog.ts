// CORTEX-PATCH file — 页内文本输入弹层,替代 window.prompt。
//
// 为什么必须有:Electron 的渲染进程把 window.prompt 覆写成了直接抛异常
// (`window.prompt=function(){throw new Error("prompt() is not supported.")}`)。
// bento 原有 5 处 window.prompt 在 Cortex Desktop 里因此全部静默失效——评论(作者名/正文/
// 改名)、媒体外链、布局命名点了都毫无反应,异常还会被 capture 阶段的事件处理器吞掉。
//
// 实现照抄上游自己的范式:editor.ts 的 promptPassword() 用 <dialog> + showModal() 做页内
// 异步模态。这里把它泛化成通用的单行/多行文本输入,返回 Promise<string | null>。
// window.confirm / alert 在 Electron 里是支持的,不需要同类处理。
import { t } from '../i18n'

export interface CortexPromptOptions {
  /** 弹层标题(必填,相当于原 window.prompt 的提示语)。 */
  title: string
  /** 输入框上方的字段名;省略时不渲染 label。 */
  label?: string
  /** 初始值(对应 window.prompt 的第二参数)。 */
  value?: string
  placeholder?: string
  /** 多行输入(评论正文用),提交键改为 ⌘/Ctrl+Enter。 */
  multiline?: boolean
  okLabel?: string
}

/**
 * 弹出页内输入框,返回 trim 后的文本;取消或输入为空时返回 null
 * (与原 `window.prompt(...)?.trim() || null` 的调用语义一致,调用点无需再判空串)。
 */
export function cortexPromptText(options: CortexPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog')
    dlg.className = 'ed-dialog ed-cortexprompt'

    const heading = document.createElement('h2')
    heading.textContent = options.title
    dlg.appendChild(heading)

    const field = document.createElement('label')
    if (options.label) field.append(options.label)
    const input = options.multiline
      ? document.createElement('textarea')
      : document.createElement('input')
    if (input instanceof HTMLInputElement) input.type = 'text'
    if (input instanceof HTMLTextAreaElement) input.rows = 3
    input.value = options.value ?? ''
    if (options.placeholder) input.placeholder = options.placeholder
    field.appendChild(input)
    dlg.appendChild(field)

    const actions = document.createElement('div')
    actions.className = 'ed-dialog-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'cancel'
    cancel.textContent = t('Cancel')
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'ok ed-primary'
    ok.textContent = options.okLabel ?? t('Done')
    actions.append(cancel, ok)
    dlg.appendChild(actions)

    // done() 只允许生效一次:cancel 事件与按钮点击可能先后到达(Esc 关闭时尤其),
    // 二次 resolve 虽被 Promise 忽略,但 remove() 重入会抛。
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      dlg.close()
      dlg.remove()
      resolve(value)
    }
    const submit = (): void => {
      const text = input.value.trim()
      done(text ? text : null)
    }

    cancel.addEventListener('click', () => done(null))
    ok.addEventListener('click', submit)
    // Esc / 浏览器原生取消。
    dlg.addEventListener('cancel', (ev) => {
      ev.preventDefault()
      done(null)
    })
    // 单行:Enter 直接提交。多行:Enter 换行,⌘/Ctrl+Enter 提交(与聊天输入的直觉一致)。
    // 经 HTMLElement 挂监听:input 是 input|textarea 联合类型,直接 addEventListener
    // 会让重载退化到裸 Event,拿不到 KeyboardEvent 的按键字段。
    ;(input as HTMLElement).addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return
      if (options.multiline && !(ev.metaKey || ev.ctrlKey)) return
      ev.preventDefault()
      submit()
    })

    document.body.appendChild(dlg)
    dlg.showModal()
    input.focus()
    input.select()
  })
}
