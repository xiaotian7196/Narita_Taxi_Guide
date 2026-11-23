// Downloads RJAA aeroway geometry from OpenStreetMap (ODbL) via Overpass.
// Usage: npm run fetch:osm   (then npm run build:data)
import { writeFileSync } from "node:fs";

const BBOX = "35.685,140.305,35.825,140.465";
const query = `[out:json][timeout:180];(
way["aeroway"~"taxiway|runway|apron|terminal|taxilane|parking_position|holding_position|stopway"](${BBOX});
node["aeroway"~"parking_position|gate|holding_position"](${BBOX});
);out geom;`;

// The main instance is frequently at capacity; try the mirrors in turn.
const MIRRORS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

let body = "";
for (const url of MIRRORS) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "rjaa-taxi-guide-script" },
      body: "data=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) { console.warn(`${url} -> HTTP ${res.status}`); continue; }
    const text = await res.text();
    const json = JSON.parse(text);
    if (!json.elements?.length) { console.warn(`${url} -> no elements`); continue; }
    body = text;
    console.log(`${url} -> ${json.elements.length} elements`);
    break;
  } catch (e) {
    console.warn(`${url} -> ${(e as Error).message}`);
  }
}
if (!body) throw new Error("all Overpass mirrors failed");
writeFileSync(new URL("../data/osm-rjaa.json", import.meta.url), body);
console.log("saved data/osm-rjaa.json");
