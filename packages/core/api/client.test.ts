import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

describe("ApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends auth, workspace and client metadata headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({
      baseUrl: "http://localhost:8080/",
      token: "test-token",
      workspaceId: "ws-id",
      workspaceSlug: "acme",
      platform: "desktop",
      version: "0.1.0",
      os: "macos",
    });

    await client.listIssues();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/issues?limit=200",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "X-Workspace-ID": "ws-id",
          "X-Workspace-Slug": "acme",
          "X-Client-Platform": "desktop",
          "X-Client-Version": "0.1.0",
          "X-Client-OS": "macos",
        }),
      }),
    );
  });
});
