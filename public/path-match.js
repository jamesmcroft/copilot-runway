// Path-segment matching for project filters. Works in browser and Node so
// the same predicate is used client-side, server-side, and from tests.
//
// A session cwd is "within" a project path when:
//   * the two paths are identical (after normalization), OR
//   * cwd starts with project + a path separator.
// This avoids the bug where "C:\src\foo" naively matches sessions under
// "C:\src\foo-bar" (issue #32).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PathMatch = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function looksWindows(a, b) {
    return /\\/.test(a) || /\\/.test(b) || /^[A-Za-z]:/.test(a) || /^[A-Za-z]:/.test(b);
  }

  function normalize(p, winLike) {
    let s = String(p).replace(/[\\/]+$/, '');
    if (winLike) {
      // Collapse both separators so mixed-style paths (git often emits
      // forward slashes on Windows) compare cleanly.
      s = s.replace(/\\/g, '/').toLowerCase();
    }
    return s;
  }

  function isPathWithinProject(cwd, project) {
    if (!cwd || !project) return false;
    const winLike = looksWindows(cwd, project);
    const c = normalize(cwd, winLike);
    const p = normalize(project, winLike);
    if (!c || !p) return false;
    if (c === p) return true;
    if (winLike) {
      return c.startsWith(p + '/');
    }
    return c.startsWith(p + '\\') || c.startsWith(p + '/');
  }

  return { isPathWithinProject };
});
