import { expect, installVisualViewportMock, isPhoneProject, mockMawApis, mockWebSocket, skipIfNoServer, test } from "./fixtures";

test.describe("mobile viewport and quick commands", () => {
  test("Task 1: viewport meta, safe area, no horizontal scroll", async ({ page, serverReady }, testInfo) => {
    await skipIfNoServer(serverReady);
    await mockMawApis(page);
    await mockWebSocket(page);
    await page.goto("/chat.html");

    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).toContain("maximum-scale=1");

    const safeAndScroll = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return {
        paddingTop: parseFloat(body.paddingTop) || 0,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    expect(safeAndScroll.paddingTop).toBeGreaterThanOrEqual(0);
    expect(safeAndScroll.scrollWidth).toBeLessThanOrEqual(safeAndScroll.innerWidth + 1);

    if (testInfo.project.name === "iphone-xr") {
      await expect.soft(page).toHaveScreenshot("chat-portrait.png");
    }
  });

  test("Task 2: sticky QuickCommandBar sends core command", async ({ page, serverReady }, testInfo) => {
    await skipIfNoServer(serverReady);
    test.skip(!isPhoneProject(testInfo.project.name), "QuickCommandBar is a phone viewport affordance");
    await mockMawApis(page);
    await mockWebSocket(page);
    await page.goto("/terminal.html");

    await page.getByText("mawjs").click();
    const bar = page.getByTestId("quick-command-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveCSS("position", "fixed");

    for (const id of ["qc-y", "qc-n", "qc-esc", "qc-enter", "qc-ctrl-c"]) {
      const button = page.getByTestId(id);
      await expect(button).toBeVisible();
      await expect.poll(() => button.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36);
    }
    await expect(page.getByRole("button", { name: "↑" })).toBeVisible();
    await expect(page.getByRole("button", { name: "↓" })).toBeVisible();

    await page.getByTestId("qc-y").click();
    await expect.poll(async () => page.evaluate(() => (window as any).__wsMessages || [])).toContainEqual(
      expect.stringContaining('"text":"y\\r"'),
    );

    if (testInfo.project.name === "iphone-xr") {
      await expect.soft(page).toHaveScreenshot("terminal-portrait.png");
    }
  });

  test("Task 5: visualViewport inset moves quick command bar", async ({ page, serverReady }, testInfo) => {
    await skipIfNoServer(serverReady);
    test.skip(!isPhoneProject(testInfo.project.name), "visualViewport inset is asserted on phone viewport controls");
    await installVisualViewportMock(page);
    await mockMawApis(page);
    await mockWebSocket(page);
    await page.goto("/chat.html");

    const bar = page.getByTestId("quick-command-bar");
    await expect(bar).toBeVisible();
    await page.evaluate(() => (window as any).__setVisualViewport(window.innerHeight - 220, 0));
    await expect.poll(() => bar.getAttribute("data-inset")).toBe("220");
  });
});
