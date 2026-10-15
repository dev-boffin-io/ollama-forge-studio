'use strict';

/**
 * Runtime helpers that differ between "node server.js" and the single-file executable
 * (Node SEA). Embedded files are read with getAsset(); everything else is plain Node.
 */

let sea = null;
try {
  const s = require('node:sea');          // missing on Node < 20.12 → plain Node mode
  if (s.isSea()) sea = s;
} catch { /* not a single-executable build */ }

const isSea = () => !!sea;

/** Bytes of an asset embedded at build time (key = path under public/, e.g. "index.html"), or null. */
function getAsset(key) {
  if (!sea) return null;
  try { return Buffer.from(sea.getAsset('public/' + key)); } catch { return null; }
}

module.exports = { isSea, getAsset };
