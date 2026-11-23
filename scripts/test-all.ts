// Full sweep: every stand, runway and mode. Flags missing routes, skipped
// published taxiways, and routes that are far longer than the direct line.
import { readFileSync } from "node:fs";
import { Airport, dist, type XY } from "../src/airport.ts";
import { plan } from "../src/plan.ts";
import { FLOWS } from "../src/procedures.ts";

const ap = new Airport(JSON.parse(readFileSync(new URL("../src/data/rjaa.json", import.meta.url), "utf8")));
let missing = 0, missed = 0, detour = 0, total = 0, noGateway = 0;
const worst: { label: string; ratio: number; len: number }[] = [];

const tally = new Map<string, number>();
const note = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1);

for (const f of FLOWS) {
  for (const rwy of f.arr) {
    for (const s of ap.data.stands) {
      total++;
      const opts = plan(ap, { mode: "arr", flow: f.id, runway: rwy, stand: s.ref });
      if (!opts.length) { missing++; console.log(`NO ROUTE arr ${rwy} ${s.ref}`); continue; }
      const o = opts[0];
      if (!o.gateway) { noGateway++; note(`no gateway arr ${rwy}`); }
      if (o.missed.length) { missed++; note(`arr ${rwy}: ${o.missed.join("+")}`); }
      const straight = Math.hypot(s.x - o.line[0][0], s.y - o.line[0][1]);
      const ratio = o.length / Math.max(straight, 200);
      if (ratio > 2.6) { detour++; if (worst.length < 15) worst.push({ label: `arr ${rwy} ${s.ref}`, ratio, len: o.length }); }
    }
  }
  for (const rwy of f.dep) {
    for (const s of ap.data.stands) {
      total++;
      const opts = plan(ap, { mode: "dep", flow: f.id, runway: rwy, stand: s.ref });
      if (!opts.length) { missing++; console.log(`NO ROUTE dep ${rwy} ${s.ref}`); continue; }
      const o = opts[0];
      if (!o.gateway) { noGateway++; note(`no gateway dep ${rwy}`); }
      if (o.missed.length) { missed++; note(`dep ${rwy}: ${o.missed.join("+")}`); }
      const straight = Math.hypot(s.x - o.line[o.line.length - 1][0], s.y - o.line[o.line.length - 1][1]);
      const ratio = o.length / Math.max(straight, 200);
      if (ratio > 2.6) { detour++; if (worst.length < 15) worst.push({ label: `dep ${rwy} ${s.ref}`, ratio, len: o.length }); }
    }
  }
}
console.log(`\n${total} routes · missing ${missing} · skipped-taxiway ${missed} · no gateway ${noGateway} · detour>2.6x ${detour}`);
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
for (const w of worst) console.log(`  ${w.label} ${Math.round(w.len)}m ratio ${w.ratio.toFixed(1)}`);
