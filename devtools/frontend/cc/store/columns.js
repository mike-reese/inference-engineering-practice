// Mirror of backend/store/schema.py: the hot columns the browser holds, per CCVB table, with numpy dtype strings.
// `make store-check` fails when this file and schema.py differ. Change schema.py first, then this file.

export const N_TIERS = 7;
export const NONE16 = 0xffff;

/** @type {Record<"events"|"links"|"samples", [string, string][]>} */
export const COLUMNS = {
  events: [
    ["id", "<u4"], ["start", "<f8"], ["end", "<f8"], ["lane", "<u2"], ["comp", "<u2"], ["kind", "|u1"], ["tier", "|u1"],
    ["depth", "<u2"], ["req", "<u2"], ["iter", "<i4"], ["parent", "<i4"], ["cause", "<i4"], ["name", "<u4"], ["bytes", "<f8"],
    ["layer", "<i2"], ["flow", "|u1"],
  ],
  links: [["from", "<u4"], ["to", "<u4"], ["kind", "|u1"], ["weight", "<f4"]],
  samples: [["ts", "<f8"]],   // then m0..mk ("<f4"), one per catalog code in the block header's `metrics`
};

export const DTYPES = { "<u4": Uint32Array, "<i4": Int32Array, "<i2": Int16Array, "<u2": Uint16Array, "|u1": Uint8Array, "<f8": Float64Array, "<f4": Float32Array };
