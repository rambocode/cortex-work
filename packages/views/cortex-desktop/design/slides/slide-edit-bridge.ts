// Slide 应用内编辑 bridge:宿主(renderer)与 slide webview 之间的受控消息协议。
//
// 传输模型(与仓库既有 design canvas 一致):**宿主 pull,不是 guest push**。
//   Electron `<webview>` 的 guest 是独立 frame,`window.parent.postMessage` 到不了
//   宿主;而给 webview 挂 preload 会把宿主能力暴露给 slide 页面。因此页内脚本只把
//   结构化消息压进 `window.__cortexSlidesBridge` 的队列,宿主经 executeJavaScript
//   周期性 drain(与 useDesignHtmlPreview.executeScript 同款通道)。
//
// 能力(editMode 下):
//  - 文字编辑:双击白名单标签/纯文本块进入 contenteditable;
//  - 选择:单击选中(蓝框),Shift/Cmd+单击切换多选,点空白清空;空白处按下拖矩形
//    框选(相交即选,实时反馈;嵌套只选最外层命中元素)。满画布(≥90% 视口)的
//    定位容器视为页面背景:点它=点空白,框选可从其上发起;完全包住框选矩形的
//    容器不入选(在其内部框选=选其子元素);
//  - 移动:拖拽已选元素成组移动(2px 阈值区分点击;拖拽期间经 transform 走合成器
//    实时反馈,松手落盘 left/top —— absolute/fixed 释放 right/bottom,流内元素转
//    position:relative 偏移,不影响兄弟布局);方向键微调(Shift ×10);
//  - 旋转 v1:单选出旋转手柄(包围盒顶上),绕元素中心旋转,Shift 吸附 15°;
//    CSS transform rotate 落盘并保留既有变换;旋转态下缩放手柄隐藏(AABB 错位);
//  - 删除:选中后 Delete/Backspace 批量删除;
//  - 撤销/重做:动作前入栈 body 快照(Cmd/Ctrl+Z、Shift+Cmd+Z / Ctrl+Y,或宿主工具栏
//    下发 undo/redo 命令);history-changed 消息驱动宿主按钮可用态;
//  - 元素对齐:多选后宿主工具栏下发 align-elements,各选中元素按选区包围盒
//    对齐左/水平居中/右/上/垂直居中/下(区别于 align 命令的 text-align);
//  - 粘贴图片:paste 剪贴板位图 → 画布内缩放 + webp 转码(逐档降质控制字节预算)
//    → data URL 形式居中插入为可移动 <img> 并选中;插入后整页逼近 2MB 上限则拒绝;
//  - 层级调整:z-order 命令按「与所选重叠的元素」比较绘制序调 z-index(static 目标
//    先转 relative 让 z-index 生效);上移/下移一层、置顶/置底;
//  - 缩放:单选时元素四周出手柄。文本/容器自由调宽高(nowrap 文本先转可换行、
//    解除 max-width/flex 约束,调宽即自动折行);图片(img/video)只出四角手柄,
//    按初始宽高比等比缩放;西/北侧手柄锚定对侧边不动;
//  - 复制/粘贴元素:copy 把所选元素净化 outerHTML 写入剪贴板自定义 mime;
//    paste 优先识别该 mime,克隆经 DOMParser 惰性解析 + 清洗(剥脚本/on* 属性)后
//    插回原元素旁(+16px 偏移,跨页粘贴挂 body)并选中;文字编辑态交给原生;
//  - 吸附对齐:拖拽时组包围盒对画布边缘/中线与其它定位元素边/中线做 5px 吸附,
//    显示参考线(data-cortex-bridge 标记,不落盘);按住 Alt 临时禁用;指针高速
//    移动时自动不吸附(速度自适应:快速=路过,慢速=对齐),消除黏手/跳变;
//  - 选区上报:selection-changed 携带 elementId/tagName/rect/文本摘要,宿主存入
//    slides-store,发消息时并入 LLM 回合的选区上下文(精准修订)。
//
// 安全契约(务必遵守):
//  - 版本化协议:每条消息必须带 `__cortexSlides: 1` 与白名单内的 type;任何不合协议的
//    输入(页面伪造的队列内容、未知 type、字段类型错、超大 HTML)一律丢弃 ——
//    绝不按 method name 派发。
//  - slide 页面拿不到 preload / Node 能力:落盘由宿主经 slides:saveEditedHtml IPC 完成,
//    主进程再做全量校验(路径/revision/字节数)。
//  - 可编辑目标 = 标签在 allowlist 内(见 EDITABLE_TAGS)或「纯文本块」(自身有直接
//    文本且子元素全为内联,如放 emoji 的 div);可选中/移动目标额外接受图形类标签
//    (svg/img/canvas/table 等)与绝对/固定定位块。不要求预先带 data-cortex-id ——
//    Agent 生成的页面常把 id 打在容器 div 上,若强依赖会导致整页不可编辑(用户实测)。
//    选中时缺 id 就地补打并随保存落盘,保证 LLM 修订有稳定锚点。
//  - presenter/导出渲染不注入本 bridge(见 export/html.ts 与 render.ts)。
//
// 保存策略:变更(文字/移动/删除/补 id)500ms debounce → 序列化整页 HTML(剥离编辑态
// 属性)→ 宿主携带 expectedRevision 保存;冲突时宿主停止自动保存并提示刷新(见 slides-store)。

// 协议层(类型/常量/校验/编译)在 slide-bridge-protocol.ts;此处 re-export 保持
// 既有调用方(SlidesStage / slides-store / 测试)的导入路径不变。
export * from './slide-bridge-protocol'
import {
  EDIT_SAVE_DEBOUNCE_MS,
  EDITABLE_TAGS,
  MAX_EDITED_HTML_BYTES,
  SELECTION_TEXT_MAX,
  SLIDE_BRIDGE_PROTOCOL
} from './slide-bridge-protocol'
// 页内注入脚本本体与扩展子系统(自包含函数;仅在 builder 中 toString 使用)。
import { slideEditBridgeInPage } from './slide-edit-inpage'
import { slideEditExtrasInPage } from './slide-edit-inpage-extras'



/** 生成可直接 executeJavaScript 的注入源码(幂等:重复注入不会重复挂载)。 */
export function buildSlideEditBridgeSource(): string {
  const config = JSON.stringify({
    protocol: SLIDE_BRIDGE_PROTOCOL,
    editableTags: [...EDITABLE_TAGS],
    debounceMs: EDIT_SAVE_DEBOUNCE_MS,
    textMax: SELECTION_TEXT_MAX,
    htmlMaxBytes: MAX_EDITED_HTML_BYTES
  })
  // 幂等守卫:webview 每次 dom-ready 都会注入,已挂载则跳过。
  // 扩展子系统(框选/旋转/z-order)作为第二参数一并注入,主脚本初始化末尾装配。
  return `(function(){ if (window.__cortexSlidesBridge) return; (${slideEditBridgeInPage.toString()})(${config}, ${slideEditExtrasInPage.toString()}); })()`
}
