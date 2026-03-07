import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dispatcherDispatch = vi.fn(async () => ({ status: 200, body: { ok: true } }));
  return {
    loadConfig: vi.fn(() => ({
      gateway: {
        auth: {
          token: "loopback-token",
        },
      },
    })),
    createBrowserControlContext: vi.fn(() => ({})),
    startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
    createBrowserRouteDispatcher: vi.fn(() => ({ dispatch: dispatcherDispatch })),
    dispatcherDispatch,
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: mocks.createBrowserControlContext,
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: mocks.createBrowserRouteDispatcher,
}));

import { fetchBrowserJson } from "./client-fetch.js";

function stubJsonFetchOk() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchBrowserJson loopback auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "loopback-token",
        },
      },
    });
    mocks.startBrowserControlServiceFromConfig.mockReset();
    mocks.startBrowserControlServiceFromConfig.mockResolvedValue({ ok: true });
    mocks.dispatcherDispatch.mockReset();
    mocks.dispatcherDispatch.mockResolvedValue({ status: 200, body: { ok: true } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds bearer auth for loopback absolute HTTP URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    const res = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/");
    expect(res.ok).toBe(true);

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("does not inject auth for non-loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://example.com/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps caller-supplied auth header", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://localhost:18888/", {
      headers: {
        Authorization: "Bearer caller-token",
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer caller-token");
  });

  it("injects auth for IPv6 loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("injects auth for IPv4-mapped IPv6 loopback URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::ffff:127.0.0.1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("preserves dispatcher timeout context and appends no-retry guidance", async () => {
    mocks.dispatcherDispatch.mockRejectedValueOnce(new Error("timed out while running /snapshot"));

    const rejection = fetchBrowserJson("/snapshot", { timeoutMs: 25 });
    await expect(rejection).rejects.toMatchObject({
      message: expect.stringContaining("timed out while running /snapshot"),
    });
    await expect(rejection).rejects.toMatchObject({
      message: expect.stringContaining("Do NOT retry the browser tool — it will keep failing."),
    });
  });

  it("does not duplicate no-retry guidance when dispatcher already includes it", async () => {
    const hint =
      "Do NOT retry the browser tool — it will keep failing. " +
      "Use an alternative approach or inform the user that the browser is currently unavailable.";
    mocks.dispatcherDispatch.mockRejectedValueOnce(new Error(`timed out. ${hint}`));

    try {
      await fetchBrowserJson("/snapshot", { timeoutMs: 25 });
      throw new Error("expected fetchBrowserJson to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain("timed out.");
      const occurrences = message.split(hint).length - 1;
      expect(occurrences).toBe(1);
    }
  });
});
