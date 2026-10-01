import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

// Stamped into the bundle and shown on the Account page, so which build a
// device is actually running is a thing you can read rather than infer. A
// stale cached copy of index.html has more than once looked like a feature
// failing to deploy.
const buildId = (() => {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // Not a git checkout (or git unavailable) — the date alone still helps.
  }
  return `${commit} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
})();

export default defineConfig(({ mode }) => {
  // Capacitor's native WebView serves the bundled dist/ files from its own
  // local root (file://.../public/index.html on iOS, equivalent on
  // Android) — there is no /app/ subpath there, unlike the GitHub Pages
  // deploy. npm run build:ios / build:android (mode 'ios' / 'android')
  // must build with base '/', or every asset reference 404s inside the
  // native shell (blank white screen). Only the plain `npm run build` used
  // by .github/workflows/deploy.yml — the web deploy — gets '/app/'.
  const isNative = mode === 'ios' || mode === 'android';
  const base = isNative ? '/' : '/app/';

  return {
    plugins: [
      react(),
      // App-shell installability only — icons, manifest, offline cache of the
      // build's own static assets. Deliberately no runtime caching of
      // Firestore/API calls: this app's whole value is showing current data,
      // so caching stale drive logs offline would be worse than showing
      // nothing. autoUpdate + skipWaiting/clientsClaim matches the intent of
      // index.html's own no-cache meta tag above — a stale cached build
      // silently outliving a deploy has already bitten this app once (see the
      // comment on that meta tag); this activates a new service worker (and
      // the build it serves) as soon as one is available, not after every
      // open tab is closed.
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          skipWaiting: true,
          clientsClaim: true,
          cleanupOutdatedCaches: true,
        },
        manifest: {
          name: 'Student Drive Log',
          short_name: 'Drive Log',
          description: "Log a student driver's supervised practice hours and export state DMV forms.",
          theme_color: '#0A2A5E',
          background_color: '#0A2A5E',
          display: 'standalone',
          start_url: base,
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      }),
    ],
    // Served at the sdl.devworksllc.com custom domain (see public/CNAME),
    // under /app/ for the WEB build only — the domain root is a static
    // marketing page (marketing/, not part of this Vite project at all;
    // see .github/workflows/deploy.yml, which assembles the two together
    // at publish time). Moving the web app off root (2026-10-01, DEV-26)
    // is why base is conditional at all. Two kinds of asset needed fixing
    // for the web build to work under a non-root base — see their own
    // comments:
    //   - src/utils/snapshot.js and src/utils/stateFormFill.js already used
    //     import.meta.env.BASE_URL, so they adopted the new base for free.
    //   - theme.css's self-hosted fonts used to live in public/fonts/ and be
    //     referenced by a hardcoded absolute '/fonts/...' path — public/ dir
    //     passthrough files aren't base-prefixed by Vite (by design; see
    //     Vite's own docs on this), so that path would have silently 404ed
    //     once this stopped being true at the domain root. Moved to
    //     src/assets/fonts/ and referenced with a relative url() instead, so
    //     Vite's own asset pipeline fingerprints and base-prefixes them like
    //     everything else — which also makes them correctly resolve under
    //     base '/' for the native builds, unchanged from before.
    base,
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
  };
});
