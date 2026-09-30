/**
 * Captures the inline HTML/SVG artifact preview (#17818) in the running
 * mock-API app: opens the `canvas-demo` conversation, waits for the sandboxed
 * frame to mount, screenshots the collapsed and expanded states, and probes
 * the frame to prove the sandbox posture (scripts inert, relative asset
 * resolved).
 */
import { chromium } from "@playwright/test";

const CONVERSATION_ID = "canvas-demo";
const OUT_DIR = process.env.OUT_DIR ?? ".pr";

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const problems = [];
const httpErrors = [];
page.on("pageerror", (e) => problems.push("PAGEERROR " + String(e)));
page.on("console", (m) => {
  if (m.type() === "error") problems.push("CONSOLE " + m.text());
});
page.on("response", (r) => {
  if (r.status() >= 400) {
    httpErrors.push(`HTTP${r.status()} ${r.url()}`);
    problems.push("HTTP" + r.status() + " " + r.url());
  }
});

await page.addInitScript(() => {
  window.localStorage.setItem("analytics-consent", "false");
  window.localStorage.setItem("openhands-telemetry-consent", "denied");
  window.localStorage.setItem("openhands-telemetry-first-use", "true");
  window.localStorage.setItem("openhands-onboarded", "1");
  window.localStorage.setItem(
    "openhands-backends",
    JSON.stringify([
      {
        id: "default-local",
        name: "Local",
        host: window.location.origin,
        apiKey: "",
        kind: "local",
      },
    ]),
  );
  window.localStorage.setItem(
    "openhands-active-backend",
    JSON.stringify({ backendId: "default-local", orgId: null }),
  );
});

// The app's mock API is an MSW service worker, which intercepts `fetch` but not
// an iframe's document navigation — so a preview frame would 502 in mock mode.
// Install driver-level routes *before* the first navigation, and resolve the
// fixture bytes lazily from the app's own mock (an in-page `fetch`, which MSW
// does intercept). Same bytes, real component, real sandbox attribute, and the
// frame never sees an error response.
let fixturePromise = null;
const fixtureBytes = () =>
  (fixturePromise ??= page.evaluate(async () => {
    const base = "/api/conversations/canvas-demo/workspace";
    const [html, css, svg] = await Promise.all([
      fetch(`${base}/report.html`).then((r) => r.text()),
      fetch(`${base}/report.css`).then((r) => r.text()),
      fetch(`${base}/chart.svg`).then((r) => r.text()),
    ]);
    return { html, css, svg };
  }));

await page.route("**/report.html*", async (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: (await fixtureBytes()).html,
  }),
);
await page.route("**/report.css*", async (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/css; charset=utf-8",
    body: (await fixtureBytes()).css,
  }),
);
await page.route("**/chart.svg*", async (route) =>
  route.fulfill({
    status: 200,
    contentType: "image/svg+xml; charset=utf-8",
    body: (await fixtureBytes()).svg,
  }),
);

await page.goto(`http://127.0.0.1:3001/conversations/${CONVERSATION_ID}`, {
  waitUntil: "domcontentloaded",
});
await page
  .getByTestId("chat-input")
  .waitFor({ state: "visible", timeout: 60_000 });

try {
  const consentForm = page.getByTestId("telemetry-consent-form");
  await consentForm.waitFor({ state: "visible", timeout: 5_000 });
  await consentForm
    .getByRole("button", { name: "Confirm preferences" })
    .click();
  await consentForm.waitFor({ state: "hidden", timeout: 5_000 });
} catch {
  // Prompt absent.
}

const preview = page.getByTestId("artifact-preview");
await preview.first().waitFor({ state: "visible", timeout: 30_000 });

const frame = page.getByTestId("artifact-preview-frame");
await frame.first().waitFor({ state: "visible", timeout: 30_000 });
await page.waitForTimeout(2_000);

const cardCount = await preview.count();
const frameCount = await frame.count();
const sandbox = await frame.first().getAttribute("sandbox");
const frameSrc = await frame.first().getAttribute("src");

// Every frame in the card list: the HTML artifact and the SVG artifact.
const frames = [];
for (let i = 0; i < frameCount; i += 1) {
  const handle = await frame.nth(i).elementHandle();
  const child = await handle.contentFrame();
  frames.push({
    src: await frame.nth(i).getAttribute("src"),
    sandbox: await frame.nth(i).getAttribute("sandbox"),
    rootTag: await child.evaluate(
      () => document.documentElement.tagName.toLowerCase(),
    ),
    heading: await child
      .locator("h1")
      .innerText()
      .then((t) => t.trim())
      .catch(() => null),
    firstRectFill: await child
      .evaluate(() => {
        const rect = document.querySelector("rect");
        return rect ? getComputedStyle(rect).fill : null;
      })
      .catch(() => null),
    headingColor: await child
      .evaluate(() => {
        const h1 = document.querySelector("h1");
        return h1 ? getComputedStyle(h1).color : null;
      })
      .catch(() => null),
  });
}

// `report.css` colours the HTML heading; a resolved colour proves the relative
// `./report.css` reference was fetched from the same workspace base. The HTML's
// own script rewrites the heading to "SCRIPT RAN" — if it still reads the
// original text, the sandbox is doing its job.
const htmlFrame = frames.find((f) => f.src?.includes("report.html"));
const svgFrame = frames.find((f) => f.src?.includes("chart.svg"));
const frameHeading = htmlFrame?.heading ?? "(missing)";
const frameStyleResolved = htmlFrame?.headingColor ?? "(missing)";

await page.screenshot({ path: `${OUT_DIR}/17818-collapsed.png` });

// Element-level shots so both artifact cards are visible regardless of scroll.
await preview.nth(0).screenshot({ path: `${OUT_DIR}/17818-card-html.png` });
await preview.nth(1).screenshot({ path: `${OUT_DIR}/17818-card-svg.png` });

const collapsedBox = await page
  .getByTestId("artifact-preview-frame-container")
  .first()
  .boundingBox();

// Toggle through the DOM: the app's own click handlers are what we want, and a
// synthetic dispatch avoids any overlay intercepting a coordinate click.
const expandedState = await page.evaluate(() => {
  const button = document.querySelector(
    '[data-testid="artifact-preview-expand"]',
  );
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return button.getAttribute("aria-expanded");
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT_DIR}/17818-expanded.png` });
const expandedBox = await page
  .getByTestId("artifact-preview-frame-container")
  .first()
  .boundingBox();

console.log(
  JSON.stringify(
    {
      cardCount,
      frameCount,
      sandbox,
      frameSrc,
      frameHeading,
      frameStyleResolved,
      svgFrame,
      htmlFrame,
      collapsedFrameHeight: collapsedBox?.height ?? null,
      expandedFrameHeight: expandedBox?.height ?? null,
      ariaExpandedAfterToggle: expandedState,
      problems,
      httpErrors,
    },
    null,
    2,
  ),
);

await browser.close();
