// 文件拖入会话的应用内自定义 MIME（payload {path,name}）。独立轻模块：ComposerShell（主 chunk）
// 只需这个常量,若直接 import FilesView 会把整个文件面板拖进主 chunk,破坏右栏面板懒加载。
export const FILE_DRAG_MIME = "application/x-cortex-file";
