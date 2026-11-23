// Builds src/data/rjaa.json from
//   - data/osm-rjaa.json      (OpenStreetMap aeroway geometry, ODbL)
//   - data/navdata/RJAA.dat   (runway thresholds from AIP Japan RJAA AD 2.12)
// Usage: npm run build:data
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ORIGIN = { lat: 35.76528, lon: 140.38556 }; // RJAA ARP (AIP Japan AD 2.2)

const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const toXY = (lat: number, lon: number): [number, number] => [
  +((lon - ORIGIN.lon) * M_PER_DEG_LON).toFixed(1),
  +((lat - ORIGIN.lat) * M_PER_DEG_LAT).toFixed(1),
];

// ---------- runway thresholds ----------
type Threshold = { ident: string; x: number; y: number; displacedFt: number };
function parseDms(s: string): number {
  // N35462780 / E140220585 -> hemisphere, deg, min, sec(2 decimals)
  const hemi = s[0];
  const body = s.slice(1);
  const degLen = hemi === "N" || hemi === "S" ? 2 : 3;
  const deg = +body.slice(0, degLen);
  const min = +body.slice(degLen, degLen + 2);
  const sec = +body.slice(degLen + 2) / 100;
  const v = deg + min / 60 + sec / 3600;
  return hemi === "S" || hemi === "W" ? -v : v;
}
const thresholds: Threshold[] = [];
const cifpPath = new URL("../data/navdata/RJAA.dat", import.meta.url);
if (!existsSync(cifpPath)) throw new Error("data/navdata/RJAA.dat missing");
for (const line of readFileSync(cifpPath, "utf8").split(/\r?\n/)) {
  if (!line.startsWith("RWY:")) continue;
  const [head, pos] = line.slice(4).split(";");
  const ident = head.split(",")[0].trim().replace(/^RW/, "");
  const [lat, lon, disp] = pos.split(",");
  const [x, y] = toXY(parseDms(lat.trim()), parseDms(lon.trim()));
  thresholds.push({ ident, x, y, displacedFt: +disp || 0 });
}
console.log("CIFP thresholds:", thresholds.map((t) => t.ident).join(" "));

// ---------- OSM ----------
type OsmNode = { type: "node"; id: number; lat: number; lon: number; tags?: Record<string, string> };
type OsmWay = {
  type: "way"; id: number; nodes: number[];
  geometry: { lat: number; lon: number }[]; tags: Record<string, string>;
};
const osm = JSON.parse(readFileSync(new URL("../data/osm-rjaa.json", import.meta.url), "utf8"))
  .elements as (OsmNode | OsmWay)[];
const ways = osm.filter((e): e is OsmWay => e.type === "way");
const pts = osm.filter((e): e is OsmNode => e.type === "node");

// Graph
const nodeXY: [number, number][] = [];
const osmToIdx = new Map<number, number>();
const refs: string[] = [""];
const refIdx = (r: string | undefined) => {
  const k = (r ?? "").trim();
  let i = refs.indexOf(k);
  if (i < 0) i = refs.push(k) - 1;
  return i;
};
type Edge = [number, number, number];
const edges: Edge[] = [];
const nodeOf = (osmId: number, lat: number, lon: number) => {
  let i = osmToIdx.get(osmId);
  if (i === undefined) {
    i = nodeXY.push(toXY(lat, lon)) - 1;
    osmToIdx.set(osmId, i);
  }
  return i;
};

const drawWays: { r: string; k: string; w: number; p: number[] }[] = [];
for (const w of ways) {
  const a = w.tags.aeroway;
  if (a !== "taxiway" && a !== "taxilane") continue;
  const r = refIdx(w.tags.ref);
  const idx = w.nodes.map((id, i) => nodeOf(id, w.geometry[i].lat, w.geometry[i].lon));
  for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1]) edges.push([idx[i - 1], idx[i], r]);
  drawWays.push({
    r: w.tags.ref ?? "",
    k: a,
    w: +(w.tags.width ?? 23) || 23,
    p: idx.flatMap((i) => nodeXY[i]),
  });
}

