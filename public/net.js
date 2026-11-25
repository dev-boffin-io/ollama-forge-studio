/* Network shim — loaded before every other script.
 *
 * Adds `X-Studio-Client: web` to every request the page sends to its OWN server (uploads, chat stream, API calls, shutdown …).
 * A custom header makes the browser run a CORS preflight for any other website, and the studio never grants one, so the server
 * can treat a request carrying it as "made by the studio's own page" (see lib/guard.js). That proof does not depend on the
 * Origin / Host / Sec-Fetch-Site strings, which are exactly what differ when the UI is opened from a phone or another PC on the
 * LAN, through a reverse proxy, an SSH/port-forward tunnel or a hostname alias.
 */
(function () {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window.fetch.__studioClient) return;
  const native = window.fetch.bind(window);
  const ownOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };

  function studioFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      if (url && ownOrigin(url)) {
        const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
        if (!headers.has('X-Studio-Client')) headers.set('X-Studio-Client', 'web');
        return native(input, { ...(init || {}), headers });
      }
    } catch { /* fall through to the untouched request */ }
    return native(input, init);
  }
  studioFetch.__studioClient = true;
  window.fetch = studioFetch;
})();
