import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DevPreviewCard } from "./DevPreviewCard";

describe("DevPreviewCard", () => {
  it("无 URL 时不渲染", () => {
    const { container } = render(<DevPreviewCard urls={[]} onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("渲染 URL 标签(host)并在点击时回调原始 URL", () => {
    const onOpen = vi.fn();
    render(<DevPreviewCard urls={["http://127.0.0.1:5173/"]} onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: /127\.0\.0\.1:5173/ });
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith("http://127.0.0.1:5173/");
  });

  it("渲染多个 URL chip", () => {
    render(
      <DevPreviewCard
        urls={["http://localhost:5173/", "http://localhost:3000/"]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("localhost:5173")).toBeTruthy();
    expect(screen.getByText("localhost:3000")).toBeTruthy();
  });
});