// ---------- geometry helpers ----------
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------- manual links ----------
// A runway crossing is sometimes drawn as two separate ways with a gap between
// them, which leaves the graph cut in half. Bridge those pairs by coordinate.
const nodeAt = (p: [number, number], tol = 4) => {
  let best = -1;
  let bd = tol;
  nodeXY.forEach((q, i) => {
    const d = dist(p, q);
    if (d <= bd) {
      bd = d;
      best = i;
    }
  });
  return best;
};
const LINKS: { a: [number, number]; b: [number, number]; r?: string }[] = [
  // filled in once the OSM geometry is known (see README)
];
for (const { a: p, b: q, r } of LINKS) {
  const a = nodeAt(p);
  const b = nodeAt(q);
  const joined = edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (a >= 0 && b >= 0 && a !== b && !joined) edges.push([a, b, refIdx(r)]);
}

function projectToEdges(p: [number, number]) {
  let best = { d: Infinity, e: -1, t: 0, q: [0, 0] as [number, number] };
  edges.forEach(([a, b], ei) => {
    const A = nodeXY[a], B = nodeXY[b];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2));
    const q: [number, number] = [A[0] + t * dx, A[1] + t * dy];
    const d = dist(p, q);
    if (d < best.d) best = { d, e: ei, t, q };
  });
  return best;
}
function splitEdgeAt(ei: number, t: number, q: [number, number]): number {
  const [a, b, r] = edges[ei];
  if (t < 0.02 || dist(q, nodeXY[a]) < 2) return a;
  if (t > 0.98 || dist(q, nodeXY[b]) < 2) return b;
  const n = nodeXY.push([+q[0].toFixed(1), +q[1].toFixed(1)]) - 1;
  edges[ei] = [a, n, r];
  edges.push([n, b, r]);
  return n;
}

// ---------- runways ----------
const RWY_PAIRS = [["16R", "34L"], ["16L", "34R"]];
const runways = RWY_PAIRS.map(([a, b]) => {
  const ta = thresholds.find((t) => t.ident === a)!;
  const tb = thresholds.find((t) => t.ident === b)!;
  // physical ends from OSM runway ways (thresholds may be displaced)
  const osmPts = ways
    .filter((w) => w.tags.aeroway === "runway" && w.tags.ref?.replace("-", "/") === `${a}/${b}`)
    .flatMap((w) => w.geometry.map((g) => toXY(g.lat, g.lon)));
  const ux = tb.x - ta.x, uy = tb.y - ta.y;
  const L = Math.hypot(ux, uy);
  const proj = (p: [number, number]) => ((p[0] - ta.x) * ux + (p[1] - ta.y) * uy) / L;
  const ts = osmPts.map(proj);
  const s0 = Math.min(0, ...ts), s1 = Math.max(L, ...ts);
  const at = (s: number): [number, number] => [+(ta.x + (ux * s) / L).toFixed(1), +(ta.y + (uy * s) / L).toFixed(1)];
  const width = +(ways.find((w) => w.tags.aeroway === "runway" && w.tags.ref === `${a}/${b}`)?.tags.width ?? 60) || 60;
  return {
    id: `${a}/${b}`,
    width,
    p0: at(s0), // physical end on the `a` side
    p1: at(s1),
    thr: { [a]: [ta.x, ta.y], [b]: [tb.x, tb.y] } as Record<string, [number, number]>,
    disp: { [a]: ta.displacedFt, [b]: tb.displacedFt } as Record<string, number>,
  };
});

// ---------- stands ----------
const taxiNodeIds = new Set(osmToIdx.keys());
type Stand = { ref: string; x: number; y: number; entry: number; path: number[]; group: string; src: string };
const standsByRef = new Map<string, Stand & { score: number }>();
const addStand = (s: Stand, score: number) => {
  const prev = standsByRef.get(s.ref);
  if (!prev || prev.score < score) standsByRef.set(s.ref, { ...s, score });
};
const connect = (p: [number, number]) => {
  const pr = projectToEdges(p);
  if (pr.d > 160) return null;
  return splitEdgeAt(pr.e, pr.t, pr.q);
};

