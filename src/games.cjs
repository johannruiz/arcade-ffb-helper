'use strict';
// Catalog of the arcade games. Each one is loaded from its published GitHub Pages
// version (always the latest release), never from local builds.
const GAMES = [
  {
    id: 'd1',
    title: 'Daytona USA',
    subtitle: 'Sega Model 2 · 1994',
    accent: '#e8352b',
    url: 'https://johannruiz.github.io/Daytona-USA-Web-multiplayer-test/',
    repo: 'https://github.com/johannruiz/Daytona-USA-Web-multiplayer-test',
    // No threads: no cross-origin isolation (keeps PeerJS/Firebase working as on Pages).
    isolation: null,
  },
  {
    id: 'd2',
    title: 'Daytona USA 2',
    subtitle: 'Sega Model 3 Step 2.1 · 1998',
    accent: '#1e7bff',
    url: 'https://johannruiz.github.io/daytona-usa-2-web/',
    repo: 'https://github.com/johannruiz/daytona-usa-2-web',
    isolation: 'credentialless',
  },
  {
    id: 'scud',
    title: 'Scud Race',
    subtitle: 'Sega Model 3 Step 1.5 · 1996',
    accent: '#ffb000',
    url: 'https://johannruiz.github.io/scudrace-plus-web/',
    repo: 'https://github.com/johannruiz/scudrace-plus-web',
    isolation: 'credentialless',
  },
];

// Which game a URL belongs to (same origin and inside the game's path).
function gameForUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  return GAMES.find(g => { const b = new URL(g.url); return u.origin === b.origin && u.pathname.startsWith(b.pathname); }) || null;
}

module.exports = { GAMES, gameForUrl };
