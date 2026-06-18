import { describe, expect, it } from "vitest";
import { mapLimit } from "./scan-limit";

describe("mapLimit", () => {
  it("limits concurrent async work and preserves order", async () => {
    let active = 0;
    let maxActive = 0;

    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 10;
    });

    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("treats invalid limits as one worker", async () => {
    let active = 0;
    let maxActive = 0;

    await mapLimit([1, 2, 3], 0, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });

    expect(maxActive).toBe(1);
  });
});

