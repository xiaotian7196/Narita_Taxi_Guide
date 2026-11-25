// Regression check for the apron rules, per runway and direction:
//   * T/S (and T3–T10, S1–S7) must not be used as a through route away from the ends;
//   * the C/K diagonal should follow the movement direction (C north-east, K south-west).
import { readFileSync } from "node:fs";
import { Airport, dist } from "../src/airport.ts";
import { plan } from "../src/plan.ts";
import { FLOWS } from "../src/procedures.ts";

const ap = new Airport(JSON.parse(readFileSync(new URL("../src/data/rjaa.json", import.meta.url), "utf8")));
const rows = new Map<string, { n: number; total: number; ts: number; wrong: number; worst: number }>();
const RADIUS = 650;
const MIN_X = 700;

for (const f of FLOWS) {
  for (const mode of ["arr", "dep"] as const) {
    for (const rwy of mode === "arr" ? f.arr : f.dep) {
      const key = `${mode} ${rwy}`;
      const row = rows.get(key) ?? { n: 0, total: 0, ts: 0, wrong: 0, worst: 0 };
      for (const s of ap.data.stands) {
        const o = plan(ap, { mode, flow: f.id, runway: rwy, stand: s.ref })[0];
        if (!o) continue;
        row.n++;
        row.total += o.length;
        const stand = [s.x, s.y];
        const routeEnds = [o.line[0], o.line[o.line.length - 1]];
        // the same route-wide preference the router uses
        const dy = routeEnds[1][1] - routeEnds[0][1];
        const prefer = Math.abs(dy) >= 300 ? (dy > 0 ? "C" : "K") : null;
        let bad = 0;
        o.steps.forEach((st, i) => {
          const next = o.steps[i + 1]?.at ?? routeEnds[1];
          const ends = [st.at, next];
          const away = Math.min(...ends.map((p) => dist(p, routeEnds[0]))) > RADIUS
            && Math.min(...ends.map((p) => dist(p, routeEnds[1]))) > RADIUS;
          if (!away) return;
          const ref = st.ref;
          if (ref === "T" || ref === "S" || /^T\d+$/.test(ref) || /^S\d+$/.test(ref)) { row.ts += st.length; bad += st.length; }
          if (prefer && (ref === "C" || ref === "K") && ref !== prefer && (st.at[0] + next[0]) / 2 > MIN_X) { row.wrong += st.length; bad += st.length; }
        });
        if (bad > row.worst) row.worst = bad;
      }
      rows.set(key, row);
    }
  }
}
for (const [k, r] of rows) {
  console.log(`${k.padEnd(8)} routes ${r.n}  avg ${Math.round(r.total / r.n)}m  T/S-through ${Math.round(r.ts)}m  wrong-parallel ${Math.round(r.wrong)}m  worst ${Math.round(r.worst)}m`);
}
