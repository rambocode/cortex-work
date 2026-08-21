// Skills 面板文件树拖入会话的应用内自定义 MIME。独立轻模块，理由同 files/dragMime.ts：
// 避免 ComposerShell 因取常量而把 PromptPanel 拖进主 chunk,破坏懒加载。
export const PROMPT_DRAG_MIME = "application/x-cortex-prompt";
