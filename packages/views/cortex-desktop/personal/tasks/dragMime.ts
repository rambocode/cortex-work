// Tasks 面板条目拖入会话的应用内自定义 MIME。独立轻模块，理由同 files/dragMime.ts：
// 避免 ComposerShell 因取常量而把 TodosView 拖进主 chunk,破坏懒加载。
export const TODO_DRAG_MIME = "application/x-cortex-todo";
