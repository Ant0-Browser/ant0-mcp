#!/usr/bin/env node
/**
 * Build out/ant0-<version>.mcpb with the pinned official CLI (`@anthropic-ai/mcpb`) and write
 * out/SHA256SUMS. Not signed: the signature is made separately over SHA256SUMS.
 *
 * Run `pnpm build` first. The server is bundled with esbuild into two files so the bundle needs
 * no node_modules: server/ant0-mcp.js and server/output-worker.js (the isolated stdout writer
 * the server starts next to itself).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, "out/stage");
const outFile = join(root, "out", `ant0-${pkg.version}.mcpb`);

rmSync(join(root, "out"), { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { "ant0-mcp": "dist/bin.js", "output-worker": "dist/output-worker.js" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outdir: join(stage, "server"),
  minify: false,
  legalComments: "inline",
  metafile: true,
  logLevel: "warning",
  banner: {
    js: 'import { createRequire as __ant0CreateRequire } from "node:module"; const require = __ant0CreateRequire(import.meta.url);',
  },
});
writeFileSync(join(stage, "server/package.json"), '{ "type": "module" }\n');

const { TOOLS } = await import(pathToFileURL(join(root, "dist/tools.js")).href);
const tools = TOOLS.map((tool) => ({
  name: tool.name,
  description: firstSentence(tool.description),
})).sort((x, y) => x.name.localeCompare(y.name));
/** First sentence of a description, at most 200 characters; cut at a word boundary with an ellipsis only if needed. */
export function firstSentence(text, max = 200) {
  const flat = text.replace(/\s+/g, " ").trim();
  const protectedText = flat.replace(/\b(e\.g|i\.e|etc|vs)\./gi, (m) => m.replace(".", "\u0000"));
  const m = /^(.+?[.!?])(\s|$)/s.exec(protectedText);
  const sentence = (m ? m[1] : protectedText).replaceAll("\u0000", ".");
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:(\-]+$/, "")}\u2026`;
}
writeFileSync(
  join(stage, "manifest.json"),
  readFileSync(join(root, "manifest.template.json"), "utf8")
    .replace("__VERSION__", pkg.version)
    .replace("__TOOLS__", JSON.stringify(tools, null, 2)),
);
writeFileSync(join(stage, "THIRD_PARTY_NOTICES"), thirdPartyNotices(result.metafile));
for (const f of ["LICENSE", "README.md"]) {
  writeFileSync(join(stage, f), readFileSync(join(root, f)));
}

const mcpb = join(root, "node_modules/.bin/mcpb");
execFileSync(mcpb, ["pack", stage, outFile], { stdio: "inherit" });

const sum = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(join(root, "out/SHA256SUMS"), `${sum(outFile)}  ant0-${pkg.version}.mcpb\n`);
console.log(`${outFile} ${statSync(outFile).size} bytes`);
console.log(readdirSync(join(stage, "server")).join(", "));

/**
 * Licence texts of every package whose code ended up in the bundle, found from the metafile
 * (nothing is hand-listed):
 *  1. packages whose files esbuild inlined (their LICENSE/NOTICE files are copied whole), and
 *  2. packages that an inlined dependency had already compiled into its own dist files. These are
 *     found from the source map next to each inlined file (for example the MCP SDK ships ajv,
 *     ajv-formats, fast-uri and others inside its dist). Their licence texts are kept in
 *     licenses/vendored/<name>@<version>/; the build fails if one is missing.
 */
function thirdPartyNotices(metafile) {
  /** @type {Map<string, {name: string; version: string; license: string; dir: string}>} */
  const packages = new Map();
  /** @type {Map<string, {name: string; version: string}>} */
  const vendored = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.split("/").includes("node_modules")) continue;
    const file = realpathSync(resolve(root, input));
    let dir = dirname(file);
    for (;;) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const p = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof p.name === "string" && typeof p.version === "string") {
          const license = typeof p.license === "string" ? p.license : JSON.stringify(p.license);
          packages.set(`${p.name}@${p.version}`, {
            name: p.name,
            version: p.version,
            license,
            dir,
          });
          break;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`no package.json for bundled input ${input}`);
      dir = parent;
    }
    if (existsSync(`${file}.map`)) {
      const map = JSON.parse(readFileSync(`${file}.map`, "utf8"));
      for (const source of map.sources ?? []) {
        const m = /node_modules\/\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@([^/_]+)[^/]*\/node_modules\//.exec(
          source,
        );
        if (m)
          vendored.set(`${m[1].replace("+", "/")}@${m[2]}`, {
            name: m[1].replace("+", "/"),
            version: m[2],
          });
      }
    }
  }
  for (const key of vendored.keys()) if (packages.has(key)) vendored.delete(key);
  const parts = [
    "THIRD-PARTY NOTICES\n\nThe files in server/ include code from the packages below. Each package's\nlicence and notice files follow, copied unchanged from the package.\n",
  ];
  const licenceFile = (n) => /^(licen[sc]e|notice|copying)([.-].*)?$/i.test(n);
  const emit = (key, license, dir) => {
    const files = readdirSync(dir)
      .filter((n) => licenceFile(n) && statSync(join(dir, n)).isFile())
      .sort();
    if (files.length === 0) throw new Error(`no licence file for bundled package ${key}`);
    parts.push(`\n${"=".repeat(78)}\n${key}${license ? ` (${license})` : ""}\n${"=".repeat(78)}\n`);
    for (const n of files) {
      const text = readFileSync(join(dir, n), "utf8").replace(/\r\n/g, "\n").trimEnd();
      parts.push(`\n--- ${n} ---\n\n${text}\n`);
    }
  };
  const all = [
    ...[...packages].map(([key, p]) => [key, p.license, p.dir]),
    ...[...vendored].map(([key]) => {
      const dir = join(root, "licenses/vendored", key.replace("/", "__"));
      if (!existsSync(dir))
        throw new Error(`missing licence text for bundled package ${key}: add ${dir}`);
      return [key, readFileSync(join(dir, "spdx.txt"), "utf8").trim(), dir];
    }),
  ].sort((x, y) => x[0].localeCompare(y[0]));
  for (const [key, license, dir] of all) emit(key, license, dir);
  console.log(`third-party packages: ${all.map((x) => x[0]).join(", ")}`);
  return parts.join("");
}
