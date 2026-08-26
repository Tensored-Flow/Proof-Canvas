import fs from "node:fs";
import path from "node:path";

if (process.argv.length !== 3) {
  throw new Error("usage: sanitize-browser-report.mjs REPORT_JSON");
}

const reportPath = path.resolve(process.argv[2]);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const runtimePrefixes = [
  [path.resolve(process.cwd()) + path.sep, "repo:/"],
  [path.resolve(process.env.PROOFCANVAS_PARITY_EVIDENCE_DIR ?? "/evidence") + path.sep, "evidence:/"],
];

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  if (typeof value !== "string") return value;
  return runtimePrefixes.reduce(
    (text, [prefix, replacement]) => text.split(prefix).join(replacement),
    value,
  );
}

const sanitized = JSON.stringify(sanitize(report), null, 2) + "\n";
const ownerPassword = process.env.PROOFCANVAS_PARITY_OWNER_PASSWORD;
if (ownerPassword && sanitized.includes(ownerPassword)) {
  throw new Error("refusing to retain a browser report containing the parity password");
}
fs.writeFileSync(reportPath, sanitized, { encoding: "utf8", mode: 0o600 });
