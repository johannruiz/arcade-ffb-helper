'use strict';
// The games load straight from GitHub Pages. GitHub Pages cannot send response
// headers, so the launcher adds cross-origin isolation (COOP/COEP) to the games
// that need SharedArrayBuffer (D2 / Scud threads). This makes their coi-sw.js
// service worker and its reload unnecessary. Bodies, requests and referrers are untouched.
const { GAMES, gameForUrl } = require('./games.cjs');

const PARTITION = 'persist:arcade-games';

// Same headers as plain object (used when the offline copy serves the files itself).
function isolationHeaders(game) {
  return game?.isolation ? {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': game.isolation,
    'cross-origin-resource-policy': 'cross-origin',
  } : {};
}

function installIsolation(ses) {
  ses.webRequest.onHeadersReceived((details, callback) => {
    const game = gameForUrl(details.url);
    if (!game?.isolation) return callback({});
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) if (/^cross-origin-(opener|embedder|resource)-policy$/i.test(k)) delete headers[k];
    headers['Cross-Origin-Opener-Policy'] = ['same-origin'];
    headers['Cross-Origin-Embedder-Policy'] = [game.isolation];
    headers['Cross-Origin-Resource-Policy'] = ['cross-origin'];
    callback({ responseHeaders: headers });
  });
}

module.exports = { installIsolation, isolationHeaders, PARTITION, GAMES };
