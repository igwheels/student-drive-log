/**
 * Generate the native app-icon source images from public/logo.png.
 *
 * public/logo.png is the brand logo: the blue rounded-square artwork
 * (white car + checklist, no wordmark) filling the whole image edge to
 * edge, with rounded corners baked in as transparent pixels. A native app
 * icon has to be a full-bleed opaque square — iOS and Android apply their
 * own corner mask — so this script squares the art, cuts the corners back
 * to transparent at ~iOS's own squircle radius, and composites it onto a
 * solid navy field. The flat navy that shows through at the corners is
 * exactly the region the OS clips anyway.
 *
 * Outputs (consumed by `npx capacitor-assets generate`):
 *   resources/icon.png            1024²  opaque, full-bleed  (iOS + legacy Android)
 *   resources/icon-background.png 1024²  solid brand navy    (Android adaptive)
 *   resources/icon-foreground.png 1024²  art in the safe zone, transparent
 *   resources/splash.png          2732²  logo on brand navy  (launch screen)
 *   resources/splash-dark.png     2732²  identical — the brand field is
 *                                        already dark, so there is no
 *                                        separate light treatment to make
 *                                        (and no white launch flash).
 *
 * Run via `npm run icons` (which also runs capacitor-assets + cap sync).
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const SRC = 'public/logo.png';
const OUT = 'resources';
const SIZE = 1024;
// Brand blue — matches --navy in src/styles/theme.css and the manifest
// theme_color, and sits mid-way in the logo's own gradient (LOGO_TOP →
// LOGO_BOTTOM below). Used for the launch-screen field and behind the
// trimmed corners of the iOS icon, under the OS mask.
const NAVY = '#0A2A5E';
// Top and bottom edge colours of the logo's blue gradient, sampled from
// public/logo.png; the Android adaptive background layer repeats it so the
// inset foreground art blends into it.
const LOGO_TOP = '#0e3574';
const LOGO_BOTTOM = '#041a43';
const CORNER_RADIUS = Math.round(SIZE * 0.235);

const cornerMask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="#fff"/>` +
    `</svg>`,
);

// Square it off, then knock the corners out to transparent.
const art = await sharp(SRC)
  .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
  .ensureAlpha()
  .composite([{ input: cornerMask, blend: 'dest-in' }])
  .png()
  .toBuffer();

await mkdir(OUT, { recursive: true });

// iOS + legacy Android launcher: opaque, art to the edges, navy corners.
// iOS rejects an icon with an alpha channel, so flatten AND drop alpha.
await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: NAVY } })
  .composite([{ input: art }])
  .flatten({ background: NAVY })
  .removeAlpha()
  .png()
  .toFile(`${OUT}/icon.png`);

// Android adaptive background layer.
await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${LOGO_TOP}"/><stop offset="1" stop-color="${LOGO_BOTTOM}"/>` +
      `</linearGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/></svg>`,
  ),
)
  .removeAlpha()
  .png()
  .toFile(`${OUT}/icon-background.png`);

// Android adaptive foreground layer — the same full-bleed art (transparent
// corners). capacitor-assets adds its own ~16.7% inset and the launcher
// then applies a circle/squircle mask, which lands on the navy the
// background layer supplies, so nothing important is clipped.
await sharp(art).toFile(`${OUT}/icon-foreground.png`);

// Launch screen: the logo on the brand navy field. Same image for light
// and dark — the brand is dark either way, which also avoids the white
// flash capacitor-assets' auto-splash would otherwise show in light mode.
const SPLASH = 2732;
const splashLogo = await sharp(art)
  .resize(Math.round(SPLASH * 0.30), Math.round(SPLASH * 0.30))
  .toBuffer();
const splash = await sharp({ create: { width: SPLASH, height: SPLASH, channels: 3, background: NAVY } })
  .composite([{ input: splashLogo, gravity: 'center' }])
  .png()
  .toBuffer();
await sharp(splash).toFile(`${OUT}/splash.png`);
await sharp(splash).toFile(`${OUT}/splash-dark.png`);

console.log(
  'Wrote',
  ['icon.png', 'icon-background.png', 'icon-foreground.png', 'splash.png', 'splash-dark.png']
    .map((f) => `${OUT}/${f}`)
    .join(', '),
);
