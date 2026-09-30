/**
 * Captures the extended artifact-format previews on the `canvas-demo`
 * conversation: the PNG `<img>`, the PDF viewer frame, and the Word / Excel /
 * PowerPoint outline cards. Probes each one's rendered state and screenshots
 * it, so the PR evidence is measured rather than asserted.
 *
 * The app's mock API is an MSW service worker, which intercepts `fetch` but not
 * an iframe's *document navigation* — so the PDF frame would 502 in mock mode.
 * Install driver-level routes before the first navigation and resolve the
 * fixture bytes from the app's own mock (an in-page `fetch`, which MSW does
 * intercept). Same bytes, real component, real element.
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

let fixturePromise = null;
const fixtureBytes = () =>
  (fixturePromise ??= page.evaluate(async () => {
    const base = "/api/conversations/canvas-demo/workspace";
    const [pdf, docx, xlsx, pptx, png, html, css, svg] = await Promise.all([
      fetch(`${base}/docs/spec.pdf`).then((r) => r.arrayBuffer()),
      fetch(`${base}/docs/plan.docx`).then((r) => r.arrayBuffer()),
      fetch(`${base}/docs/budget.xlsx`).then((r) => r.arrayBuffer()),
      fetch(`${base}/docs/deck.pptx`).then((r) => r.arrayBuffer()),
      fetch(`${base}/assets/preview.png`).then((r) => r.arrayBuffer()),
      fetch(`${base}/report.html`).then((r) => r.text()),
      fetch(`${base}/report.css`).then((r) => r.text()),
      fetch(`${base}/chart.svg`).then((r) => r.text()),
    ]);
    const toB64 = (buf) => {
      let out = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 1)
        out += String.fromCharCode(bytes[i]);
      return btoa(out);
    };
    return {
      pdf: toB64(pdf),
      docx: toB64(docx),
      xlsx: toB64(xlsx),
      pptx: toB64(pptx),
      png: toB64(png),
      html,
      css,
      svg,
    };
  }));

const MIME = {
  "docs/spec.pdf": "application/pdf",
  "docs/plan.docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "docs/budget.xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "docs/deck.pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "assets/preview.png": "image/png",
};
const KEY = {
  "docs/spec.pdf": "pdf",
  "docs/plan.docx": "docx",
  "docs/budget.xlsx": "xlsx",
  "docs/deck.pptx": "pptx",
  "assets/preview.png": "png",
};

for (const [path, mime] of Object.entries(MIME)) {
  await page.route(`**/${path}*`, async (route) => {
    const b64 = (await fixtureBytes())[KEY[path]];
    route.fulfill({
      status: 200,
      contentType: mime,
      body: Buffer.from(b64, "base64"),
    });
  });
}

// The HTML/SVG frames are *document navigations*, which the MSW service worker
// does not intercept, so route their bytes too — otherwise the console fills
// with expected 502s that mask a real error.
for (const [path, key, mime] of [
  ["report.html", "html", "text/html; charset=utf-8"],
  ["report.css", "css", "text/css; charset=utf-8"],
  ["chart.svg", "svg", "image/svg+xml; charset=utf-8"],
]) {
  await page.route(`**/${path}*`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: mime,
      body: (await fixtureBytes())[key],
    }),
  );
}

await page.goto(`http://127.0.0.1:3001/conversations/${CONVERSATION_ID}`, {
  waitUntil: "domcontentloaded",
});
await page
  .getByTestId("chat-input")
  .waitFor({ state: "visible", timeout: 60_000 });

try {
  const consentForm = page.getByTestId("telemetry-consent-form");
  await consentForm.waitFor({ state: "visible", timeout: 5_000 });
  await consentForm.getByRole("button", { name: "Confirm preferences" }).click();
  await consentForm.waitFor({ state: "hidden", timeout: 5_000 });
} catch {
  // Prompt absent.
}

// Wait for the message list itself; each preview mounts on intersection, so the
// per-card loop below scrolls them in one at a time.
await page
  .getByTestId("artifact-preview")
  .first()
  .waitFor({ state: "visible", timeout: 30_000 });
await page.waitForTimeout(2_000);

const officeCards = page.getByTestId("office-artifact-preview");
const cards = page.locator(
  '[data-testid="artifact-preview"], [data-testid="office-artifact-preview"]',
);
const cardCount = await cards.count();

// Each card mounts its preview only once it intersects the viewport, so walk
// the list, scroll each one in, and give the observer + fetch time to settle
// before probing or screenshotting it.
const FORMATS = [
  { name: "report.html", shot: "17822-card-html.png" },
  { name: "chart.svg", shot: "17822-card-svg.png" },
  { name: "preview.png", shot: "17822-card-png.png" },
  { name: "spec.pdf", shot: "17822-card-pdf.png" },
  { name: "plan.docx", shot: "17822-card-docx.png" },
  { name: "budget.xlsx", shot: "17822-card-xlsx.png" },
  { name: "deck.pptx", shot: "17822-card-pptx.png" },
];
let imageState = null;
let pdfState = null;
const officeOutlines = [];
const cardReport = [];

for (let i = 0; i < cardCount; i += 1) {
  const card = cards.nth(i);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_200);

  const text = await card.innerText();
  const format = FORMATS.find((f) => text.includes(f.name));
  if (!format) continue;

  // What a text-only model would receive if this card's content were handed to
  // it: the DOM text plus the accessible name of the media element. A vision
  // model additionally gets the pixels (screenshot), so both paths are covered.
  const accessible = await card.evaluate((el) => {
    const img = el.querySelector('[data-testid="artifact-preview-image"]');
    const frame = el.querySelector("iframe");
    return {
      mediaElement: img ? "img" : frame ? "iframe" : "text",
      alt: img?.getAttribute("alt") ?? null,
      title: frame?.getAttribute("title") ?? null,
      imgComplete: img ? img.complete && img.naturalWidth > 0 : null,
      frameSandbox: frame?.getAttribute("sandbox") ?? null,
    };
  });

  cardReport.push({
    file: format.name,
    ...accessible,
    textChars: text.trim().length,
    text: text.trim().slice(0, 400),
  });

  if (format.name.endsWith(".png")) {
    const img = card.getByTestId("artifact-preview-image");
    await img.waitFor({ state: "visible", timeout: 15_000 });
    imageState = await img.evaluate((el) => ({
      tag: el.tagName,
      complete: el.complete,
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
      src: el.getAttribute("src"),
    }));
  }
  if (format.name.endsWith(".pdf")) {
    const frame = card.getByTestId("artifact-preview-pdf-frame");
    await frame.waitFor({ state: "visible", timeout: 15_000 });
    pdfState = {
      src: await frame.getAttribute("src"),
      sandbox: await frame.getAttribute("sandbox"),
    };
  }
  if (/\.(docx|xlsx|pptx)$/.test(format.name)) {
    officeOutlines.push({ file: format.name, outline: text.trim() });
  }

  await card
    .screenshot({ path: `${OUT_DIR}/${format.shot}`, timeout: 15_000 })
    .catch(() => {});
}

const officeCount = await officeCards.count();

console.log(
  JSON.stringify(
    {
      cardCount,
      officeCount,
      officeOutlines,
      cardReport,
      imageState,
      pdfState,
      problems: problems.filter((p) => !p.includes("WebSocket")),
      httpErrors,
    },
    null,
    2,
  ),
);

await browser.close();
