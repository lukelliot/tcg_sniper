// bump-manifest.mjs — surgically bump extension/manifest.json's version based
// on a conventional-commit subject. Driven by the PR version-bump workflow.
//
//   env PR_TITLE      the commit subject to classify (the PR title)
//   env BASE_VERSION  main's current version (the bump baseline); falls back to
//                     the file's own version when unset
//
// Computes target = nextVersion(BASE_VERSION) and writes it ONLY if the file is
// not already there — so re-running on the same PR branch never double-bumps.
// The version string is replaced in place to preserve the file's formatting.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bumpType, nextVersion } from './version.mjs';

const subject = process.env.PR_TITLE || '';
const path = fileURLToPath(new URL('../extension/manifest.json', import.meta.url));
const text = readFileSync(path, 'utf8');
const current = (text.match(/"version":\s*"([^"]+)"/) || [])[1];
const base = process.env.BASE_VERSION || current;

const level = bumpType(subject);
if (!level) {
  console.log(`NOBUMP: "${subject}" has no feat/fix/breaking prefix`);
  process.exit(0);
}

const target = nextVersion(base, level);
if (current === target) {
  console.log(`NOBUMP: already at ${target}`);
  process.exit(0);
}

writeFileSync(path, text.replace(/("version":\s*")[^"]+(")/, `$1${target}$2`));
console.log(`BUMPED ${current} -> ${target} (base ${base}, ${level})`);
