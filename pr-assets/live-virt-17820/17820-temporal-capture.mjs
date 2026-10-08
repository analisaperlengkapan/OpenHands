/**
 * Temporal-behavior evidence against a real agent-server.
 *
 * Drives one long conversation through the PR acceptance criteria:
 *  1. scroll to top -> lazy older-page load; content stays stationary across prepend
 *  2. streamed tail message autoscrolls only while pinned to the bottom
 *  3. an expanded output card grows a row and the rows below re-measure
 *
 * Records a frame sequence (JPEG per ~250ms) that is stitched with ffmpeg, plus
 * a JSON measurements file. Run against head and base with the same backend.
 */
const { chromium } = require("playwright");
const fs = require("fs");

const BASE = process.env.OH_BASE_URL;
const CID = process.env.CID;
const KEY = fs.readFileSync(process.env.SESSION_KEY_FILE, "utf8").trim();
const TAG = process.env.TAG || "run";
const OUTDIR = process.env.OUTDIR || "/workspace/project/OpenHands/.tmp/evidence";
const FRAMEDIR = `${OUTDIR}/frames-${TAG}`;
fs.mkdirSync(FRAMEDIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postEvent(text) {
  const res = await fetch(`${BASE}/api/conversations/${CID}/events`, {
    method: "POST",
    headers: { "X-Session-API-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content: [{ type: "text", text }] }),
  });
  return res.status;
}

const snapshot = () => {
  const sc = document.querySelector('[data-testid="chat-scroll-container"]');
  return {
    shell: !!document.querySelector('[data-testid="virtualized-message-list"]'),
    rows: document.querySelectorAll('[data-testid="virtualized-message-row"]').length,
    groups: document.querySelectorAll('[data-testid="event-group"]').length,
    toggles: document.querySelectorAll('[data-testid="event-group-toggle"]').length,
    userBubbles: document.querySelectorAll('[data-testid="user-message"]').length,
    agentBubbles: document.querySelectorAll('[data-testid="agent-message"]').length,
    codeBlocks: document.querySelectorAll("pre").length,
    domNodes: document.querySelectorAll("*").length,
    scrollTop: sc ? Math.round(sc.scrollTop) : null,
    scrollHeight: sc ? sc.scrollHeight : null,
    clientHeight: sc ? sc.clientHeight : null,
    loadingOlder: !!document.querySelector('[data-testid="loading-older-events"]'),
  };
};

const firstVisibleAnchor = () => {
  const sc = document.querySelector('[data-testid="chat-scroll-container"]');
  if (!sc) return null;
  const top = sc.getBoundingClientRect().top;
  const bubbles = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
  for (const b of bubbles) {
    const r = b.getBoundingClientRect();
    if (r.bottom > top + 4) {
      return { text: (b.innerText || "").slice(0, 40), y: Math.round(r.top - top) };
    }
  }
  return null;
};

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
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

  // Frame recorder running for the whole session.
  let frame = 0;
  let recording = true;
  const frameTimer = setInterval(async () => {
    if (!recording) return;
    try {
      await page.screenshot({ path: `${FRAMEDIR}/f${String(frame++).padStart(5, "0")}.jpg`, type: "jpeg", quality: 70 });
    } catch {}
  }, 250);

  const ev = { posts: { status: [] } };

  await page.goto(`/conversations/${CID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);
  ev.loaded = await page.evaluate(snapshot);

  // ---- 1) scroll to top: lazy load + content stationary ----
  let sawSpinner = false;
  let anchorBefore = null;
  let anchorAfter = null;
  ev.headVirtualized = false;
  let prevLoaded = 0;
  let stalled = 0;
  for (let i = 0; i < 10; i++) {
    anchorBefore = await page.evaluate(firstVisibleAnchor);
    const beforeState = await page.evaluate(snapshot);
    await page.evaluate(() => {
      const sc = document.querySelector('[data-testid="chat-scroll-container"]');
      if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event("scroll", { bubbles: true })); }
    });
    for (let p = 0; p < 20; p++) {
      const st = await page.evaluate(snapshot);
      if (st.loadingOlder) sawSpinner = true;
      await sleep(150);
    }
    await sleep(600);
    const st = await page.evaluate(snapshot);
    anchorAfter = await page.evaluate(firstVisibleAnchor);
    if (st.shell) ev.headVirtualized = true;
    const loaded = st.userBubbles + st.agentBubbles;
    ev.scrollUp = { iterations: i + 1, sawSpinner, anchorBefore, anchorAfter, beforeState, state: st, loaded };
    // Stop once all older pages are consumed (loaded stops growing) and, on
    // head, once the list is virtualized.
    stalled = loaded > prevLoaded ? 0 : stalled + 1;
    prevLoaded = loaded;
    if (i >= 3 && stalled >= 2 && (st.shell || !ev.headVirtualized)) break;
  }
  ev.scrollUp.anchorStationary =
    ev.scrollUp.anchorBefore && ev.scrollUp.anchorAfter
      ? Math.abs(ev.scrollUp.anchorBefore.y - ev.scrollUp.anchorAfter.y) < 160
      : null;

  // ---- 2) autoscroll only while pinned to bottom ----
  await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="chat-scroll-container"]');
    if (sc) sc.scrollTop = sc.scrollHeight;
  });
  await sleep(1000);
  const pinnedBefore = await page.evaluate(snapshot);
  ev.posts.status.push(await postEvent("QA live tail while pinned " + Date.now()));
  await sleep(3500);
  const pinnedAfter = await page.evaluate(snapshot);
  ev.autoscrollPinned = {
    pinnedBefore, pinnedAfter,
    following: pinnedAfter.scrollTop >= pinnedAfter.scrollHeight - pinnedAfter.clientHeight - 40,
  };

  await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="chat-scroll-container"]');
    if (sc) { sc.scrollTop = Math.round(sc.scrollHeight * 0.35); sc.dispatchEvent(new Event("scroll", { bubbles: true })); }
  });
  await sleep(1500);
  const upBefore = await page.evaluate(snapshot);
  ev.posts.status.push(await postEvent("QA live tail while scrolled up " + Date.now()));
  await sleep(3500);
  const upAfter = await page.evaluate(snapshot);
  ev.autoscrollScrolledUp = {
    upBefore, upAfter,
    stayed: Math.abs(upAfter.scrollTop - upBefore.scrollTop) < 150,
  };

  // ---- 3) expand a card -> rows below re-measure ----
  await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="chat-scroll-container"]');
    if (sc) sc.scrollTop = 0;
  });
  await sleep(1500);
  const preExpand = await page.evaluate(snapshot);
  let toggle = page.getByTestId("event-group-toggle").first();
  if ((await toggle.count()) === 0) {
    // The action/observation group lives in the oldest loaded page; walk the
    // scroll position up until a toggle mounts.
    for (let i = 0; i < 6 && (await toggle.count()) === 0; i++) {
      await page.evaluate(() => {
        const sc = document.querySelector('[data-testid="chat-scroll-container"]');
        if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event("scroll", { bubbles: true })); }
      });
      await sleep(1500);
      toggle = page.getByTestId("event-group-toggle").first();
    }
  }
  if (await toggle.count()) {
    await toggle.scrollIntoViewIfNeeded();
    await sleep(800);
    const beforeExpand = await page.evaluate(snapshot);
    await page.screenshot({ path: `${OUTDIR}/${TAG}-before-expand.png` });
    await toggle.click();
    await sleep(2500);
    const postExpand = await page.evaluate(snapshot);
    await page.screenshot({ path: `${OUTDIR}/${TAG}-after-expand.png` });
    ev.expand = { beforeExpand, postExpand, grew: postExpand.scrollHeight >= beforeExpand.scrollHeight };
  } else {
    ev.expand = { toggles: preExpand.toggles, note: "no event-group toggle found" };
  }

  await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="chat-scroll-container"]');
    if (sc) sc.scrollTop = sc.scrollHeight;
  });
  await sleep(1500);

  recording = false;
  clearInterval(frameTimer);
  await sleep(400);
  await ctx.close();
  await browser.close();

  ev.frames = frame;
  fs.writeFileSync(`${OUTDIR}/${TAG}-evidence.json`, JSON.stringify(ev, null, 2));
  console.log(JSON.stringify(ev, null, 2));
})().catch((e) => { console.error("ERR", e.stack); process.exit(1); });
