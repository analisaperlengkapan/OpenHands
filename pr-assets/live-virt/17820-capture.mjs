import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const SESSION_KEY = fs.readFileSync("/tmp/live-session-key", "utf8").trim();
const CONV_ID = fs.readFileSync("/tmp/oh-live/conv_id.txt", "utf8").trim();
const ORIGIN = "http://127.0.0.1:12000";
const OUT = "/tmp/oh-live/evidence";
fs.mkdirSync(OUT, { recursive: true });

const MODE = process.argv[2] ?? "after"; // "after" (virtualized) | "before" (plain list)
const url = `${ORIGIN}/conversations/${CONV_ID}${MODE === "before" ? "?virtualize=0" : ""}`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: {
    dir: path.join(OUT, `video-${MODE}`),
    size: { width: 1440, height: 900 },
  },
});
const page = await context.newPage();

await page.addInitScript(
  ({ apiKey }) => {
    localStorage.setItem("analytics-consent", "false");
    localStorage.setItem("openhands-telemetry-consent", "denied");
    localStorage.setItem("openhands-telemetry-first-use", "true");
    localStorage.setItem("openhands-onboarded", "1");
    localStorage.setItem(
      "openhands-backends",
      JSON.stringify([
        {
          id: "default-local",
          name: "Local",
          host: location.origin,
          apiKey,
          kind: "local",
        },
      ]),
    );
  },
  { apiKey: SESSION_KEY },
);

const stats = () => ({
  domNodes: document.querySelectorAll("*").length,
  mountedRows: document.querySelectorAll('[data-testid="virtualized-message-row"]')
    .length,
  agentBubbles: document.querySelectorAll('[data-testid="agent-message"]').length,
  userBubbles: document.querySelectorAll('[data-testid="user-message"]').length,
  shell: !!document.querySelector('[data-testid="virtualized-message-list"]'),
  scrollHeight:
    document.querySelector(
      '[data-testid="chat-interface"] .custom-scrollbar-always',
    )?.scrollHeight ?? 0,
});

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="chat-interface"]', { timeout: 30_000 });
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="user-message"]').length >= 10,
  { timeout: 30_000 },
);
await page.waitForTimeout(1500);

const samples = [];
const take = async (label) => {
  const s = await page.evaluate(stats);
  samples.push({ label, ...s });
  console.log(label, JSON.stringify(s));
};
await take("initial");

// Scroll up repeatedly: each pass loads one real older page from the agent-server.
const SCROLLS = 12;
for (let i = 1; i <= SCROLLS; i += 1) {
  const before = await page.evaluate(
    () => document.querySelectorAll('[data-testid="user-message"]').length,
  );
  await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="chat-interface"] .custom-scrollbar-always',
    );
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  // Wait for the older page to arrive (bubble count grows or shell appears).
  await page
    .waitForFunction(
      (n) =>
        document.querySelectorAll('[data-testid="user-message"]').length > n ||
        !!document.querySelector('[data-testid="virtualized-message-list"]'),
      before,
      { timeout: 15_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(900);
  await take(`scroll-${i}`);
}

await page.screenshot({
  path: path.join(OUT, `${MODE}-final.png`),
  clip: { x: 0, y: 0, width: 1440, height: 900 },
});
fs.writeFileSync(
  path.join(OUT, `${MODE}-samples.json`),
  JSON.stringify({ url, mode: MODE, samples }, null, 2),
);

await context.close();
await browser.close();
console.log("video dir:", path.join(OUT, `video-${MODE}`));
