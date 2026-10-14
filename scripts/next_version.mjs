/** Stable `x.y.z` from the package version Changesets maintains. */
export function stableVersion(version) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error(`base version must be stable x.y.z, received ${version}`);
  }
  return version;
}

/**
 * Prerelease identifier for `x.y.z-next.<id>`.
 * A short sha that is only digits and starts with 0 is not a semver
 * identifier, so the id grows until it is legal.
 */
export function prereleaseId(sha) {
  const hex = sha.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(hex)) {
    throw new Error("sha must be 7 to 40 hex characters");
  }
  for (let length = 7; length <= hex.length; length += 1) {
    const id = hex.slice(0, length);
    if (!/^0\d*$/.test(id)) return id;
  }
  throw new Error("sha cannot form a semantic version identifier");
}

/** `x.y.z-next.<shortsha>`, the npm `next` tag version from F1 §3. */
export function nextVersion(version, sha) {
  return `${stableVersion(version)}-next.${prereleaseId(sha)}`;
}
