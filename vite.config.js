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

// Served at the sdl.devworksllc.com custom domain (see public/CNAME) rather
// than the GitHub Pages project-site path, so assets resolve from the root.
// Revert to '/student-driver-log/' if the custom domain is ever removed and
// this falls back to the project-site URL.
export default defineConfig({
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
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  base: '/',
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
});
