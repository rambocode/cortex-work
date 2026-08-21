// 默认头部标题行片段（标题 + 弹性占位）。宿主默认头与自定义 renderHead（如 artifact
// 的非 slides 分支）共用,保证类名结构与 CSS/测试契约一致。

export function PanelHeadTitle({ title }: { title: string }) {
  return (
    <>
      <span className="pw-col-head-title">{title}</span>
      <div className="spacer" />
    </>
  );
}
