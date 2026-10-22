import { expect, isPhoneProject, mockMawApis, mockWebSocket, skipIfNoServer, test } from "./fixtures";

test.describe("mobile bottom navigation and landscape", () => {
  test("Task 7: bottom nav is mobile-only", async ({ page, serverReady }, testInfo) => {
    await skipIfNoServer(serverReady);
    await mockMawApis(page);
    await mockWebSocket(page);
    await page.goto("/chat.html");

    const bottomNav = page.getByTestId("bottom-nav");
    const statusBar = page.getByTestId("status-bar");
    if (!isPhoneProject(testInfo.project.name)) {
      await expect(bottomNav).toBeHidden();
      await expect(statusBar).toBeVisible();
      return;
    }

    await expect(bottomNav).toBeVisible();
    await expect(statusBar).toBeHidden();
    for (const id of ["nav-chat", "nav-fleet", "nav-mission", "nav-inbox", "nav-config"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test("Task 8: phone landscape keeps quick commands above bottom nav", async ({ page, serverReady }, testInfo) => {
    await skipIfNoServer(serverReady);
    test.skip(!["iphone-xr", "webkit-iphone-xr"].includes(testInfo.project.name), "landscape geometry is asserted on iPhone XR only");
    await page.setViewportSize({ width: 896, height: 414 });
    await mockMawApis(page);
    await mockWebSocket(page);
    await page.goto("/terminal.html");
    await page.getByText("mawjs").click();

    const quickBar = page.getByTestId("quick-command-bar");
    const bottomNav = page.getByTestId("bottom-nav");
    await expect(quickBar).toBeVisible();
    await expect(bottomNav).toBeVisible();

    const [quickBox, navBox, scroll] = await Promise.all([
      quickBar.boundingBox(),
      bottomNav.boundingBox(),
      page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })),
    ]);
    expect(quickBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(quickBox!.y + quickBox!.height).toBeLessThanOrEqual(navBox!.y + 4);
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.innerWidth + 1);

    if (testInfo.project.name === "iphone-xr") {
      await expect.soft(page).toHaveScreenshot("terminal-landscape.png");
    }
  });
});
