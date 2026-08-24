import { currentBrowserCsrfToken, ensureSessionCsrfToken } from "../csrf.client";

const TOKEN = "C".repeat(43);
const fetchMock = jest.fn();

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(body) };
}

function clearCsrfCookies(): void {
  document.cookie = "proofcanvas-csrf=; Max-Age=0; Path=/";
  document.cookie = "__Host-proofcanvas-csrf=; Max-Age=0; Path=/; Secure";
}

beforeEach(() => {
  clearCsrfCookies();
  fetchMock.mockReset();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
});

afterEach(() => {
  clearCsrfCookies();
});

test("uses the current readable session CSRF cookie without a recovery request", async () => {
  document.cookie = `proofcanvas-csrf=${TOKEN}; Path=/`;
  expect(currentBrowserCsrfToken()).toBe(TOKEN);
  await expect(ensureSessionCsrfToken()).resolves.toBe(TOKEN);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("singleflights concurrent missing-cookie recovery", async () => {
  let resolveResponse!: (response: ReturnType<typeof jsonResponse>) => void;
  fetchMock.mockReturnValue(new Promise((resolvePromise) => { resolveResponse = resolvePromise; }));
  const first = ensureSessionCsrfToken(null);
  const second = ensureSessionCsrfToken(null);
  expect(second).toBe(first);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  resolveResponse(jsonResponse(200, { ok: true, csrfToken: TOKEN }));
  await expect(Promise.all([first, second])).resolves.toEqual([TOKEN, TOKEN]);
});

test("clears a rejected singleflight so a later recovery can retry", async () => {
  fetchMock
    .mockRejectedValueOnce(new Error("network unavailable"))
    .mockResolvedValueOnce(jsonResponse(200, { ok: true, csrfToken: TOKEN }));
  await expect(ensureSessionCsrfToken(null)).rejects.toThrow("network unavailable");
  await expect(ensureSessionCsrfToken(null)).resolves.toBe(TOKEN);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("does not trust a valid-shaped cookie when the authenticated server context rejected it", async () => {
  const stale = "S".repeat(43);
  document.cookie = `proofcanvas-csrf=${stale}; Path=/`;
  fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, csrfToken: TOKEN }));
  await expect(ensureSessionCsrfToken(null)).resolves.toBe(TOKEN);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
