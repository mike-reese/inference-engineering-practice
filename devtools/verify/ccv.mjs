#!/usr/bin/env node
// ccv: drive the command center in a real, headed Chromium over the Chrome DevTools Protocol, the way a user does.
// Real GPU WebGL, real input events (Input.dispatchMouseEvent / dispatchKeyEvent), shadow DOM and CSS3D panels included.
// No dependencies: Node's built-in fetch and WebSocket. Every command prints one JSON object and logs itself to the
// session's actions.jsonl. Run `ccv help` for the commands.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.CCV_PORT || 9333);
const APP = process.env.CCV_APP || "http://127.0.0.1:7710";
const SIDE = `${APP}/static/prototypes/D5v2/side/index.html`;
const STATE = process.env.CCV_STATE || path.join(os.homedir(), ".local/state/inference-engineering/ccv");
const EVIDENCE_ROOT = process.env.CCV_EVIDENCE || "/mnt/ie-data/cc-v2-verify/evidence";
const BROWSER = process.env.CCV_CHROMIUM || "/usr/bin/chromium";
const INFO = path.join(STATE, "browser.json");
const VIEW = { width: 1800, height: 1000 };

const HELP = `ccv: verify the command center as a user, in a real browser (CDP, port ${PORT})

Session
  launch [--url U] [--session NAME]   start our own headed Chromium (own profile) on the side view; wait until READY
  doctor                              read-only health: browser ours and up, page on ${APP}, server, store, READY
  open [URL|side]                     navigate like the address bar; waits for READY on scene pages
  back | forward                      the browser's Back / Forward buttons (history entries, hash changes included)
  close                               stop the browser and console watcher we started; evidence stays

Act (real input events; a target outside the viewport is scrolled into view first; it must then be visible and not covered)
  click   TARGET [--frac fx,fy] [--button left|right|middle] [--count 2]
  hover   TARGET
  wheel   TARGET --dy N [--steps K]   N px per step (positive zooms out in MapControls), K steps 16 ms apart
  drag    TARGET --by dx,dy [--button left|right] [--steps K]   press at the target, move by dx,dy, release
  drag    --from x,y --to x,y [...]                          the same between two points (last resort)
  key     KEY [--mods ctrl,shift,alt]  e.g. ArrowRight, Enter, Escape, " ", a
  type    TEXT                         into the focused element
  select  TARGET --option TEXT         keyboard selection on a focused <select>
  TARGET is one of: --at x,y | --css SEL | --text T [--exact] | --role R --name N ; plus [--nth i]
  Every act accepts --after NAME: screenshot the resulting state as NAME.png

Observe
  shot NAME [--css SEL]               screenshot (viewport or one element) into the session folder
  aria NAME                           accessibility tree (pierces shadow roots) as text
  state                               app snapshot: URL, READY, timeline label, camera, focus level, flyout tab, errors
  find TARGET                         where a target is, in the viewport or not, covered or not (no input, no scrolling)
  wait (--text T | --css SEL | --gone-text T | --expr JS) [--timeout ms]
  perf                                frame and input-to-frame latency percentiles the page recorded
  console [--tail N]                  console messages and page errors since launch
  eval JS                             READ-ONLY probe; never use it to change app state

Environment: CCV_PORT CCV_APP CCV_EVIDENCE CCV_STATE CCV_CHROMIUM CCV_SESSION
`;

