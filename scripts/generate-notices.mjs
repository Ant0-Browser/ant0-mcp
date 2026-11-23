#!/usr/bin/env node
/**
 * Write THIRD_PARTY_NOTICES for the npm package: the licence and notice files of the direct
 * runtime dependencies, copied unchanged from the installed packages (run `pnpm install` first).
 *
 *   node scripts/generate-notices.mjs           # write
 *   node scripts/generate-notices.mjs --check   # exit 1 if the committed file is stale
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "THIRD_PARTY_NOTICES");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const licenceFile = (n) => /^(licen[sc]e|notice|copying)([.-].*)?$/i.test(n);

const parts = [
  "THIRD-PARTY NOTICES\n\nThis package depends on the packages below; npm installs them next to it. Each\npackage's licence and notice files follow, copied unchanged from the package.\n",
];
for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
  const dir = realpathSync(join(root, "node_modules", name));
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const files = readdirSync(dir)
    .filter((n) => licenceFile(n) && statSync(join(dir, n)).isFile())
    .sort();
  if (files.length === 0) throw new Error(`no licence file for ${name}`);
  const license =
    typeof manifest.license === "string" ? manifest.license : JSON.stringify(manifest.license);
  parts.push(`\n${"=".repeat(78)}\n${name}@${manifest.version} (${license})\n${"=".repeat(78)}\n`);
  for (const n of files) {
    const text = readFileSync(join(dir, n), "utf8").replace(/\r\n/g, "\n").trimEnd();
    parts.push(`\n--- ${n} ---\n\n${text}\n`);
  }
}
const text = parts.join("");
if (process.argv.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) {
    console.error("THIRD_PARTY_NOTICES is stale; run pnpm generate:notices");
    process.exit(1);
  }
} else {
  writeFileSync(out, text);
}
