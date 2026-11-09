// The view in the URL hash (COMMAND_CENTER.md 2.3), one JSON object as D13 wrote it: session, world, focus, tiers,
// paired, t, sel, metric, dock, pace and rate. A reload or a pasted link opens the same view. control.js decides what
// goes in (a row selection as {eid}, or as {id, generation} until its eid is fetched) and what a read means (a
// live session reloads as a replay).

/** The saved view, or null when the hash holds none. */
export function readHash(hash = location.hash) {
  try {
    const v = JSON.parse(decodeURIComponent(hash.slice(1)));
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

/** Replace the hash; no history entry. */
export function writeHash(view) { history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify(view))); }
