/** Validate package.json against the Pi package contract. Exits non-zero on a violation. */
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const problems = [];

const add = (msg) => problems.push(msg);

if (!pkg.keywords?.includes("pi-package")) {
  add('keywords must include "pi-package": it is the gallery discovery gate');
}
if (!pkg.pi?.extensions?.length) add('"pi.extensions" must list the entry point');
if (!pkg.license) add("missing license");
if (!pkg.description) add("missing description");
if ((pkg.description ?? "").length > 250) add("description is long; npm truncates it in listings");
if (pkg.private === true) add('"private": true blocks publishing');

// Pi supplies these at runtime; listing them as dependencies creates duplicate module graphs.
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  if (dep.startsWith("@earendil-works/") || dep === "typebox") {
    add(`${dep} must be a peerDependency, not a dependency`);
  }
}
for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
  if (pkg.peerDependencies?.[peer] !== "*") add(`${peer} must be a peerDependency with range "*"`);
}

const entry = pkg.pi?.extensions?.[0];
if (entry && !existsSync(new URL(`../${entry}`, import.meta.url))) {
  add(`entry point ${entry} does not exist`);
}

for (const problem of problems) console.log(`  \u001b[31mFAIL\u001b[0m ${problem}`);
process.exit(problems.length > 0 ? 1 : 0);
