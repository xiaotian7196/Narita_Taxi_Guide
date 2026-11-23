// Copies only the nav data this project needs out of X-Plane 12 "Custom Data"
// into data/navdata/, so the rest of the pipeline never touches the sim install.
//
//   data/navdata/RJAA.dat   RWY: records of CIFP/RJAA.dat (runway thresholds)
//   data/navdata/cycle.json AIRAC cycle the extract was taken from
//
// Usage: pnpm extract:navdata "<path to X-Plane 12/Custom Data>"
//        (or set XPLANE_CUSTOM_DATA)
//
// Narita's published thresholds have no displacement, so the checked-in RJAA.dat
// was taken from AIP Japan AD 2.12 instead; this script is for refreshing it
// from an AIRAC cycle.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CUSTOM_DATA =
  process.argv[2] ??
  process.env.XPLANE_CUSTOM_DATA ??
  "K:/SteamLibrary/steamapps/common/X-Plane 12/Custom Data";
const ICAO = "RJAA";

const cifp = `${CUSTOM_DATA}/CIFP/${ICAO}.dat`;
if (!existsSync(cifp)) {
  console.error(`Not found: ${cifp}\nPass the X-Plane 12 "Custom Data" folder as an argument.`);
  process.exit(1);
}

const rwy = readFileSync(cifp, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.startsWith("RWY:"));
if (!rwy.length) throw new Error(`no RWY records in ${cifp}`);

let cycle: Record<string, string> = {};
try {
  const c = JSON.parse(readFileSync(`${CUSTOM_DATA}/cycle.json`, "utf8"));
  cycle = { cycle: c.cycle, revision: c.revision, validityPeriod: c.validityPeriod, provider: c.provider };
} catch {
  /* cycle.json is optional */
}

const out = new URL("../data/navdata/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL(`${ICAO}.dat`, out), rwy.join("\n") + "\n");
writeFileSync(new URL("cycle.json", out), JSON.stringify({ airport: ICAO, ...cycle, records: rwy.length }, null, 2) + "\n");
console.log(`data/navdata/${ICAO}.dat: ${rwy.length} runway records (AIRAC ${cycle.cycle ?? "?"})`);
