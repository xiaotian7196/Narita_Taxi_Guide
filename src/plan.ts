// Turns a user selection into one routed option per published template.
import { dist, type Airport, type Exit, type Leg, type XY } from "./airport.ts";
import { ARRIVALS, DEPARTURES, LVP, templates, type FlowId, type Template } from "./procedures.ts";
import { route, steps, type RouteResult, type Step } from "./router.ts";

export interface PlanRequest {
  mode: "arr" | "dep";
  flow: FlowId;
  runway: string;
  stand: string;
  /** arrival: exit key `${ref}${side}`; departure: entry taxiway ref */
  point?: string;
  /** low-visibility (CAT II/III) operations */
  lvp?: boolean;
}
type Gateway = { r: string; p: XY; n?: number };

/** biggest net direction change along a path, in degrees (90 m window) */
function maxReversal(pts: XY[]): number {
  const bearing = (a: XY, b: XY) => Math.atan2(b[0] - a[0], b[1] - a[1]);
  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    let j = i, acc = 0;
    while (acc < 90 && j > 0) { acc += dist(pts[j], pts[j - 1]); j--; }
    const hin = bearing(pts[j], pts[i]);
    j = i; acc = 0;
    while (acc < 90 && j < pts.length - 1) { acc += dist(pts[j], pts[j + 1]); j++; }
    const hout = bearing(pts[i], pts[j]);
    let d = Math.abs(((hout - hin) * 180) / Math.PI) % 360;
    if (d > 180) d = 360 - d;
    worst = Math.max(worst, d);
  }
  return worst;
}

export interface PlanOption {
  template: Template;
  exit?: Exit;
  entry?: Leg;
  steps: Step[];
  line: XY[];
  length: number;
  missed: string[];
  summary: string;
  crossings: string[];
  crossAt: { rw: string; at: XY }[];
  /** apron gateway the route passes: outer taxiway system → apron taxilane */
  gateway?: { ref: string; at: XY };
}

/**
 * The gateway is the GWY holding position the route passes. Arrivals take the
 * last one before the stand (the apron entry), departures the first one after
 * the stand (the apron exit); both are where Ramp Control takes over.
 */
function findGateway(ap: Airport, nodes: number[], mode: "arr" | "dep"): { ref: string; at: XY } | undefined {
  let best: { ref: string; at: XY } | undefined;
  let bestIdx = mode === "arr" ? -1 : Infinity;
  for (let i = 1; i < nodes.length - (mode === "arr" ? 0 : 1); i++) {
    const p = ap.xy[nodes[i]];
    for (const g of ap.data.gateways ?? []) {
      if (dist(p, g.p) > 45) continue;
      const better = mode === "arr" ? i > bestIdx : i < bestIdx;
      if (better) {
        bestIdx = i;
        best = { ref: g.r, at: g.p };
      }
    }
  }
  return best;
}

function crossPoints(ap: Airport, nodes: number[], own: string) {
  const out: { rw: string; at: XY }[] = [];
  let last = "";
  nodes.forEach((n, i) => {
    const rw = ap.runwayNode.get(n) ?? "";
    if (rw && rw !== own && rw !== last && i > 0 && i < nodes.length - 1) out.push({ rw, at: ap.xy[n] });
    last = rw;
  });
  return out;
}

export const MIN_EXIT_S = 1500;
const LIKELY_EXIT_S = 2100;
export const exitKey = (e: Exit) => e.ref + e.side;

/** plans are deterministic for a given airport: the UI asks for the same one on
 * every language change or option click, so keep the last few. */
const planCaches = new WeakMap<Airport, Map<string, PlanOption[]>>();