// ---------------------------------------------------------------- args
function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) opt[k] = true; else { opt[k] = v; i++; } }
    else pos.push(a);
  }
  return { pos, opt };
}
const pair = (s) => s.split(",").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readInfo = () => { try { return JSON.parse(fs.readFileSync(INFO, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function session(info = readInfo()) {
  const name = process.env.CCV_SESSION || info?.session || "adhoc";
  const dir = path.join(EVIDENCE_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function logAction(entry) {
  fs.appendFileSync(path.join(session(), "actions.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// ---------------------------------------------------------------- CDP
class CDP {
  static async attach(port = PORT) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
    if (!page) throw new Error("no page target: run `ccv launch` (or `ccv open side`)");
    const c = new CDP(page.webSocketDebuggerUrl);
    await c.ready;
    return c;
  }
  constructor(url) {
    this.id = 0; this.wait = new Map(); this.handlers = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((ok, bad) => { this.ws.onopen = ok; this.ws.onerror = () => bad(new Error("CDP socket failed")); });
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.wait.has(d.id)) { const [ok, bad] = this.wait.get(d.id); this.wait.delete(d.id); d.error ? bad(new Error(d.error.message)) : ok(d.result); }
      else if (d.method) this.handlers.forEach((h) => h(d));
    };
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((ok, bad) => this.wait.set(id, [ok, bad])); }
  on(fn) { this.handlers.push(fn); }
  close() { this.ws.close(); }
  async eval(expr, awaitPromise = true) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  settle() { return this.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"); }
}

// ---------------------------------------------------------------- targets (in-page, shadow roots pierced)
const FINDER = String.raw`(spec) => {
  const roots = []; (function walk(r) { roots.push(r); for (const e of r.querySelectorAll("*")) if (e.shadowRoot) walk(e.shadowRoot); })(document);
  const all = roots.flatMap((r) => [...r.querySelectorAll("*")]);
  const ROLE = { BUTTON: "button", A: "link", SELECT: "combobox", SUMMARY: "button", TEXTAREA: "textbox", CANVAS: "img", H1: "heading", H2: "heading", H3: "heading", TR: "row", TABLE: "table", LABEL: "label" };
  const role = (e) => e.getAttribute("role") || (e.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", range: "slider" }[e.type] || "textbox") : ROLE[e.tagName] || "");
  const name = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || e.value || "").replace(/\s+/g, " ").trim();
  const shown = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.02; };
  let hits = [];
  if (spec.css) hits = roots.flatMap((r) => [...r.querySelectorAll(spec.css)]);
  else if (spec.role) hits = all.filter((e) => role(e) === spec.role && (spec.name == null || (spec.exact ? name(e) === spec.name : name(e).includes(spec.name))));
  else if (spec.text) { const t = spec.text; hits = all.filter((e) => { const n = (e.textContent || "").replace(/\s+/g, " ").trim(); return spec.exact ? n === t : n.includes(t); });
    hits = hits.filter((e) => ![...e.children].some((c) => hits.includes(c))); }   // innermost elements only
  const vis = hits.filter(shown);
  const e = vis[spec.nth || 0];
  if (!e) return { found: hits.length, visible: vis.length, error: hits.length ? "matched but not visible" : "no match" };
  const outside = (b) => b.bottom <= 0 || b.right <= 0 || b.top >= innerHeight || b.left >= innerWidth;
  if (spec.scroll && outside(e.getBoundingClientRect())) e.scrollIntoView({ block: "center", inline: "center" });   // a user scrolls to it first
  const r = e.getBoundingClientRect(), [fx, fy] = spec.frac || [0.5, 0.5], inView = !outside(r);
  if (spec.scroll && !inView) return { found: hits.length, visible: vis.length, error: "outside the viewport, and scrolling did not bring it in" };
  const x = r.left + r.width * fx, y = r.top + r.height * fy;
  let top = document.elementFromPoint(x, y); while (top && top.shadowRoot) { const inner = top.shadowRoot.elementFromPoint(x, y); if (!inner || inner === top) break; top = inner; }
  const covered = top && top !== e && !e.contains(top) && !top.contains(e);   // canvas under a transparent overlay counts as covered
  const label = (n) => n ? n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\s+/).join(".") : "") : null;
  return { x, y, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, tag: label(e), role: role(e), name: name(e).slice(0, 120),
           matches: vis.length, in_viewport: inView, covered: inView && covered ? label(top) : null };
}`;

function spec(opt) {
  if (opt.at) { const [x, y] = pair(opt.at); return { at: { x, y } }; }
  const s = { nth: opt.nth ? Number(opt.nth) : 0, exact: !!opt.exact };
  if (opt.css) s.css = opt.css; else if (opt.role) { s.role = opt.role; if (opt.name) s.name = opt.name; } else if (opt.text) s.text = opt.text;
  else throw new Error("give a target: --at x,y | --css SEL | --text T | --role R --name N");
  if (opt.frac) s.frac = pair(opt.frac);
  return s;
}
async function locate(c, opt, { allowCovered = false, scroll = true } = {}) {
  const s = spec(opt);
  if (s.at) return { x: s.at.x, y: s.at.y, tag: "point" };
  s.scroll = scroll;
  const r = await c.eval(`(${FINDER})(${JSON.stringify(s)})`);
  if (scroll) await c.settle();
  if (r.error) throw new Error(`target ${JSON.stringify(s)}: ${r.error} (${r.found} found, ${r.visible} visible)`);
  if (r.covered && !allowCovered && !opt.force) throw new Error(`target ${r.tag} "${r.name}" is covered at its center by ${r.covered}; a user could not click it (--force to send anyway)`);
  return r;
}

// ---------------------------------------------------------------- input
const BUTTONS = { left: 1, right: 2, middle: 4 };
async function mouse(c, type, x, y, extra = {}) { await c.send("Input.dispatchMouseEvent", { type, x, y, ...extra }); }
async function click(c, x, y, button = "left", count = 1) {
  await mouse(c, "mouseMoved", x, y);
  for (let i = 1; i <= count; i++) {
    await mouse(c, "mousePressed", x, y, { button, buttons: BUTTONS[button], clickCount: i });
    await mouse(c, "mouseReleased", x, y, { button, buttons: 0, clickCount: i });
  }
}
const KEYS = { Enter: [13, "Enter"], Escape: [27, "Escape"], Tab: [9, "Tab"], Backspace: [8, "Backspace"], " ": [32, "Space"],
  ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"], ArrowRight: [39, "ArrowRight"], ArrowDown: [40, "ArrowDown"],
  Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"] };
async function key(c, k, mods = []) {
  const m = (mods.includes("alt") ? 1 : 0) | (mods.includes("ctrl") ? 2 : 0) | (mods.includes("meta") ? 4 : 0) | (mods.includes("shift") ? 8 : 0);
  const [vk, code] = KEYS[k] || [k.toUpperCase().charCodeAt(0), /^[a-z]$/i.test(k) ? "Key" + k.toUpperCase() : /^\d$/.test(k) ? "Digit" + k : k];
  const text = k.length === 1 && !(m & 6) ? k : undefined;
  await c.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: m, text });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: m });
}

// ---------------------------------------------------------------- observation helpers
async function screenshot(c, name, css) {
  await c.settle();
  const params = { format: "png" };
  if (css) { const r = await locate(c, { css }, { allowCovered: true }); params.clip = { x: r.rect.left, y: r.rect.top, width: r.rect.width, height: r.rect.height, scale: 1 }; }
  const { data } = await c.send("Page.captureScreenshot", params);
  const file = path.join(session(), `${name.replace(/[^\w.-]/g, "_")}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}
const STATE_PROBE = String.raw`(() => {
  const $ = (q) => document.querySelector(q);
  const sc = window.SC, cam = sc?.camera?.position, tg = sc?.controls?.target;
  const names = (window.LEVELS || []).map((l) => l.name);
  const focus = typeof window.DEEPEST === "function" ? window.DEEPEST() : null;
  return { url: location.href, title: document.title, ready: !!window.READY, t_first_ms: window.T_FIRST ?? null,
    timeline: $("#tlabel")?.textContent ?? null, playing: $("#play")?.textContent?.includes("pause") ?? null,
    focus_level: focus == null ? null : { index: focus, name: names[focus] ?? null }, levels: names,
    camera: cam ? { position: [cam.x, cam.y, cam.z].map((v) => +v.toPrecision(6)), target: [tg.x, tg.y, tg.z].map((v) => +v.toPrecision(6)) } : null,
    flyout_tab: document.querySelector("#ftabs button.on")?.dataset.t ?? null,
    dock: document.body.classList.contains("dock-bottom") ? "bottom" : document.querySelector("#side") ? "right" : null,
    summary_head: ($("#sum")?.innerText || "").split("\n").slice(0, 6), viewport: [innerWidth, innerHeight] };
})()`;

async function axText(c) {
  const { nodes } = await c.send("Accessibility.getFullAXTree");
  const by = new Map(nodes.map((n) => [n.nodeId, n])), lines = [];
  const walk = (n, d) => {
    const role = n.role?.value, name = n.name?.value, skip = n.ignored || role === "none" || role === "generic" && !name;
    if (!skip) lines.push(`${"  ".repeat(d)}${role}${name ? ` "${String(name).replace(/\s+/g, " ").slice(0, 160)}"` : ""}`);
    for (const id of n.childIds || []) { const ch = by.get(id); if (ch) walk(ch, skip ? d : d + 1); }
  };
  walk(nodes[0], 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------- browser lifecycle
async function waitReady(c, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    // a scene page (prototypes/D5v2) is ready when it sets window.READY; any other page when it has loaded
    const v = await c.eval("({ url: location.href, scene: location.pathname.includes('/D5v2/'), ready: !!window.READY, state: document.readyState })").catch(() => null);
    if (v && v.url.startsWith("http") && v.state === "complete" && (!v.scene || v.ready)) return v;
    await sleep(250);
  }
  throw new Error(`page not READY after ${timeout} ms (run ccv console for page errors)`);
}
async function versionInfo() { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { return null; } }

async function launch(opt) {
  const info = readInfo();
  if (info && alive(info.pid)) throw new Error(`our browser is already running (pid ${info.pid}, session ${info.session}); use it, or ccv close first`);
  if (await versionInfo()) throw new Error(`port ${PORT} already answers CDP but not from a browser we started; refusing to drive it (set CCV_PORT)`);
  const name = opt.session || process.env.CCV_SESSION || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.mkdirSync(STATE, { recursive: true });
  const profile = path.join(STATE, "profile");
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    `--window-size=${VIEW.width},${VIEW.height}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling", "--new-window", opt.url || SIDE];
  if (opt.headless) args.unshift("--headless=new");
  const child = spawn(BROWSER, args, { detached: true, stdio: "ignore" }); child.unref();
  fs.writeFileSync(INFO, JSON.stringify({ pid: child.pid, port: PORT, session: name, headless: !!opt.headless, started: new Date().toISOString() }));
  for (let i = 0; i < 80 && !(await versionInfo()); i++) await sleep(250);
  if (!(await versionInfo())) throw new Error("Chromium did not open its debugging port in 20 s");
  const watcher = spawn(process.execPath, [new URL(import.meta.url).pathname, "_watch"], { detached: true, stdio: "ignore", env: { ...process.env, CCV_SESSION: name } });
  watcher.unref();
  fs.writeFileSync(INFO, JSON.stringify({ ...readInfo(), watcher: watcher.pid }));
  const c = await CDP.attach(); const ready = await waitReady(c); c.close();
  return { launched: true, pid: child.pid, headless: !!opt.headless, session: name, evidence: session(), ready };
}

// Console watcher: one long-lived CDP connection that records console messages and page errors to console.jsonl.
async function watch() {
  const file = path.join(session(), "console.jsonl");
  for (;;) {
    try {
      const c = await CDP.attach();
      await c.send("Runtime.enable"); await c.send("Log.enable"); await c.send("Page.enable");
      await new Promise((done) => {
        c.ws.onclose = done;
        c.on((d) => {
          let rec = null;
          if (d.method === "Runtime.consoleAPICalled") rec = { kind: d.params.type, text: d.params.args.map((a) => a.value ?? a.description ?? "").join(" ") };
          if (d.method === "Runtime.exceptionThrown") rec = { kind: "pageerror", text: d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text };
          if (d.method === "Log.entryAdded") rec = { kind: `log.${d.params.entry.level}`, text: `${d.params.entry.text} ${d.params.entry.url || ""}`.trim() };
          if (d.method === "Page.frameNavigated" && !d.params.frame.parentId) rec = { kind: "navigate", text: d.params.frame.url };
          if (rec) fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
        });
      });
    } catch { /* browser gone or between pages */ }
    const info = readInfo(); if (!info || !alive(info.pid)) return;
    await sleep(500);
  }
}

async function close() {
  const info = readInfo();
  if (!info) return { closed: false, note: "no browser recorded as ours" };
  for (const pid of [info.watcher, info.pid]) if (pid && alive(pid)) { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} } }
  for (let i = 0; i < 20 && alive(info.pid); i++) await sleep(200);
  fs.rmSync(INFO, { force: true });
  return { closed: true, pid: info.pid, evidence_kept: path.join(EVIDENCE_ROOT, info.session) };
}

async function doctor() {
  const info = readInfo(), checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("browser recorded and alive", !!info && alive(info.pid), info ? `pid ${info.pid}, session ${info.session}` : "run ccv launch");
  const v = await versionInfo(); add(`CDP on :${PORT}`, !!v, v?.Browser ?? "no answer");
  try { const r = await fetch(`${APP}/api/v2/runs`); const j = await r.json(); add("app server and v2 store", r.ok, `${APP}, ${j.runs.length} runs in ${j.store}`); }
  catch (e) { add("app server and v2 store", false, `${APP}: ${e.message} (docker start ie-devtools-v2scene)`); }
  try { const r = await fetch(`${APP}/runner/health`); add("runner (Run tab)", r.ok, r.ok ? "ok" : `HTTP ${r.status} (make runner in the main checkout)`); }
  catch (e) { add("runner (Run tab)", false, e.message); }
  if (v) { try { const c = await CDP.attach(); const s = await c.eval(STATE_PROBE); c.close();
    add("page is the app", s.url.startsWith(APP), s.url); add("scene READY", s.ready, s.timeline ?? ""); } catch (e) { add("page", false, e.message); } }
  return { ok: checks.every((c) => c.ok), checks, evidence: info ? path.join(EVIDENCE_ROOT, info.session) : null };
}

// ---------------------------------------------------------------- commands
async function run(cmd, pos, opt) {
  if (cmd === "help" || !cmd) { process.stdout.write(HELP); return null; }
  if (cmd === "launch") return launch(opt);
  if (cmd === "close") return close();
  if (cmd === "doctor") return doctor();
  if (cmd === "_watch") { await watch(); return null; }

  const c = await CDP.attach();
  try {
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });   // keyboard and focus work while the window is in the background
    let out;
    switch (cmd) {
      case "open": { const url = !pos[0] || pos[0] === "side" ? SIDE : pos[0].startsWith("http") ? pos[0] : APP + pos[0];
        await c.send("Page.navigate", { url }); await sleep(300); out = { url, ready: await waitReady(c) }; break; }
      case "back": case "forward": { const h = await c.send("Page.getNavigationHistory"), i = h.currentIndex + (cmd === "back" ? -1 : 1);
        if (i < 0 || i >= h.entries.length) throw new Error(`no history entry to go ${cmd} to`);
        await c.send("Page.navigateToHistoryEntry", { entryId: h.entries[i].id }); await sleep(300); out = { url: h.entries[i].url }; break; }
      case "click": { const r = await locate(c, opt); await click(c, r.x, r.y, opt.button || "left", Number(opt.count || 1)); out = { clicked: r }; break; }
      case "hover": { const r = await locate(c, opt, { allowCovered: true }); await mouse(c, "mouseMoved", r.x, r.y); out = { hovered: r }; break; }
      case "wheel": { const r = await locate(c, opt, { allowCovered: true }); const steps = Number(opt.steps || 1), dy = Number(opt.dy || 100);
        await mouse(c, "mouseMoved", r.x, r.y);
        for (let i = 0; i < steps; i++) { await mouse(c, "mouseWheel", r.x, r.y, { deltaX: 0, deltaY: dy }); await sleep(16); }
        out = { wheel: { at: [r.x, r.y], dy, steps } }; break; }
      case "drag": { let x0, y0, x1, y1;
        if (opt.from) { [x0, y0] = pair(opt.from); [x1, y1] = pair(opt.to); }
        else { const r = await locate(c, opt, { allowCovered: true }), [dx, dy] = pair(opt.by || "0,0"); [x0, y0, x1, y1] = [r.x, r.y, r.x + dx, r.y + dy]; }
        const b = opt.button || "left", n = Number(opt.steps || 20);
        await mouse(c, "mouseMoved", x0, y0); await mouse(c, "mousePressed", x0, y0, { button: b, buttons: BUTTONS[b], clickCount: 1 });
        for (let i = 1; i <= n; i++) { await mouse(c, "mouseMoved", x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, { button: b, buttons: BUTTONS[b] }); await sleep(16); }
        await mouse(c, "mouseReleased", x1, y1, { button: b, buttons: 0, clickCount: 1 }); out = { drag: { from: [x0, y0], to: [x1, y1], button: b } }; break; }
      case "key": { await key(c, pos[0], (opt.mods || "").split(",").filter(Boolean)); out = { key: pos[0], mods: opt.mods || "" }; break; }
      case "type": { await c.send("Input.insertText", { text: pos.join(" ") }); out = { typed: pos.join(" ") }; break; }
      case "select": { const r = await locate(c, opt); await click(c, r.x, r.y); await key(c, "Escape");   // focus it as a user does; close the native popup
        const want = opt.option; const idx = await c.eval(`(() => { const roots = []; (function w(r) { roots.push(r); for (const e of r.querySelectorAll("*")) if (e.shadowRoot) w(e.shadowRoot); })(document);
          const s = roots.flatMap((r) => [...r.querySelectorAll("select")]).find((e) => e.matches(":focus") || e.getRootNode().activeElement === e);
          if (!s) return null; const o = [...s.options].findIndex((o) => o.text.trim() === ${JSON.stringify(want)} || o.value === ${JSON.stringify(want)}); return o < 0 ? { missing: [...s.options].map((o) => o.text) } : { from: s.selectedIndex, to: o }; })()`);
        if (!idx) throw new Error("the select did not take focus from the click");
        if (idx.missing) throw new Error(`no option "${want}"; options: ${idx.missing.join(" | ")}`);
        for (let i = 0; i < Math.abs(idx.to - idx.from); i++) await key(c, idx.to > idx.from ? "ArrowDown" : "ArrowUp");
        out = { selected: want, target: r }; break; }
      case "shot": out = { screenshot: await screenshot(c, pos[0] || `shot-${Date.now()}`, opt.css) }; break;
      case "aria": { const file = path.join(session(), `${(pos[0] || "aria").replace(/[^\w.-]/g, "_")}.aria.txt`); fs.writeFileSync(file, await axText(c)); out = { aria: file }; break; }
      case "state": out = await c.eval(STATE_PROBE); break;
      case "find": out = await locate(c, opt, { allowCovered: true, scroll: false }); break;
      case "wait": { const end = Date.now() + Number(opt.timeout || 15000); let hit = null;
        while (Date.now() < end) {
          if (opt.expr) hit = await c.eval(`(() => (${opt.expr}))()`).catch(() => null);
          else if (opt["gone-text"]) hit = (await c.eval(`(${FINDER})(${JSON.stringify({ text: opt["gone-text"] })})`)).error ? true : null;
          else hit = await c.eval(`(${FINDER})(${JSON.stringify(spec(opt))})`).then((r) => (r.error ? null : r));
          if (hit) break; await sleep(150); }
        if (!hit) throw new Error(`wait timed out: ${JSON.stringify(opt)}`); out = { waited: hit }; break; }
      case "perf": out = await c.eval(`(() => { const q = (a, p) => { if (!a || !a.length) return null; const b = a.slice().sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(b.length * p))].toFixed(2); };
        return { draws: (window.FT || []).length, draw_p50_ms: q(window.FT, .5), draw_p95_ms: q(window.FT, .95), input_to_frame_p50_ms: q(window.LATS, .5), input_to_frame_p95_ms: q(window.LATS, .95) }; })()`); break;
      case "console": { const file = path.join(session(), "console.jsonl"); const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
        out = { file, total: lines.length, errors: lines.filter((l) => /"kind":"(error|pageerror|log.error)"/.test(l)).length, tail: lines.slice(-Number(opt.tail || 30)).map((l) => JSON.parse(l)) }; break; }
      case "eval": out = { value: await c.eval(`(() => (${pos.join(" ")}))()`) }; break;
      default: throw new Error(`unknown command ${cmd}; ccv help`);
    }
    if (["click", "hover", "wheel", "drag", "key", "type", "select", "open", "back", "forward"].includes(cmd)) {
      await c.settle();
      if (opt.after) out.after = await screenshot(c, opt.after);
    }
    return out;
  } finally { c.close(); }
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parse(rest);
try {
  const out = await run(cmd, pos, opt);
  if (out) { if (cmd !== "_watch" && cmd !== "help") logAction({ cmd, pos, opt, ok: true, out }); console.log(JSON.stringify(out, null, 1)); }
} catch (e) {
  if (cmd !== "_watch") { try { logAction({ cmd, pos, opt, ok: false, error: e.message }); } catch {} }
  console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1);
}
