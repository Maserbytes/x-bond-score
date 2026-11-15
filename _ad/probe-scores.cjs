// Find the interaction recipe that lands BondScore on a convincing mid score.
const { chromium } = require("C:/Users/win10/AppData/Local/ai-promo-video/node_modules/playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve("D:/x-bond-score");
const PORT = 8779;

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.resolve(ROOT, "." + (rel === "/" ? "/test_harness.html" : rel));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  fs.readFile(file, (e, b) => {
    if (e) return res.writeHead(404).end();
    const ext = path.extname(file);
    res.writeHead(200, { "content-type": ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html" });
    res.end(b);
  });
});

const STEPS = [
  ["1 thread reply", "#btn-simulate-thread-reply"],
  ["+ inbound reply", "#btn-simulate-they-reply"],
  ["+ DM", "#btn-simulate-dm"],
  ["+ like", "#btn-simulate-like"],
  ["+ reply sent", "#btn-simulate-reply"],
  ["+ thread reply", "#btn-simulate-thread-reply"],
];

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/test_harness.html`);
  await page.waitForSelector("#btn-simulate-mutual");
  await page.waitForFunction(() => window.bondStorage);
  await page.fill("#target-handle-input", "subaru");
  await page.click("#btn-simulate-mutual");

  for (const [label, sel] of STEPS) {
    await page.click(sel);
    await page.waitForTimeout(250);
    const s = await page.evaluate(async () => {
      const u = await window.bondStorage.getUser("subaru");
      const { score, tier, trend } = BondScoring.calculateUserScore(await window.bondStorage.getEvents("subaru"), await window.bondStorage.getSettings(), u.currentScore);
      return { score: Math.round(score), tier: tier.id, trend, raw: Math.round(u.currentScore || 0) };
    });
    console.log(label.padEnd(18), JSON.stringify(s));
  }

  // decay curve from the final state
  for (let i = 0; i < 4; i++) {
    await page.click("#btn-fast-forward");
    await page.waitForTimeout(400);
    const s = await page.evaluate(async () => {
      const u = await window.bondStorage.getUser("subaru");
      return { score: Math.round(u.currentScore || 0), tier: u.tier, trend: u.trend };
    });
    console.log(`after ${(i + 1) * 10} days`.padEnd(18), JSON.stringify(s));
  }

  await browser.close();
  server.close();
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
