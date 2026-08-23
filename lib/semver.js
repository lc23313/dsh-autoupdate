// Dependency-free SemVer parsing and comparison (the subset this plugin needs).
// Kept local on purpose: "zero runtime dependencies" is a core stability
// requirement for surviving dsh's breaking updates (see docs/COMPATIBILITY.zh.md).

const RE =
  /^(?:v|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a version string into components, or null when unusable. */
export function parse(version) {
  if (typeof version !== "string") return null;
  const m = RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split("."),
    raw: version.trim(),
  };
}

/** Whether a version string is valid SemVer. */
export function valid(version) {
  return parse(version) !== null;
}

function cmpNum(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function cmpPrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  // A version without prerelease outranks one with a prerelease.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const c = cmpNum(Number(x), Number(y));
      if (c !== 0) return c;
    } else if (xn) return -1; // numeric identifiers sort lower than alphanumeric
    else if (yn) return 1;
    else {
      const c = x < y ? -1 : x > y ? 1 : 0;
      if (c !== 0) return c;
    }
  }
  return 0;
}

/** Full SemVer comparison: -1 / 0 / +1. Throws on invalid input. */
export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`compare: invalid version ${!pa ? String(a) : String(b)}`);
  for (const k of ["major", "minor", "patch"]) {
    const c = cmpNum(pa[k], pb[k]);
    if (c !== 0) return c;
  }
  return cmpPrerelease(pa.prerelease, pb.prerelease);
}

export const gt = (a, b) => compare(a, b) > 0;
export const eq = (a, b) => compare(a, b) === 0;