for (const w of ways) {
  if (w.tags.aeroway !== "parking_position" || !w.tags.ref) continue;
  const xy = w.geometry.map((g) => toXY(g.lat, g.lon));
  const sharedI = w.nodes.findIndex((id) => taxiNodeIds.has(id));
  let entry: number | null;
  let line: [number, number][];
  if (sharedI >= 0) {
    entry = osmToIdx.get(w.nodes[sharedI])!;
    // walk away from the shared node towards the far end
    const far = sharedI < w.nodes.length / 2 ? xy.slice(sharedI) : xy.slice(0, sharedI + 1).reverse();
    line = far;
  } else {
    const p0 = projectToEdges(xy[0]).d, p1 = projectToEdges(xy[xy.length - 1]).d;
    const ordered = p0 <= p1 ? xy : [...xy].reverse();
    entry = connect(ordered[0]);
    if (entry === null) continue;
    line = [nodeXY[entry], ...ordered];
  }
  const stop = line[line.length - 1];
  addStand({ ref: w.tags.ref, x: stop[0], y: stop[1], entry: entry!, path: line.flat(), group: "", src: "way" }, sharedI >= 0 ? 3 : 2);
}
for (const n of pts) {
  if (n.tags?.aeroway !== "parking_position" || !n.tags.ref) continue;
  if (standsByRef.has(n.tags.ref)) continue;
  const p = toXY(n.lat, n.lon);
  const entry = connect(p);
  if (entry === null) continue;
  addStand({ ref: n.tags.ref, x: p[0], y: p[1], entry, path: [...nodeXY[entry], ...p], group: "", src: "node" }, 1);
}

// Terminal area classification: nearest terminal anchor. Narita's Terminal 2
// main building is not mapped as aeroway=terminal, so its anchors come from the
// building coordinates (Wikidata), together with the satellites.
const ANCHORS: { group: "T1" | "T2" | "T3"; lat: number; lon: number }[] = [
  { group: "T1", lat: 35.763972, lon: 140.384472 }, // Terminal 1 main
  { group: "T1", lat: 35.7726, lon: 140.3755 }, // Terminal 1 satellite (2xx gates)
  { group: "T2", lat: 35.773361, lon: 140.38775 }, // Terminal 2 main
  { group: "T2", lat: 35.7755, lon: 140.3925 }, // Terminal 2 satellite (4xx gates)
  { group: "T3", lat: 35.778639, lon: 140.384306 }, // Terminal 3
  { group: "T3", lat: 35.7811, lon: 140.3865 }, // Terminal 3 satellite
];
const anchorsXY = ANCHORS.map((a) => ({ group: a.group, p: toXY(a.lat, a.lon) }));
for (const s of standsByRef.values()) {
  let best = anchorsXY[0];
  let bd = Infinity;
  for (const a of anchorsXY) {
    const d = dist([s.x, s.y], a.p);
    if (d < bd) { bd = d; best = a; }
  }
  s.group = best.group;
}

// ---------- areas ----------
const poly = (w: OsmWay) => w.geometry.flatMap((g) => toXY(g.lat, g.lon));
const aprons = ways.filter((w) => w.tags.aeroway === "apron").map(poly);
const terminals = ways
  .filter((w) => w.tags.aeroway === "terminal")
  .map((w) => ({ n: w.tags["name:en"] ?? w.tags.name ?? "", p: poly(w) }));
const holds = pts
  .filter((n) => n.tags?.aeroway === "holding_position")
  .map((n) => ({ r: n.tags?.ref ?? "", p: toXY(n.lat, n.lon) }));

// Apron gateways: the "GWY" holding positions on the taxiing charts mark where
// the outer taxiway system meets the apron taxilanes, i.e. where Ramp Control
// takes over. Snap each to a graph node so the router can require it.
const gateways: { r: string; p: [number, number]; n?: number }[] = [];
const seenGateway = new Set<string>();
for (const n of pts) {
  const raw = n.tags?.ref ?? "";
  if (!/GWY/i.test(raw)) continue;
  const ref = raw.replace(/\s*GWY.*/i, "").split(";")[0].trim();
  if (!ref) continue;
  const p = toXY(n.lat, n.lon);
  const key = `${ref}@${p[0]},${p[1]}`;
  if (seenGateway.has(key)) continue;
  seenGateway.add(key);
  const node = nodeAt(p, 25);
  gateways.push(node >= 0 ? { r: ref, p, n: node } : { r: ref, p });
}

const stands = [...standsByRef.values()]
  .map(({ score: _s, src: _src, ...s }) => s)
  .sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }));

const out = {
  origin: ORIGIN,
  refs,
  nodes: nodeXY.flat(),
  edges: edges.flat(),
  ways: drawWays,
  runways,
  aprons,
  terminals,
  holds,
  gateways,
  stands,
};
writeFileSync(new URL("../src/data/rjaa.json", import.meta.url), JSON.stringify(out));
const groups = stands.reduce<Record<string, string[]>>((m, s) => ((m[s.group] ??= []).push(s.ref), m), {});
console.log(`nodes ${nodeXY.length}, edges ${edges.length}, stands ${stands.length}, gateways ${gateways.length}`);
for (const [g, l] of Object.entries(groups)) console.log(g, l.length, l.slice(0, 30).join(","));
