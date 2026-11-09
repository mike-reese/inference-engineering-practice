// CCVB decode: zero-copy typed-array views over one ArrayBuffer. The boundary for block bytes: every expected column
// is checked here (name, dtype, alignment, length), so the rest of the store trusts the arrays.
import { COLUMNS, DTYPES } from "./columns.js";

const MAGIC = 0x42564343;   // "CCVB" read as a little-endian u32

/**
 * @param {ArrayBuffer} buf
 * @param {string} label  the block name, for error messages
 * @returns {{header: any, cols: Record<string, ArrayBufferView & ArrayLike<number>>}}
 */
export function decodeBlock(buf, label) {
  const fail = (msg) => { throw new Error(`CCVB ${label}: ${msg}`); };
  if (buf.byteLength < 8) fail(`${buf.byteLength} bytes, too short`);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) fail("bad magic");
  const hl = dv.getUint32(4, true), base = 8 + hl;
  if (base % 8 !== 0 || base > buf.byteLength) fail(`header length ${hl} is not padded to 8`);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  if (header.schema !== "ccvb/1") fail(`schema ${header.schema}, expected ccvb/1`);
  const want = COLUMNS[header.table];
  if (!want) fail(`table ${header.table} is not events, links or samples`);
  const spec = new Map(header.columns.map((c) => [c.name, c]));
  const expect = header.table === "samples" ? [...want, ...(header.metrics || []).map((_, j) => [`m${j}`, "<f4"])] : want;
  const cols = {};
  for (const [name, type] of expect) {
    const c = spec.get(name);
    if (!c) fail(`missing column ${name}`);
    if (c.type !== type) fail(`column ${name} is ${c.type}, expected ${type}`);
    if (c.length !== header.rows) fail(`column ${name} has ${c.length} rows, header says ${header.rows}`);
    const T = DTYPES[type], at = base + c.offset;
    if (at % T.BYTES_PER_ELEMENT !== 0 || at + c.length * T.BYTES_PER_ELEMENT > buf.byteLength) fail(`column ${name} is out of bounds`);
    cols[name] = new T(buf, at, c.length);
  }
  return { header, cols };
}
