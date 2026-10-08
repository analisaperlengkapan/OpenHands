import { chromium } from "playwright";

const conv = process.argv[2];
const dir = process.argv[3] ?? "/tmp/oh-evidence";
const url = `http://127.0.0.1:12000/conversations/${conv}`;

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
await context.addInitScript(() => {
  localStorage.setItem("openhands-onboarded", "1");
  localStorage.setItem("analytics-consent", "false");
});
const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);

const skip = page.locator('[data-testid="onboarding-skip"]');
if (await skip.count()) {
  await skip.first().click();
  await page.waitForTimeout(1500);
}

await page.locator('[data-testid="right-panel-toggle"]').click();
await page.waitForTimeout(3000);

const fileNode = page.locator('[data-testid="file-tree-file-report.html"]');
await fileNode.waitFor({ state: "attached", timeout: 30000 });
await fileNode.evaluate((el) => el.scrollIntoView({ block: "center" }));
await fileNode.dispatchEvent("click");
await page.waitForTimeout(9000);

async function shoot(tag) {
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="files-tab"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  console.log(tag, "box", JSON.stringify(box));
  await page.screenshot({ path: `${dir}/oversized-html-${tag}-panel.png`, clip: box });
}

await shoot("rich");

await page
  .locator('[data-testid="files-tab-content-mode-toggle-option-plain"]')
  .dispatchEvent("click");
await page.waitForTimeout(6000);
await shoot("plain");

await page
  .locator('[data-testid="files-tab-content-mode-toggle-option-rich"]')
  .dispatchEvent("click");
await page.waitForTimeout(8000);
await shoot("rich-after-plain");

await context.close();
await browser.close();
