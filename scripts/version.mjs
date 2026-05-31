// version.mjs — pure semantic-version helpers for the auto-version workflow.
// No deps, no chrome, no I/O — unit-tested in test/version.test.js. The PR
// workflow feeds a commit subject (the PR title) to bumpType(), then applies
// the result to main's current version with nextVersion().

// Conventional-commit subject -> semver bump level, or null for "no release".
//   feat            -> minor
//   fix | perf      -> patch
//   `!` or BREAKING  -> major
//   anything else   -> null (docs, ci, chore, refactor, test, style, build, …)
export function bumpType(subject) {
  const s = String(subject).trim();
  // A "!" before the colon (feat!: / feat(scope)!:) or a BREAKING CHANGE token.
  if (/^[a-z]+(\([^)]*\))?!:/i.test(s) || /BREAKING[ -]CHANGE/.test(s)) {
    return 'major';
  }
  const m = s.match(/^([a-z]+)(\([^)]*\))?:/i);
  if (!m) {
    return null;
  }
  const type = m[1].toLowerCase();
  if (type === 'feat') {
    return 'minor';
  }
  if (type === 'fix' || type === 'perf') {
    return 'patch';
  }
  return null;
}

// Apply a bump to a "MAJOR.MINOR.PATCH" string, normalizing a 2-part "1.0" to
// three parts. Returns null for an unknown/none level.
export function nextVersion(current, level) {
  const p = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  let [major, minor, patch] = [p[0] || 0, p[1] || 0, p[2] || 0];
  if (level === 'major') {
    major += 1; minor = 0; patch = 0;
  } else if (level === 'minor') {
    minor += 1; patch = 0;
  } else if (level === 'patch') {
    patch += 1;
  } else {
    return null;
  }
  return `${major}.${minor}.${patch}`;
}
