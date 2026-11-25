// Per-runway check of T/S used as a through route: a step only counts when both
// its start and end are far from the stand and the runway end.
import { readFileSync } from "node:fs";
import { Airport, dist } from "../src/airport.ts";
import { plan } from "../src/plan.ts";
import { FLOWS } from "../src/procedures.ts";

const ap = new Airport(JSON.parse(readFileSync(new URL("../src/data/rjaa.json", import.meta.url), "utf8")));
const rows = new Map<string, { n: number; total: number; far: number; worst: { s: string; far: number } }>();

for (const f of FLOWS) {
  for (const mode of ["arr", "dep"] as const) {
    for (const rwy of mode === "arr" ? f.arr : f.dep) {
      const key = `${mode} ${rwy}`;
      const row = rows.get(key) ?? { n: 0, total: 0, far: 0, worst: { s: "", far: 0 } };
      for (const s of ap.data.stands) {
        const o = plan(ap, { mode, flow: f.id, runway: rwy, stand: s.ref })[0];
        if (!o) continue;
        row.n++;
        row.total += o.length;
        const stand = [s.x, s.y];
        const rwyEnd = o.line[o.line.length - 1];
        let far = 0;
        o.steps.forEach((st, i) => {
          if (st.ref !== "T" && st.ref !== "S") return;
          const next = o.steps[i + 1]?.at ?? rwyEnd;
          const ends = [st.at, next];
          const nearStand = Math.min(...ends.map((p) => dist(p, stand)));
          const nearRwy = Math.min(...ends.map((p) => dist(p, rwyEnd)));
          if (nearStand > 700 && nearRwy > 700) far += st.length;
        });
        row.far += far;
        if (far > row.worst.far) row.worst = { s: `${s.ref} ${Math.round(o.length)}m ${o.summary}`, far };
      }
      rows.set(key, row);
    }
  }
}
for (const [k, r] of rows) {
  console.log(`${k.padEnd(8)} routes ${r.n}  avg ${Math.round(r.total / r.n)}m  T/S-transit ${Math.round(r.far)}m  worst ${Math.round(r.worst.far)}m ${r.worst.s}`);
}
