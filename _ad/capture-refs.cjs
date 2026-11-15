// Capture real BondScore UI states over a local HTTP origin.
// Renders the product's own code: test_harness.html drives content/ui.js +
// core/storage.js + core/scoring.js; popup/popup.html is the real popup fed from
// the same storage map. Decay mirrors background.js (recalc from shifted events).
const { chromium } = require("C:/Users/win10/AppData/Local/ai-promo-video/node_modules/playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve("D:/x-bond-score");
const OUT = path.join(ROOT, "_ad/refs");
const PORT = 8777;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };

fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.resolve(ROOT, "." + (rel === "/" ? "/test_harness.html" : rel));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  fs.readFile(file, (e, b) => {
    if (e) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(b);
  });
});

const shot = async (page, sel, file) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "visible", timeout: 15000 });
  await el.screenshot({ path: path.join(OUT, file) });
  console.log("saved", file);
};

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

  await page.goto(`http://127.0.0.1:${PORT}/test_harness.html`, { waitUntil: "load" });
  await page.waitForSelector("#btn-simulate-mutual", { timeout: 20000 });
  await page.waitForFunction(() => window.bondStorage && window.bondUI);
  await page.click("#harness-theme-toggle");

  const target = (h) => page.fill("#target-handle-input", h);
  const click = (id) => page.click(id);

  // subaru: warm two-way, lands in the 70s-80s
  await target("subaru");
  await click("#btn-simulate-mutual");
  await click("#btn-simulate-thread-reply");
  await click("#btn-simulate-they-reply");
  await click("#btn-simulate-like");

  await target("emilia");
  await click("#btn-simulate-mutual");
  await click("#btn-simulate-reply");
  await click("#btn-simulate-they-reply");

  await target("khyleri");
  await click("#btn-simulate-mutual");
  await click("#btn-simulate-reply");

  await target("rem");
  await click("#btn-simulate-oneway");
  await click("#btn-simulate-reply");
  await click("#btn-simulate-reply");
  await click("#btn-simulate-reply");
  await click("#btn-simulate-reply");

  await target("alex");
  await click("#btn-simulate-many-likes");

  await target("noctis");
  await click("#btn-simulate-follower");

  await page.waitForTimeout(800);
  console.log("scores:", JSON.stringify(await page.evaluate(async () => (await window.bondStorage.getAllUsers()).map((u) => `${u.handle}:${Math.round(u.currentScore || 0)}`))));

  await target("emilia");
  await click("#btn-create-post");
  await page.waitForSelector(".mock-tweet .bond-badge", { timeout: 15000 });
  await page.waitForTimeout(500);
  await shot(page, "article.mock-tweet", "timeline-badge.png");
  await shot(page, "#mock-profile-username", "profile-badge.png");
  console.log("badge:", JSON.stringify(await page.locator(".mock-tweet .bond-badge").innerText()));

  await page.click(".mock-tweet .bond-badge");
  await page.waitForSelector(".bond-card", { timeout: 15000 });
  await page.waitForTimeout(1100);
  await shot(page, ".bond-card", "score-card.png");
  fs.writeFileSync(path.join(OUT, "score-card.txt"), await page.locator(".bond-card").innerText());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  for (const [btn, file] of [
    ["#btn-simulate-mutual", "follow-mutual.png"],
    ["#btn-simulate-oneway", "follow-oneway.png"],
    ["#btn-simulate-follower", "follow-follower.png"],
    ["#btn-simulate-block", "follow-blocked.png"],
  ]) {
    await target("subaru");
    await click(btn);
    await page.waitForTimeout(450);
    try { await shot(page, "#mock-profile-username", file); } catch (e) { console.log("skip", file); }
  }
  await target("subaru");
  await click("#btn-simulate-mutual");

  // --- decay: 30 days, recomputed the way background.js does (no memory floor) ---
  const decayed = await page.evaluate(async () => {
    const users = await window.bondStorage.getAllUsers();
    const settings = await window.bondStorage.getSettings();
    const out = [];
    for (const u of users) {
      const events = await window.bondStorage.getEvents(u.handle);
      events.forEach((e) => { e.timestamp -= 86400000 * 10; });
      await window.bondStorage.saveEvents(u.handle, events);
      const r = BondScoring.calculateUserScore(events, settings, 0);
      u.trend = r.score > (u.currentScore || 0) + 0.5 ? "rising" : (r.score < (u.currentScore || 0) - 0.5 ? "decaying" : "steady"); u.currentScore = r.score; u.tier = r.tier.id;
      await window.bondStorage.saveUser(u.handle, u);
      out.push(`${u.handle}:${Math.round(r.score)}:${r.tier.id}:${r.trend}`);
    }
    window.dispatchEvent(new CustomEvent("bondscore:updated", { detail: { handle: "subaru" } }));
    return out;
  });
  console.log("after 30d:", JSON.stringify(decayed));
  await page.waitForTimeout(800);
  await shot(page, "article.mock-tweet", "timeline-badge-decayed.png");
  console.log("decayed badge:", JSON.stringify(await page.locator(".mock-tweet .bond-badge").innerText()));
  await page.click(".mock-tweet .bond-badge");
  await page.waitForSelector(".bond-card", { timeout: 15000 });
  await page.waitForTimeout(1100);
  await shot(page, ".bond-card", "score-card-decayed.png");
  fs.writeFileSync(path.join(OUT, "score-card-decayed.txt"), await page.locator(".bond-card").innerText());

  // --- real popup with the harness storage map ---
  const store = await page.evaluate(() => {
    const blob = JSON.parse(localStorage.getItem("bond_harness_data") || "{}");
    blob.currentUser = "main_user";
    return blob;
  });
  console.log("popup store keys:", Object.keys(store).length);

  const popup = await ctx.newPage();
  popup.on("pageerror", (e) => console.log("popup pageerror:", e.message));
  await popup.addInitScript((payload) => {
    const store = JSON.parse(JSON.stringify(payload));
    const listeners = [];
    const fire = (ch) => listeners.forEach((fn) => { try { fn(ch, "local"); } catch {} });
    window.chrome = {
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            if (!keys) Object.assign(out, store);
            else if (typeof keys === "string") { if (keys in store) out[keys] = store[keys]; }
            else if (Array.isArray(keys)) keys.forEach((k) => { if (k in store) out[k] = store[k]; });
            else Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
            cb && cb(out);
          },
          set(items, cb) { const ch = {}; Object.entries(items).forEach(([k, v]) => { store[k] = v; ch[k] = { newValue: v }; }); fire(ch); cb && cb(); },
          remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); cb && cb(); },
          clear(cb) { Object.keys(store).forEach((k) => delete store[k]); cb && cb(); },
        },
        onChanged: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
      },
      tabs: { query: (_q, cb) => cb([]), sendMessage: (_i, _m, cb) => cb && cb(null), create: () => {} },
      runtime: { getManifest: () => ({ version: "1.1.1" }), sendMessage: (_m, cb) => cb && cb(null), lastError: null },
    };
  }, store);

  await popup.goto(`http://127.0.0.1:${PORT}/popup/popup.html`, { waitUntil: "load" });
  await popup.waitForTimeout(1800);
  await popup.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await popup.waitForTimeout(700);
  await popup.screenshot({ path: path.join(OUT, "popup-mutuals.png"), fullPage: true });
  console.log("saved popup-mutuals.png");

  const orbitTab = popup.locator('[data-tab="tab-orbit"]');
  if (await orbitTab.count()) {
    await orbitTab.first().click();
    await popup.waitForTimeout(2200);
    await popup.screenshot({ path: path.join(OUT, "popup-orbit.png"), fullPage: true });
    await popup.locator("#orbit-canvas").first().screenshot({ path: path.join(OUT, "orbit-canvas.png") });
    console.log("saved popup-orbit.png + orbit-canvas.png");
  }

  await browser.close();
  server.close();
})().catch((e) => { console.error("FAILED", e); server.close(); process.exit(1); });
