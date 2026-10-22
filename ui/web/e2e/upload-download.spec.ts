import { expect, mockMawApis, mockWebSocket, skipIfNoServer, test } from "./fixtures";

test.describe("mobile upload and download affordances", () => {
  test("Task 3: ChatBubble exposes download and save actions", async ({ browserName, page, serverReady }) => {
    await skipIfNoServer(serverReady);
    await mockMawApis(page);
    await mockWebSocket(page);
    await page.goto("/chat.html");

    const download = page.getByTestId("msg-download").first();
    await expect(download).toBeVisible();
    await expect(download).toHaveAttribute("href", "https://example.test/report.txt");
    await expect(download).toHaveAttribute("download", "report.txt");
    if (browserName === "webkit") return;

    const downloadEvent = page.waitForEvent("download");
    await download.click();
    expect((await downloadEvent).suggestedFilename()).toBe("report.txt");

    await page.goto("/mobile-fixture.html");
    page.once("dialog", (dialog) => dialog.accept("snippet.ts"));
    const saveDownload = page.waitForEvent("download");
    await page.getByTestId("msg-save-file").first().click();
    expect((await saveDownload).suggestedFilename()).toBe("snippet.ts");
  });

  test("Task 4: camera, gallery, and file picker modes set input attributes", async ({ page, serverReady }) => {
    await skipIfNoServer(serverReady);
    await page.goto("/mobile-fixture.html");

    const cameraChooser = page.waitForEvent("filechooser");
    await page.getByTestId("attach-camera").click();
    await cameraChooser;
    await expect(page.getByTestId("file-input")).toHaveAttribute("capture", "environment");
    await expect(page.getByTestId("file-input")).toHaveAttribute("accept", "image/*");

    const galleryChooser = page.waitForEvent("filechooser");
    await page.getByTestId("attach-gallery").click();
    await galleryChooser;
    await expect(page.getByTestId("file-input")).not.toHaveAttribute("capture", "environment");
    await expect(page.getByTestId("file-input")).toHaveAttribute("accept", "image/*,video/*");

    const fileChooser = page.waitForEvent("filechooser");
    await page.getByTestId("attach-file").click();
    await fileChooser;
    await expect(page.getByTestId("file-input")).toHaveAttribute("accept", /application\/pdf/);
    await expect(page.getByTestId("file-input")).toHaveAttribute("accept", /\.tsx/);
  });
});
