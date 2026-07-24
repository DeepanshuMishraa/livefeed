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
  it("refreshes a public desktop client without a client secret", async () => {
    vi.stubEnv("LIVEFEED_GOOGLE_CLIENT_ID", "desktop-client-id");
    vi.stubEnv("LIVEFEED_GOOGLE_CLIENT_SECRET", "must-not-be-used");
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
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(body.has("client_secret")).toBe(false);
  });
});
