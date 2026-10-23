import { expect, skipIfNoServer, test } from "./fixtures";

test.describe("PWA metadata", () => {
  test("Task 6: manifest and mobile app meta tags are present", async ({ page, request, serverReady }) => {
    await skipIfNoServer(serverReady);
    const res = await request.get("/manifest.json");
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    // one manifest for the whole origin: the phone app's (ui/mobile/pwa) — deploy.sh
    // copies it over ui/web/public/manifest.json, and installed phones depend on its id
    expect(manifest.name).toBe("maw — agents");
    expect(manifest.id).toBe("/m.html");
    expect(manifest.short_name).toBe("maw");
    expect(manifest.display).toBe("standalone");

    await page.goto("/chat.html");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.json");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#020208");
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  });
});
