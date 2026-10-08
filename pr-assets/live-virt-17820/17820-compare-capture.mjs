/**
 * Apples-to-apples before/after benchmark against a real agent-server.
 *
 * Drives one conversation to fully backfilled history (scroll to top until the
 * loader stops returning pages) and reports DOM nodes, mounted rows and the
 * longest main-thread long-task observed during the backfill. Run against the
 * base build and the head build with the same conversation and backend.
 */
const { chromium } = require("playwright");
const fs = require("fs");

const BASE = process.env.OH_BASE_URL;
const CID = process.env.CID;
const KEY = fs.readFileSync(process.env.SESSION_KEY_FILE, "utf8").trim();
const TAG = process.env.TAG || "run";
const OUTDIR = process.env.OUTDIR || "/workspace/project/OpenHands/.tmp/evidence";
const OUT = `${OUTDIR}/${TAG}-compare.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: BASE });
  await ctx.addInitScript((key) => {
    localStorage.setItem("openhands-onboarded", "1");
    localStorage.setItem("agent-canvas-consent", "0");
    localStorage.setItem(
      "openhands-backends",
      JSON.stringify([{ id: "default-local", name: "Local", host: location.origin, apiKey: key, kind: "local" }]),
    );
    localStorage.setItem("openhands-agent-server-config", JSON.stringify({ sessionApiKey: key }));
  }, KEY);
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__longtasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longtasks.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
  });

  const t0 = Date.now();
  await page.goto(`/conversations/${CID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);
  const initialSettleMs = Date.now() - t0;

  const snap = () =>
    page.evaluate(() => {
      const sc = document.querySelector('[data-testid="chat-scroll-container"]');
      return {
        shell: !!document.querySelector('[data-testid="virtualized-message-list"]'),
        rows: document.querySelectorAll('[data-testid="virtualized-message-row"]').length,
        messages: document.querySelectorAll('[data-testid="user-message"], [data-testid="agent-message"]').length,
        domNodes: document.querySelectorAll("*").length,
        scrollHeight: sc ? sc.scrollHeight : null,
        longestTaskMs: Math.max(0, ...(window.__longtasks || [])),
      };
    });

  const before = await snap();
  const fixedIters = Number(process.env.MAX_ITERS || 0);
  const timeline = [];
  let prev = before.messages;
  let stalled = 0;
  let backfillMs = 0;
  const maxIters = fixedIters || 30;
  for (let i = 0; i < maxIters && (fixedIters > 0 || stalled < 2); i++) {
    const start = Date.now();
    await page.evaluate(() => {
      const sc = document.querySelector('[data-testid="chat-scroll-container"]');
      if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event("scroll", { bubbles: true })); }
    });
    await sleep(2200);
    const s = await snap();
    backfillMs += Date.now() - start;
    stalled = s.messages > prev ? 0 : stalled + 1;
    prev = s.messages;
    timeline.push({ iter: i + 1, messages: s.messages, domNodes: s.domNodes, rows: s.rows, shell: s.shell, longestTaskMs: s.longestTaskMs });
  }
  const after = await snap();
  await page.screenshot({ path: `${OUTDIR}/${TAG}-compare.png` });

  const result = { tag: TAG, url: page.url(), initialSettleMs, backfillMs, before, after, timeline };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await ctx.close();
  await browser.close();
})().catch((e) => { console.error("ERR", e.stack); process.exit(1); });
