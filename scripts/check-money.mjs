/**
 * MONEY GUARD.
 *
 *   npm run check:money
 *
 * Fails the build if float arithmetic reappears on a money path.
 *
 * The whole decimal migration is worth very little without this. The original
 * float handling was not a decision anybody made — it accumulated one
 * `Number(row.amount)` at a time, each individually reasonable, until twelve
 * hand-rolled epsilons were load-bearing and the ledger's balance check was a
 * tolerance. Nothing stopped that except noticing, and nobody noticed for the
 * life of the project.
 *
 * Implemented as a script rather than an ESLint rule on purpose: this repo has
 * no ESLint, and installing a whole toolchain plus a custom rule plugin to
 * express one grep is more machinery than the problem deserves. It matches the
 * existing convention — `e2e.mjs`, `security-test.mjs` and `backup.mjs` are all
 * bespoke check scripts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Directories where money is computed. Not the whole repo — presentation
 *  layers legitimately turn amounts into numbers for charts and JSON. */
const GUARDED = [
  "packages/core/src/services",
  "packages/core/src/uae",
];

/** The test harness asserts against plain numbers by design. */
const EXEMPT = new Set(["test.ts"]);

/**
 * Line-level escape hatch: `// money-guard-ignore: <reason>`.
 *
 * The rules below are deliberately blunt greps — `Number(` anywhere under
 * `services/` is a violation — because that bluntness is what makes them hard
 * to erode. But `services/` also holds code that parses things which are not
 * money at all (a role rank, a row count), and the honest fix there is neither
 * to launder the call into `parseInt` nor to add the whole file to EXEMPT,
 * which would blind the guard to every future money bug in it.
 *
 * So: exempt the single line, in the open, with a stated reason. A reason is
 * mandatory — a bare pragma does not suppress anything. Every use is one grep
 * away and has to survive review, which is the property EXEMPT lacks.
 */
const IGNORE = /\/\/\s*money-guard-ignore:\s*\S/;

const RULES = [
  {
    // `Number(` but not `M.toNumber(` / `.toNumber(` / `toNumber(`.
    pattern: /(?<![.\w])Number\s*\(/g,
    message: "Number() on a money path — read with M.fromDb() instead.",
  },
  {
    pattern: /(?<![.\w])parseFloat\s*\(/g,
    message: "parseFloat() on a money path — read with M.fromDb() instead.",
  },
  {
    // Storage-precision serialisation must go through toDb so rounding mode is
    // decided in one place.
    pattern: /\.toFixed\s*\(\s*4\s*\)/g,
    message: ".toFixed(4) writes storage precision directly — use M.toDb().",
  },
  {
    // The epsilons this migration existed to delete.
    pattern: /[<>]=?\s*0\.0(0[0-9]+|[0-9])\b|\+\s*0\.0(0[0-9]+|[0-9])\b/g,
    message: "Looks like a float tolerance. Compare exactly, or quantize first.",
  },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** Strip comments so prose describing the old code is not itself a violation. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

let violations = 0;
let ignored = 0;
for (const dir of GUARDED) {
  for (const file of walk(dir)) {
    const name = file.split("/").pop();
    if (EXEMPT.has(name)) continue;

    const source = readFileSync(file, "utf8");
    // The pragma has to be read off the raw line: stripComments blanks it out
    // before the rules ever see it.
    const raw = source.split("\n");
    const lines = stripComments(source).split("\n");
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          if (IGNORE.test(raw[i])) {
            ignored++;
            return;
          }
          violations++;
          console.error(`  ✗ ${file}:${i + 1}\n      ${rule.message}\n      ${line.trim()}`);
        }
      }
    });
  }
}

if (violations > 0) {
  console.error(`\n✗ ${violations} money-path violation(s).\n`);
  process.exit(1);
}
const suffix = ignored > 0 ? ` ${ignored} line(s) explicitly ignored.` : "";
console.log(`✓ No float arithmetic on money paths (${GUARDED.join(", ")}).${suffix}`);