export function plan(ap: Airport, req: PlanRequest): PlanOption[] {
  let cache = planCaches.get(ap);
  if (!cache) planCaches.set(ap, (cache = new Map()));
  const cacheKey = `${req.mode}|${req.flow}|${req.runway}|${req.stand}|${req.point ?? ""}|${req.lvp ? "lvp" : ""}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  if (req.lvp && req.runway !== LVP.runway) return [];

  const stand = ap.stand(req.stand);
  if (!stand) return [];
  const standLine: XY[] = [];
  for (let i = 0; i < stand.path.length; i += 2) standLine.push([stand.path[i], stand.path[i + 1]]);
  const own = ap.runway(req.runway).id;
  const out: PlanOption[] = [];

  // direction of the stand lead-in line as it leaves the taxiway network
  const lead = standLine.find((p) => Math.hypot(p[0] - standLine[0][0], p[1] - standLine[0][1]) > 3);
  const goalDir: XY | undefined = lead && [lead[0] - standLine[0][0], lead[1] - standLine[0][1]];

  /**
   * Apron gateways near a stand, nearest first. The route is required to pass one
   * of them, so the aircraft always leaves/enters the apron at a Ramp Control
   * holding position instead of cutting straight from the outer taxiway.
   */
  const gatewayCandidates = (from: XY) => {
    const all = (ap.data.gateways ?? []).filter((g) => g.n !== undefined);
    const near = all
      .map((g) => ({ g, d: dist(from, g.p) }))
      .filter((x) => x.d <= 1300)
      .sort((a, b) => a.d - b.d);
    const seen = new Set<string>();
    const list: typeof all = [];
    for (const { g } of near) {
      if (seen.has(g.r)) continue;
      seen.add(g.r);
      list.push(g);
      if (list.length >= 5) break;
    }
    return list.length ? list : all.slice().sort((a, b) => dist(from, a.p) - dist(from, b.p)).slice(0, 2);
  };

  /**
   * Gateways the baseline path already passes. For an arrival the last one on the
   * path is the apron entry, for a departure the first one is the apron exit.
   */
  const gatewaysOnPath = (nodes: number[], mode: "arr" | "dep") => {
    const hits = new Map<string, { g: { r: string; p: XY; n?: number }; i: number }>();
    const all = (ap.data.gateways ?? []).filter((g) => g.n !== undefined);
    for (let i = 1; i < nodes.length; i++) {
      const p = ap.xy[nodes[i]];
      for (const g of all) {
        // holding positions are drawn beside the taxiway centerline
        if (dist(p, g.p) > 150) continue;
        const prev = hits.get(g.r);
        if (!prev || (mode === "arr" ? i < prev.i : i > prev.i)) hits.set(g.r, { g, i });
      }
    }
    // arrival: the first gateway after the runway is the apron entry; departure:
    // the last one before the runway is the apron exit
    return [...hits.values()].sort((a, b) => (mode === "arr" ? a.i - b.i : b.i - a.i)).map((h) => h.g);
  };

  if (req.mode === "arr") {
    const exits = ap.exits(req.runway);
    // taxiways a movement may not use, from the published handling rules
    const num = parseInt(stand.ref, 10);
    const north = req.runway === "34L" || req.runway === "34R";
    // north flow: T1 arrivals are worked via K or G and never through J or H;
    // T3 arrivals on 34R cross 34L on A15 or A3, never down J;
    // south flow: the eastern T2 stands (56-73, 81-84) are not worked via R
    const avoidRefs = stand.group === "T1" && north ? ["J", "H"]
      : stand.group === "T3" && req.runway === "34R" ? ["J"]
      : stand.group === "T2" && north && ((num >= 56 && num <= 73) || (num >= 81 && num <= 84)) ? ["R"]
      : undefined;
    // T1 may use K (north) or G (south) — J and H are banned — but a stand on the
    // south side must not be worked via K: that route runs up the north side and
    // comes all the way back down
    let list = templates(ARRIVALS, req.runway, stand.group, req.flow);
    // templates that only apply to part of the terminal (by stand number)
    const standNum = parseInt(stand.ref, 10);
    if (list.some((t) => t.stands)) {
      const inRange = list.filter((t) => !t.stands || t.stands.some(([a, b]) => standNum >= a && standNum <= b));
      if (inRange.length) list = inRange;
    }
    if (stand.group === "T1" && stand.y < 0) {
      const south = list.filter((t) => !t.via.includes("K"));
      if (south.length) list = south;
    }
    const gws = gatewayCandidates([stand.x, stand.y]);
    for (const t of list) {
      let candidates = req.point ? exits.filter((e) => exitKey(e) === req.point) : exits.filter((e) => e.s >= MIN_EXIT_S);
      // never auto-select the last connector at the stop end: leaving there means
      // turning back along the runway
      if (!req.point) {
        const endS = ap.end(req.runway).sMax;
        const usable = candidates.filter((e) => e.s <= endS - 200);
        if (usable.length) candidates = usable;
      }
      // a stand is only ever served from its own side of the runway
      const standSide = ap.sideOf(req.runway, [stand.x, stand.y]);
      const sameSide = candidates.filter((e) => e.side === standSide);
      if (sameSide.length) candidates = sameSide;
      if (!req.point && t.side && candidates.some((e) => e.side === t.side)) candidates = candidates.filter((e) => e.side === t.side);
      // LVP: the CAT II/III chart uses the designated 16R turn-offs
      if (req.lvp) {
        const lvp = candidates.filter((e) => LVP.exits.includes(e.ref));
        if (lvp.length) candidates = lvp;
      }
      // try the most plausible turn-offs first and keep the search small: manual
      // selection always keeps every candidate
      if (!req.point) {
        candidates = [...candidates]
          .sort((a, b) => Math.abs(a.s - LIKELY_EXIT_S) + a.angle * 4 - (Math.abs(b.s - LIKELY_EXIT_S) + b.angle * 4))
          .slice(0, 3);
      }
      let best: PlanOption | null = null;

      // first pass keeps clear of the banned taxiways; only if that hides the stand
      // altogether do we fall back to them
      const pick = (avoid?: string[]) => {
        best = null;
        let bestScore = Infinity;
        for (const exit of candidates) {
          const base = route(ap, {
            start: exit.node, firstHop: exit.next, goal: stand.entry, via: t.via, ownRunway: own,
            goalDir, avoidRefs: avoid,
          });
          if (!base) continue;
          // The gateway must be crossed on its own taxiway, so even the one the
          // natural path passes is rerouted with the mustPass constraint. If the
          // natural path already follows every published taxiway and passes a
          // gateway, that is the answer: skip the per-gateway search.
          const tried: { r: RouteResult; gw: Gateway | undefined }[] = [];
          const onPath = gatewaysOnPath(base.nodes, "arr");
          const baseClean = base.missed.length === 0 && new Set(base.nodes).size === base.nodes.length
            && maxReversal(base.nodes.map((n) => ap.xy[n])) <= 130;
          if (baseClean && onPath.length) {
            tried.push({ r: base, gw: onPath[0] });
          } else {
            const cands: Gateway[] = [];
            for (const gw of [...onPath.slice(0, 1), ...gws.slice(0, 4)]) {
              if (!cands.some((c) => c.r === gw.r)) cands.push(gw);
            }
            for (const gw of cands) {
              const r = route(ap, {
                start: exit.node, firstHop: exit.next, goal: stand.entry, via: t.via, ownRunway: own,
                goalDir, avoidRefs: avoid, mustPass: gw.n,
              });
              if (r) tried.push({ r, gw });
            }
          }
          if (!tried.length) tried.push({ r: base, gw: undefined });
          // A gateway the graph cannot reach without doubling back is worse than
          // a clean taxi: fall back to the natural path and report the gateway it
          // passes, rather than drawing a loop.
          const clean = tried.filter(({ r }) =>
            new Set(r.nodes).size === r.nodes.length && maxReversal(r.nodes.map((n) => ap.xy[n])) <= 130);
          let choices = clean.length ? clean : [{ r: base, gw: undefined as Gateway | undefined }];
          // forcing the exact gateway node sometimes needs a loop the graph does
          // not have; if the natural path already passes a gateway, follows every
          // published taxiway and forcing is more than 5% longer, keep the natural
          // path and report that gateway
          const baseGw = findGateway(ap, base.nodes, "arr");
          const close = choices.filter(({ r }) => r.length <= base.length * 1.05);
          if (close.length) choices = close;
          else if (baseGw && base.missed.length === 0) choices = [{ r: base, gw: undefined }];
          for (const { r, gw } of choices) {
            // prefer a shallow turn-off around a typical landing roll, then the
            // gateway closest to the stand; a path that revisits a node is a loop
            const loop = new Set(r.nodes).size < r.nodes.length;
            const score = r.length + Math.max(0, exit.s - LIKELY_EXIT_S) * 2 + exit.angle * 3
              + r.missed.length * 4000 + (gw ? dist([stand.x, stand.y], gw.p) * 0.15 : 0)
              + (loop ? 1e6 : 0);
            if (best && bestScore <= score) continue;
            bestScore = score;
            const st = steps(ap, r, own);
            best = {
              template: t, exit, steps: st,
              line: [...r.nodes.map((n) => ap.xy[n]), ...standLine.slice(1)],
              length: r.length, missed: r.missed,
              summary: [...st.map((s) => s.ref).filter(Boolean), `Spot ${stand.ref}`].join(" → "),
              crossings: [...new Set(st.map((s) => s.crossing).filter((c): c is string => !!c))],
              crossAt: crossPoints(ap, r.nodes, own),
              gateway: gw
                ? { ref: gw.r, at: gw.p }
                : findGateway(ap, r.nodes, "arr") ?? (gws[0] ? { ref: gws[0].r, at: gws[0].p } : undefined),
            };
          }
        }
        // no gateway can be reached: keep the stand routable and report the gateway
        // the path happens to pass, if any
        if (!best) {
          for (const exit of candidates) {
            const r = route(ap, {
              start: exit.node, firstHop: exit.next, goal: stand.entry, via: t.via, ownRunway: own,
              goalDir, avoidRefs: avoid,
            });
            if (!r) continue;
            const score = r.length + Math.max(0, exit.s - LIKELY_EXIT_S) * 2 + exit.angle * 3 + r.missed.length * 4000;
            if (best && bestScore <= score) continue;
            bestScore = score;
            const st = steps(ap, r, own);
            best = {
              template: t, exit, steps: st,
              line: [...r.nodes.map((n) => ap.xy[n]), ...standLine.slice(1)],
              length: r.length, missed: r.missed,
              summary: [...st.map((s) => s.ref).filter(Boolean), `Spot ${stand.ref}`].join(" → "),
              crossings: [...new Set(st.map((s) => s.crossing).filter((c): c is string => !!c))],
              crossAt: crossPoints(ap, r.nodes, own),
              gateway: findGateway(ap, r.nodes, "arr"),
            };
          }
        }
      };
      pick(avoidRefs);
      if (!best && avoidRefs) pick(undefined);
      if (best) out.push(best);
    }
  } else {
    const junctions = ap.junctions(req.runway);
    const gws = gatewayCandidates([stand.x, stand.y]);
    for (const t of templates(DEPARTURES, req.runway, stand.group, req.flow)) {
      const want = req.lvp
        ? (req.point && LVP.entries.includes(req.point) ? req.point : LVP.entries[0])
        : req.point ?? t.entry;
      const entry = (want && junctions.find((j) => j.ref === want)) || junctions[0];
      if (!entry) continue;
      const base = route(ap, {
        start: stand.entry, goal: entry.node, goalFrom: (entry as Leg).next, via: t.via, ownRunway: own,
        // the aircraft leaves the stand along its lead-in line, i.e. opposite to goalDir
        startDir: goalDir && [-goalDir[0], -goalDir[1]],
      });
      if (!base) continue;
      const tried: { r: RouteResult; gw: Gateway | undefined }[] = [];
      const onPath = gatewaysOnPath(base.nodes, "dep");
      const baseClean = base.missed.length === 0 && new Set(base.nodes).size === base.nodes.length
        && maxReversal(base.nodes.map((n) => ap.xy[n])) <= 130;
      if (baseClean && onPath.length) {
        tried.push({ r: base, gw: onPath[0] });
      } else {
        const cands: Gateway[] = [];
        for (const gw of [...onPath.slice(0, 1), ...gws.slice(0, 4)]) {
          if (!cands.some((c) => c.r === gw.r)) cands.push(gw);
        }
        for (const gw of cands) {
          const r = route(ap, {
            start: stand.entry, goal: entry.node, goalFrom: (entry as Leg).next, via: t.via, ownRunway: own,
            startDir: goalDir && [-goalDir[0], -goalDir[1]],
            mustPass: gw.n,
          });
          if (r) tried.push({ r, gw });
        }
      }
      if (!tried.length) tried.push({ r: base, gw: undefined });
      const clean = tried.filter(({ r }) =>
        new Set(r.nodes).size === r.nodes.length && maxReversal(r.nodes.map((n) => ap.xy[n])) <= 130);
      let choices = clean.length ? clean : [{ r: base, gw: undefined as Gateway | undefined }];
      const baseGw = findGateway(ap, base.nodes, "dep");
      const close = choices.filter(({ r }) => r.length <= base.length * 1.05);
      if (close.length) choices = close;
      else if (baseGw && base.missed.length === 0) choices = [{ r: base, gw: undefined }];
      let best: PlanOption | null = null;
      let bestScore = Infinity;
      for (const { r, gw } of choices) {
        const loop = new Set(r.nodes).size < r.nodes.length;
        const score = r.length + r.missed.length * 4000 + (gw ? dist([stand.x, stand.y], gw.p) * 0.1 : 0)
          + (loop ? 1e6 : 0);
        if (best && bestScore <= score) continue;
        bestScore = score;
        const st = steps(ap, r, own);
        best = {
          template: t, entry, steps: st,
          line: [...[...standLine].reverse(), ...r.nodes.slice(1).map((n) => ap.xy[n])],
          length: r.length, missed: r.missed,
          summary: [`Spot ${stand.ref}`, ...st.map((s) => s.ref).filter(Boolean), `RWY ${req.runway}`].join(" → "),
          crossings: [...new Set(st.map((s) => s.crossing).filter((c): c is string => !!c))],
          crossAt: crossPoints(ap, r.nodes, own),
          gateway: gw
            ? { ref: gw.r, at: gw.p }
            : findGateway(ap, r.nodes, "dep") ?? (gws[0] ? { ref: gws[0].r, at: gws[0].p } : undefined),
        };
      }
      if (best) out.push(best);
    }
  }
  // collapse duplicates (two templates resolving to the same path)
  const uniq = out.filter((o, i) => out.findIndex((p) => p.summary === o.summary) === i);
  // nearest first, but a route that follows the published taxiways beats a shorter
  // one that skips them: that is the option the chips tag and the panel selects
  uniq.sort((a, b) => a.missed.length - b.missed.length || a.length - b.length);
  // a published route that comes out far longer than the nearest one is a detour,
  // not a variant: drop it instead of offering it
  const pool = uniq.some((o) => !o.missed.length) ? uniq.filter((o) => !o.missed.length) : uniq;
  const min = Math.min(...pool.map((o) => o.length));
  const result = uniq.filter((o) => o.length <= min * 1.35);
  if (cache.size > 500) cache.clear();
  cache.set(cacheKey, result);
  return result;
}

/** index of the recommended option: fewest skipped taxiways, then shortest */
export function bestIndex(opts: PlanOption[]): number {
  const key = (o: PlanOption) => o.missed.length * 1e6 + o.length;
  let bi = 0;
  opts.forEach((o, i) => {
    if (key(o) < key(opts[bi])) bi = i;
  });
  return bi;
}
