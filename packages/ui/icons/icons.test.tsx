import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Icon } from "./index";

describe("Icon", () => {
  // Guards against the prototype's original bug where `size` was passed as the
  // first positional arg and the SVG ended up width="[object Object]".
  it("renders a numeric width/height from the size prop", () => {
    const { container } = render(<Icon.Edit size={15} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toBeInTheDocument();
    expect(svg.getAttribute("width")).toBe("15");
    expect(svg.getAttribute("height")).toBe("15");
  });

  it("defaults size to 16 when not provided", () => {
    const { container } = render(<Icon.Search />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
  });

  it("applies a custom stroke-width override (More uses 2.4)", () => {
    const { container } = render(<Icon.More />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("stroke-width")).toBe("2.4");
  });
});
