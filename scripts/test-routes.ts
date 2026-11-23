// Smoke test: every flow / runway / terminal sample must route, follow the
// published taxiways without skipping any, and not double back on itself.
import { readFileSync } from "node:fs";
import { Airport, dist, type XY } from "../src/airport.ts";
import { plan } from "../src/plan.ts";
import { FLOWS } from "../src/procedures.ts";

const ap = new Airport(JSON.parse(readFileSync(new URL("../src/data/rjaa.json", import.meta.url), "utf8")));
const sample: Record<string, string> = { T1: "11", T2: "61", T3: "150", T2sat: "441", cargo: "710" };

const bearing = (a: XY, b: XY) => Math.atan2(b[0] - a[0], b[1] - a[1]);
function heading(pts: XY[], i: number, dir: 1 | -1, span: number) {
  let j = i, acc = 0;
  while (acc < span && j + dir >= 0 && j + dir < pts.length) {
    acc += dist(pts[j], pts[j + dir]);
    j += dir;
  }
  return dir === 1 ? bearing(pts[i], pts[j]) : bearing(pts[j], pts[i]);
}
function maxReversal(pts: XY[]): number {
  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(pts[0], pts[i]) < 90 || dist(pts[i], pts[pts.length - 1]) < 90) continue;
    let d = Math.abs(((heading(pts, i, 1, 90) - heading(pts, i, -1, 90)) * 180) / Math.PI) % 360;
    if (d > 180) d = 360 - d;
    worst = Math.max(worst, d);
  }
  return worst;
}

let failures = 0;
for (const f of FLOWS) {
  for (const [mode, list] of [["arr", f.arr], ["dep", f.dep]] as const) {
    for (const rwy of list) {
      for (const [g, ref] of Object.entries(sample)) {
        const opts = plan(ap, { mode, flow: f.id, runway: rwy, stand: ref });
        if (!opts.length) { failures++; console.log(`NO ROUTE ${mode} ${rwy} ${g} ${ref}`); continue; }
        const o = opts[0];
        if (!o.gateway) { failures++; console.log(`NO GATEWAY ${mode} ${rwy} ${g} ${ref}: ${o.summary}`); }
        if (o.missed.length) { failures++; console.log(`SKIPPED ${mode} ${rwy} ${ref}: ${o.missed}`); }
        const r = maxReversal(o.line);
        if (r > 130) { failures++; console.log(`REVERSES ${mode} ${rwy} ${ref}: ${r.toFixed(0)}° ${o.summary}`); }
        if (o.length < 100) { failures++; console.log(`TOO SHORT ${mode} ${rwy} ${ref}: ${o.length}`); }
      }
    }
  }
}

// The AIP's designated speedy turn-offs must be offered as exits.
const wanted: Record<string, string[]> = { "16R": ["A6", "A7"], "34L": ["A5", "A4"], "16L": ["B6", "B7"], "34R": ["B4", "B2"] };
for (const [rwy, refs] of Object.entries(wanted)) {
  const have = new Set(ap.exits(rwy).map((e) => e.ref));
  for (const r of refs) if (!have.has(r)) { failures++; console.log(`MISSING EXIT ${rwy} ${r}`); }
}

// Full-length holding points of the four standard routes.
const entries: Record<string, string> = { "16R": "A1", "34L": "A10", "16L": "B1", "34R": "B9" };
for (const [rwy, ref] of Object.entries(entries)) {
  if (!ap.junctions(rwy).some((j) => j.ref === ref)) { failures++; console.log(`MISSING ENTRY ${rwy} ${ref}`); }
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`all ${FLOWS.length * 2} flow/runway pairs route cleanly for ${Object.keys(sample).length} sample stands`);
}
