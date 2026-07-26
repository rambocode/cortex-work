/** Slides 会话栏联网状态在持久化 designUi KV 中的键。 */
export function slidesWebSearchKey(docId: string): string {
  return `slides.webSearch.${docId}`;
}

/** 缺失或脏值一律按关闭处理，出站能力默认保守。 */
export function readSlidesWebSearch(
  designUi: Readonly<Record<string, string>>,
  docId: string,
): boolean {
  return designUi[slidesWebSearchKey(docId)] === "1";
}

/** 关闭时删除 KV，避免持久化无意义的 false 值。 */
export function slidesWebSearchValue(on: boolean): "1" | null {
  return on ? "1" : null;
}
