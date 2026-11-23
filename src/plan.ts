// Turns a user selection into one routed option per published template.
import { dist, type Airport, type Exit, type Leg, type XY } from "./airport.ts";
import { ARRIVALS, DEPARTURES, templates, type FlowId, type Template } from "./procedures.ts";
import { route, steps, type RouteResult, type Step } from "./router.ts";

export interface PlanRequest {
  mode: "arr" | "dep";
  flow: FlowId;
  runway: string;
  stand: string;
  /** arrival: exit key `${ref}${side}`; departure: entry taxiway ref */
  point?: string;
}
type Gateway = { r: string; p: XY; n?: number };

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
  const cacheKey = `${req.mode}|${req.flow}|${req.runway}|${req.stand}|${req.point ?? ""}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

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
      .filter((x) => x.d <= 2600)
      .sort((a, b) => a.d - b.d);
    const seen = new Set<string>();
    const list: typeof all = [];
    for (const { g } of near) {
      if (seen.has(g.r)) continue;
      seen.add(g.r);
      list.push(g);
      if (list.length >= 3) break;
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
      // a stand is only ever served from its own side of the runway
      const standSide = ap.sideOf(req.runway, [stand.x, stand.y]);
      const sameSide = candidates.filter((e) => e.side === standSide);
      if (sameSide.length) candidates = sameSide;
      if (!req.point && t.side && candidates.some((e) => e.side === t.side)) candidates = candidates.filter((e) => e.side === t.side);
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
          // Prefer the gateway the natural path already passes; only reroute when
          // it passes none. This keeps the taxi sensible while making the gateway
          // a real waypoint.
          const tried: { r: RouteResult; gw: Gateway | undefined }[] = [];
          const onPath = gatewaysOnPath(base.nodes, "arr");
          if (onPath.length) tried.push({ r: base, gw: onPath[0] });
          for (const gw of gws.slice(0, 2)) {
            if (onPath.some((o) => o.r === gw.r)) continue;
            const r = route(ap, {
              start: exit.node, firstHop: exit.next, goal: stand.entry, via: t.via, ownRunway: own,
              goalDir, avoidRefs: avoid, mustPass: gw.n,
            });
            if (r) tried.push({ r, gw });
          }
          for (const { r, gw } of tried) {
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
              gateway: gw ? { ref: gw.r, at: gw.p } : findGateway(ap, r.nodes, "arr"),
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
      const want = req.point ?? t.entry;
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
      if (onPath.length) tried.push({ r: base, gw: onPath[0] });
      for (const gw of gws.slice(0, 2)) {
        if (onPath.some((o) => o.r === gw.r)) continue;
        const r = route(ap, {
          start: stand.entry, goal: entry.node, goalFrom: (entry as Leg).next, via: t.via, ownRunway: own,
          startDir: goalDir && [-goalDir[0], -goalDir[1]],
          mustPass: gw.n,
        });
        if (r) tried.push({ r, gw });
      }
      if (!tried.length) tried.push({ r: base, gw: undefined });
      let best: PlanOption | null = null;
      let bestScore = Infinity;
      for (const { r, gw } of tried) {
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
          gateway: gw ? { ref: gw.r, at: gw.p } : findGateway(ap, r.nodes, "dep"),
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
