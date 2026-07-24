import { afterEach, describe, expect, it, vi } from "vitest";
import { accessToken } from "../src/auth";

vi.mock("bun", () => ({
  secrets: {
    delete: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("accessToken", () => {
  it("refreshes a Google Desktop client with its generated secret", async () => {
    vi.stubEnv("LIVEFEED_GOOGLE_CLIENT_ID", "desktop-client-id");
    vi.stubEnv("LIVEFEED_GOOGLE_CLIENT_SECRET", "desktop-client-secret");
    let request: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        request = init;
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 })),
        );
      }),
    );

    const result = await accessToken({
      refreshToken: "refresh-token",
      channelTitle: "Channel",
    });
    const body = request?.body;

    expect(result).toMatchObject({ value: "access-token" });
    if (!(body instanceof URLSearchParams)) throw new Error("Expected an OAuth form body.");
    expect(body.get("client_id")).toBe("desktop-client-id");
    expect(body.get("client_secret")).toBe("desktop-client-secret");
    expect(body.get("refresh_token")).toBe("refresh-token");
  });

  it("rejects an incomplete Desktop OAuth configuration before making a request", async () => {
    vi.stubEnv("LIVEFEED_GOOGLE_CLIENT_ID", "desktop-client-id");
    vi.stubEnv("LIVEFEED_GOOGLE_CLIENT_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await accessToken({
      refreshToken: "refresh-token",
      channelTitle: "Channel",
    });

    expect(result).toMatchObject({ error: { _tag: "OAuthNotConfigured" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
