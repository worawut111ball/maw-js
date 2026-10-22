import { expect, test as base, type Page } from "@playwright/test";

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3456";

export const test = base.extend<{ serverReady: boolean }>({
  serverReady: [async ({}, use) => {
    let ready = false;
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(3_000) });
      ready = res.ok;
    } catch {
      ready = false;
    }
    if (!ready) console.warn(`[e2e] ${BASE_URL} is not responding; skipping mobile E2E assertions.`);
    await use(ready);
  }, { scope: "worker" }],
});

export { expect };

export function isPhoneProject(projectName: string) {
  return !["desktop", "ipad-mini"].includes(projectName);
}

export async function skipIfNoServer(serverReady: boolean) {
  test.skip(!serverReady, `${BASE_URL} is not responding`);
}

export async function mockMawApis(page: Page) {
  await page.route("**/api/feed?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        events: [
          {
            timestamp: "2026-05-16 12:00:00",
            oracle: "neo-oracle",
            host: "local",
            event: "MessageSend",
            project: "maw-ui",
            sessionId: "test",
            message: "mawjs: Here is a file https://example.test/report.txt and code ```ts\nexport const answer = 42;\n```",
            ts: Date.now(),
          },
        ],
      }),
    });
  });

  await page.route("**/api/costs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: { tokens: 0, cost: 0, sessions: 0, agents: 0 } }) });
  });

  await page.route("**/api/teams", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ teams: [] }) });
  });

  await page.route("https://example.test/report.txt", async (route) => {
    await route.fulfill({
      contentType: "text/plain",
      headers: { "content-disposition": "attachment; filename=report.txt" },
      body: "mobile e2e download",
    });
  });
}

export async function mockWebSocket(page: Page) {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readyState = 0;
      url: string;
      protocol = "";
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      extensions = "";
      onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
      onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
      onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        (window as any).__wsMessages = (window as any).__wsMessages || [];
        setTimeout(() => {
          this.readyState = 1;
          const open = new Event("open");
          this.onopen?.call(this as any, open);
          this.dispatchEvent(open);
          const payload = JSON.stringify({
            type: "sessions",
            sessions: [{ name: "01-mobile", windows: [{ index: 0, name: "mawjs", active: true }] }],
          });
          const msg = new MessageEvent("message", { data: payload });
          this.onmessage?.call(this as any, msg);
          this.dispatchEvent(msg);
        }, 20);
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        (window as any).__wsMessages.push(typeof data === "string" ? data : Array.from(new Uint8Array(data as ArrayBuffer)));
      }

      close() {
        this.readyState = 3;
        const ev = new CloseEvent("close");
        this.onclose?.call(this as any, ev);
        this.dispatchEvent(ev);
      }
    }
    (MockWebSocket as any).prototype = OriginalWebSocket.prototype;
    (window as any).WebSocket = MockWebSocket;
  });
}

export async function installVisualViewportMock(page: Page) {
  await page.addInitScript(() => {
    const listeners: Record<string, Set<EventListenerOrEventListenerObject>> = { resize: new Set(), scroll: new Set() };
    const vv = {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => listeners[type]?.add(cb),
      removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) => listeners[type]?.delete(cb),
      dispatchEvent: (ev: Event) => {
        listeners[ev.type]?.forEach((cb) => typeof cb === "function" ? cb(ev) : cb.handleEvent(ev));
        return true;
      },
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    (window as any).__setVisualViewport = (height: number, offsetTop = 0) => {
      vv.height = height;
      vv.offsetTop = offsetTop;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    };
  });
}
