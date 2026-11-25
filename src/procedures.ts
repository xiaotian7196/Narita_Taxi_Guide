// Standard taxi logic for RJAA (Narita), after AIP Japan RJAA AD 2.22 (V)
// "Standard Taxiing Routes" and the Taxiing Charts (RJAA AD 2.20).
//
// Departures: the AIP names four standard routes and instructs them by name
// (RJAA AD 2.22 (V), AIP effective 3 Sep 2026):
//   ROUTE 7  (to 16R) K, S6, C, W, W7 and A
//   ROUTE 8  (to 34L) C, S7, K and A
//   ROUTE 9  (to 16L) A, K, S6, C and B
//   ROUTE 10 (to 34R) A, S, C, S7 and K
// Arrivals are not named in the AIP: the Taxiing Charts show the flow from the
// runway to the apron gateways, and Ramp Control assigns the route from the
// gateway to the stand.
//
// ATC instructions always take precedence.
import type { Group } from "./airport.ts";
import type { Text } from "./i18n.ts";

export type FlowId = "S" | "N";
export interface Flow {
  id: FlowId;
  name: Text;
  arr: string[];
  dep: string[];
}
export const FLOWS: Flow[] = [
  { id: "S", name: { en: "South wind (16)", ja: "南風運用（16）" }, arr: ["16R", "16L"], dep: ["16L", "16R"] },
  { id: "N", name: { en: "North wind (34)", ja: "北風運用（34）" }, arr: ["34L", "34R"], dep: ["34R", "34L"] },
];

export interface Template {
  via: string[];
  /** departure: runway entry / holding point taxiway */
  entry?: string;
  note?: Text;
  /** arrival: recommended turn-off side */
  side?: "L" | "R";
  flows?: FlowId[];
  /** the published taxiways must be flown even when a direct line is shorter */
  strict?: boolean;
  /** arrival: only for stands whose number is inside one of these inclusive ranges */
  stands?: [number, number][];
}
type Table = Record<string, Partial<Record<Group, Template[]>>>;

// Arrivals: the taxiing charts run arrivals up the runway-parallel taxiway (A
// for 16R/34L, B for 16L/34R) and then into the apron. No route is named, so
// only the runway-parallel taxiway is required; the router joins it to the
// stand along the shortest sensible path.
export const ARRIVALS: Table = {
  "16R": {
    T1: [{ via: ["A"], side: "L" }],
    T2: [{ via: ["A"], side: "L" }],
    T3: [{ via: ["A"], side: "L" }],
  },
  "34L": {
    T1: [{ via: ["A"], side: "R" }],
    T2: [{ via: ["A"], side: "R" }],
    T3: [{ via: ["A"], side: "R" }],
  },
  "16L": {
    T1: [{ via: [], side: "R" }],
    T2: [{ via: [], side: "R" }],
    T3: [{ via: [], side: "R" }],
  },
  "34R": {
    T1: [{ via: [], side: "L" }],
    T2: [{ via: [], side: "L" }],
    T3: [{ via: [], side: "L" }],
  },
};

// Departures: the AIP standard route is named in the note. The named route
// starts at the apron gateway; Ramp Control assigns the movement from the stand
// to it, so the guide only constrains the movement-area part it can apply to
// every stand: the runway-parallel taxiway (A for 16R/34L, B for 16L/34R) and,
// on ROUTE 9, the published C → B tail. Pinning the whole published sequence
// would drag stands that join it late round the apron.
export const DEPARTURES: Table = {  "16R": {
    T1: [{ via: ["A"], entry: "A1", note: { en: "ROUTE 7 · full length at A1", ja: "ROUTE 7 · A1 で全長離陸" } }],
    T2: [{ via: ["C", "W", "W7", "A"], entry: "A1", note: { en: "ROUTE 7 · C, W, W7, A · full length at A1", ja: "ROUTE 7 · C, W, W7, A · A1 で全長離陸" } }],
    T3: [{ via: ["C", "W", "W7", "A"], entry: "A1", note: { en: "ROUTE 7 · C, W, W7, A · full length at A1", ja: "ROUTE 7 · C, W, W7, A · A1 で全長離陸" } }],
  },
  "34L": {
    T1: [{ via: ["A"], entry: "A10", note: { en: "ROUTE 8 · full length at A10", ja: "ROUTE 8 · A10 で全長離陸" } }],
    T2: [{ via: ["A"], entry: "A10", note: { en: "ROUTE 8 · full length at A10", ja: "ROUTE 8 · A10 で全長離陸" } }],
    T3: [{ via: ["C", "S7", "K", "A"], entry: "A10", note: { en: "ROUTE 8 · C, S7, K, A · full length at A10", ja: "ROUTE 8 · C, S7, K, A · A10 で全長離陸" } }],
  },
  "16L": {
    T1: [{ via: ["C", "B"], entry: "B1", note: { en: "ROUTE 9 · C, B · full length at B1", ja: "ROUTE 9 · C, B · B1 で全長離陸" } }],
    T2: [{ via: ["C", "B"], entry: "B1", note: { en: "ROUTE 9 · C, B · full length at B1", ja: "ROUTE 9 · C, B · B1 で全長離陸" } }],
    T3: [{ via: ["C", "B"], entry: "B1", note: { en: "ROUTE 9 · C, B · full length at B1", ja: "ROUTE 9 · C, B · B1 で全長離陸" } }],
  },
  "34R": {
    T1: [{ via: [], entry: "B9", note: { en: "ROUTE 10 · full length at B9", ja: "ROUTE 10 · B9 で全長離陸" } }],
    T2: [{ via: [], entry: "B9", note: { en: "ROUTE 10 · full length at B9", ja: "ROUTE 10 · B9 で全長離陸" } }],
    T3: [{ via: [], entry: "B9", note: { en: "ROUTE 10 · full length at B9", ja: "ROUTE 10 · B9 で全長離陸" } }],
  },
};

/**
 * Low-visibility operations (AIP RJAA AD 2.20 2.11/2.12 and AD 2.22 LVTO):
 * CAT II/III taxi routes are published for runway 16R, LVTO entries are A1/A2,
 * and the designated CAT III turn-offs are A6/A7.
 */
export const LVP = {
  runway: "16R",
  exits: ["A6", "A7"],
  entries: ["A1", "A2"],
};

export function templates(table: Table, rwy: string, group: Group, flow: FlowId): Template[] {
  const list = (table[rwy]?.[group] ?? []).filter((t) => !t.flows || t.flows.includes(flow));
  return list.length ? list : [{ via: [], note: { en: "No published route; shortest path used", ja: "標準ルートなし · 最短経路を使用" } }];
}

/**
 * Arrival exits that are taxied to the end of their own taxiway before turning
 * off, instead of taking the first connector. Narita's normal turn-offs (A6/A7
 * on runway A, B6/B7 on runway B) are short connectors, so this is empty.
 */
export const EXIT_RUNOUT = new Set<string>();
