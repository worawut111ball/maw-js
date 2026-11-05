import { expect, test } from "@playwright/test";

// The desktop office (/) sends phones to maw mobile (/m.html); tablets and desktops stay.
const PHONES = ["iphone-xr", "iphone-14-pro", "iphone-se", "pixel-7", "webkit-iphone-xr"];

test.describe("phone redirect from the desktop office", () => {
  test("phone → /m.html · others stay on /", async ({ page }, testInfo) => {
    await page.route("**/m.html", route => route.fulfill({ status: 200, contentType: "text/html", body: "<title>maw mobile</title>" }));
    await page.goto("/");
    if (PHONES.includes(testInfo.project.name)) await expect(page).toHaveURL(/\/m\.html$/);
    else await expect(page).not.toHaveURL(/\/m\.html$/);
  });

  test("?desktop=1 keeps the desktop view on a phone", async ({ page }, testInfo) => {
    test.skip(!PHONES.includes(testInfo.project.name), "phones only");
    await page.goto("/?desktop=1");
    await expect(page).not.toHaveURL(/\/m\.html$/);
    await page.goto("/#office");
    await expect(page).not.toHaveURL(/\/m\.html$/);
  });
});

test("📱 มือถือ button in the desktop header goes back to /m.html", async ({ page }, testInfo) => {
  test.skip(!PHONES.includes(testInfo.project.name), "the header with the button is the phone header");
  await page.route("**/m.html", route => route.fulfill({ status: 200, contentType: "text/html", body: "<title>maw mobile</title>" }));
  await page.goto("/?desktop=1#office");
  await page.getByRole("button", { name: "maw mobile" }).click();
  await expect(page).toHaveURL(/\/m\.html$/);
});

test("📱 มือถือ button on a computer / iPad header goes to /m.html", async ({ page }, testInfo) => {
  test.skip(PHONES.includes(testInfo.project.name), "phones have their own header (above)");
  await page.route("**/m.html", route => route.fulfill({ status: 200, contentType: "text/html", body: "<title>maw mobile</title>" }));
  await page.goto("/#office");
  const btn = page.getByRole("button", { name: "maw mobile" });
  await expect(btn).toHaveCount(1);
  await btn.click();
  await expect(page).toHaveURL(/\/m\.html$/);
});
