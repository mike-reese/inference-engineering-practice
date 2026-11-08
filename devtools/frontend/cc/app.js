// Composition root: the only file that wires modules. Everything below it talks through RunStore and Control.
import { openRun, listRuns } from "./store/run.js";
import { Control } from "./control/control.js";
import { bindKeys } from "./control/keys.js";
import { ControlBar } from "./control/bar.js";
import { parse } from "./control/url.js";
import { Scene } from "./scene/scene.js";
import { LEVELS } from "./levels/index.js";
import { Inspector } from "./inspector/inspector.js";
import { HardwareSidebar } from "./sidebar/sidebar.js";
import { perf } from "./perf.js";

const $ = (q) => /** @type {HTMLElement} */ (document.querySelector(q));

async function main() {
  perf.mark("open");
  const init = parse(location.hash);
  const run = init.run ?? (await listRuns())[0]?.run;
  if (!run) throw new Error("the store has no runs (GET /api/v3/runs returned an empty list)");
  const store = await openRun(run);
  perf.mark("store");
  const control = new Control(store, init, LEVELS);
  // the inspector sets the dock (body classes) first, so the scene measures its final stage size
  const inspector = new Inspector($("#inspector"), store, control);
  const sidebar = new HardwareSidebar($("#hw"), store, control);
  const scene = new Scene($("#stage"), store, control, LEVELS);
  new ControlBar($("#bar"), store, control, LEVELS);
  bindKeys(window, control, LEVELS);
  $("#runname").textContent = run;
  perf.provide("memory_mb", () => store.bytes());
  // read-only probes for the verification CLI (devtools/verify/ccv): never call them to drive the page
  Object.assign(window, { CC: Object.freeze({ control, store, scene, inspector, sidebar }) });
  const off = control.subscribe(() => { window.READY = true; perf.mark("ready"); queueMicrotask(off); });
}

main().catch((e) => { console.error(e); $("#stage").innerHTML = `<pre class="fatal">${String(e.message ?? e)}</pre>`; });
