// 左侧会话行与中心拆分容器之间唯一的拖放契约。使用自定义 MIME，避免文件、文本等
// 外部拖放误触会话拆分；payload 只携带 session id，不复制标题或其它易漂移元数据。
export const SESSION_DRAG_MIME = "application/x-cortex-session-id";
