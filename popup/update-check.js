// GitHub release metadata is treated as untrusted input. Only accept stable
// semantic versions and build links from fixed project URLs.
(function attachUpdateChecker(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmoothBoostUpdates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createUpdateChecker() {
  const OWNER = 'BiniFn';
  const REPOSITORY = 'SmoothBoost';
  const RELEASES_API_URL = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases/latest`;

  function parseVersion(value) {
    if (typeof value !== 'string') return null;
    const match = /^v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
    if (!match) return null;
    return match.slice(1).map(Number);
  }

  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return null;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function createResult(currentVersion, latestVersion, hasZip) {
    const comparison = compareVersions(latestVersion, currentVersion);
    if (comparison === null) return null;

    const version = parseVersion(latestVersion).join('.');
    const tag = `v${version}`;
    const result = {
      currentVersion,
      latestVersion: version,
      hasZip: Boolean(hasZip),
      releaseUrl: `https://github.com/${OWNER}/${REPOSITORY}/releases/tag/${tag}`,
      status: comparison > 0 ? (hasZip ? 'update' : 'update-without-zip') : (comparison < 0 ? 'ahead' : 'current')
    };

    if (comparison > 0 && hasZip) {
      result.downloadUrl = `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${tag}/SmoothBoost-${version}.zip`;
    }
    return result;
  }

  function fromRelease(currentVersion, release) {
    if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null;
    const parsedTag = parseVersion(release.tag_name);
    if (!parsedTag) return null;
    const latestVersion = parsedTag.join('.');
    const expectedAsset = `SmoothBoost-${latestVersion}.zip`;
    const hasZip = Array.isArray(release.assets)
      && release.assets.some((asset) => asset && asset.name === expectedAsset);
    return createResult(currentVersion, latestVersion, hasZip);
  }

  function fromCache(currentVersion, cached) {
    if (!cached || typeof cached !== 'object' || typeof cached.checkedAt !== 'number') return null;
    const latestVersion = parseVersion(cached.latestVersion);
    if (!latestVersion || typeof cached.hasZip !== 'boolean') return null;
    return createResult(currentVersion, latestVersion.join('.'), cached.hasZip);
  }

  return { RELEASES_API_URL, compareVersions, fromCache, fromRelease, parseVersion };
});
