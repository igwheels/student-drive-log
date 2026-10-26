// Builds and reads shareable "snapshot" links — a read-only view of a
// student's dashboard progress or a single drive, with the data encoded
// directly in the URL (base64 JSON in the hash query string) rather than
// fetched from Firestore. That keeps it viewable by anyone with the link,
// without requiring a signed-in session or making any account data
// queryable by non-owners.
//
// Deliberately NO location data: because the payload lives in the URL, a
// snapshot cannot be revoked, expired, or access-controlled once sent, and
// anyone holding the link can decode it. Drives are usually taken by minors
// and usually start at home, so start/end coordinates and the route between
// them are exactly the fields that shouldn't travel in a link the sharer
// can't take back. Maps stay in the app, where they're behind auth and only
// visible to the dashboard's owner and people it's explicitly shared with.

import { Capacitor } from '@capacitor/core';

function encode(type, data) {
  const json = JSON.stringify({ t: type, d: data });
  // Route UTF-8 bytes through btoa, which only handles Latin1 — needed since
  // a student's name can contain non-ASCII characters.
  return btoa(new TextEncoder().encode(json).reduce((s, byte) => s + String.fromCharCode(byte), ''));
}

function decode(b64) {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Inside the native shell, window.location.origin is "capacitor://localhost"
// (iOS/Android WKWebView/WebView serving the bundled build from its own local
// root) — a scheme no recipient's device or browser can open. There's no
// origin to read there that would produce a working link, so native builds
// always point at the real published web app instead; browsers (where
// location.origin + BASE_URL is already correct — see vite.config.js's base
// comment) keep using the current origin so this also works from a local or
// staging deploy without hardcoding those.
const PUBLIC_APP_URL = 'https://sdl.devworksllc.com/app/';

function snapshotUrl(type, data) {
  const b64 = encode(type, data);
  const base = Capacitor.isNativePlatform()
    ? PUBLIC_APP_URL
    : `${window.location.origin}${import.meta.env.BASE_URL}`;
  return `${base}#/snapshot?d=${encodeURIComponent(b64)}`;
}

export function buildDashboardSnapshotUrl({
  studentFirstName,
  requirementName,
  totalMinutes,
  totalGoalMinutes,
  nightMinutes,
  nightGoalMinutes,
}) {
  return snapshotUrl('dashboard', {
    name: studentFirstName,
    req: requirementName,
    tm: totalMinutes,
    tg: totalGoalMinutes,
    nm: nightMinutes,
    ng: nightGoalMinutes,
  });
}

export function buildLogSnapshotUrl({
  studentFirstName,
  date,
  durationMinutes,
  type,
  timeOfDay,
  distanceMiles,
}) {
  return snapshotUrl('log', {
    name: studentFirstName,
    date,
    dur: durationMinutes,
    type,
    tod: timeOfDay,
    dist: distanceMiles,
  });
}

export function decodeSnapshotParam(param) {
  if (!param) return null;
  return decode(param);
}
