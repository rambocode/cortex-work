import { describe, expect, it } from "vitest";

import {
  readSlidesWebSearch,
  slidesWebSearchKey,
  slidesWebSearchValue,
} from "./slides-web-search";

describe("slides web search designUi 编解码", () => {
  it("按设计稿隔离持久化键", () => {
    expect(slidesWebSearchKey("deck-1")).toBe("slides.webSearch.deck-1");
    expect(slidesWebSearchKey("deck-2")).not.toBe(slidesWebSearchKey("deck-1"));
  });

  it("只有精确的 1 表示开启", () => {
    expect(readSlidesWebSearch({ "slides.webSearch.deck-1": "1" }, "deck-1")).toBe(true);
    expect(readSlidesWebSearch({ "slides.webSearch.deck-1": "true" }, "deck-1")).toBe(false);
    expect(readSlidesWebSearch({}, "deck-1")).toBe(false);
  });

  it("关闭时删除键而非持久化 false", () => {
    expect(slidesWebSearchValue(true)).toBe("1");
    expect(slidesWebSearchValue(false)).toBeNull();
  });
});
