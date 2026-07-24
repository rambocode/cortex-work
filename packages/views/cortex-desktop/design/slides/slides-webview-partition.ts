// slides deck webview 的会话分区。必须带 persist: 前缀:不带前缀的 partition 是
// Electron 内存 session,localStorage(bento 语言 bento-lang、动效偏好
// bento-reduce-motion)随退出即丢 —— 「设置语言不持久化」的根因。
// 与 apps/desktop/src/main/presenter-window.ts 的放映窗分区保持一致(同一 session,
// file:// 源共享 localStorage:编辑器里设的语言/动效偏好对放映的演讲者视图同样生效)。
export const SLIDES_WEBVIEW_PARTITION = 'persist:cortex-slides'
