import { Motion } from '@capacitor/motion';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { saveOrShareBlob } from './saveFile';
import {
  THRESHOLDS,
  createTelematicsState,
  normalizeMotionSample,
  processSample,
} from './telematicsCore';

// Signal processing + thresholds live in telematicsCore.js (pure, replayable).
// This module is the @capacitor/motion plumbing plus the debug/capture modes
// used for real-device threshold tuning.

const PREF_KEY = 'sdl_telematics';

/**
 * localStorage 'sdl_telematics':
 *   (unset) / 'off' — no detection. setTelematicsEnabled(false) — Account's
 *                     "Driving-safety alerts" toggle unchecked — sets this.
 *   'on'            — detect, buzz, count. Set by that same toggle when
 *                     checked. Thresholds are still unverified (see
 *                     telematicsCore.js) — this only controls whether
 *                     detection runs at all, not whether it's accurate yet.
 *   'debug'         — 'on' + a throttled console trace of the smoothed
 *                     signals vs. their thresholds, and every event. Set by
 *                     hand (localStorage.setItem) for real-device tuning —
 *                     no UI for it, and the Account toggle would overwrite
 *                     it back to plain 'on'/'off'.
 *   'capture'       — 'on' + records every raw sample; downloads (and
 *                     console-dumps) a CSV when the drive ends, for
 *                     scripts/replay-telematics.mjs. Same manual-only caveat
 *                     as 'debug'.
 */
export function telematicsMode() {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'on' || v === 'debug' || v === 'capture' ? v : 'off';
  } catch {
    return 'off';
  }
}

export function telematicsEnabled() {
  return telematicsMode() !== 'off';
}

export function setTelematicsMode(mode) {
  try {
    localStorage.setItem(PREF_KEY, mode);
  } catch {
    // Non-persistent is fine — it reverts to the 'off' default.
  }
}

// Kept from the earlier on/off-only helper.
export function setTelematicsEnabled(on) {
  setTelematicsMode(on ? 'on' : 'off');
}

const DEBUG_LOG_EVERY_MS = 250;
const CAPTURE_HEADER = 't,x,y,z,rAlpha,speedMph,linMag,smBrake,smYaw';
// How often buffered capture rows are flushed to disk — see persistCapture's
// comment below. Short enough that a process kill loses at most this much of
// a capture; long enough not to hammer the filesystem every sample.
const CAPTURE_FLUSH_MS = 15000;

function captureFilePath(driveId) {
  // driveId is the drive's ISO startTime (stable across a resume — see
  // DriveTimer.jsx), sanitized for use as a filename.
  return `telematics-capture-${String(driveId).replace(/[^a-zA-Z0-9_-]/g, '-')}.csv`;
}

/**
 * Watches accelerometer / gyro for the duration of a drive.
 *
 * `getSpeedMph()` is polled per sample for the speed gate; `onEvent({ type,
 * magnitude, at })` fires on a detected 'hard-brake' / 'harsh-turn'. `driveId`
 * (the drive's stable ISO startTime) lets 'capture' mode survive a mid-drive
 * process kill — see persistCapture's comment.
 *
 * Returns stop() synchronously; the listener attach and the iOS
 * motion-permission request run in the background and are unwound by stop()
 * whether or not they finished. In 'capture' mode, stop() also emits the CSV.
 */
export function startDriveTelematics({ getSpeedMph, onEvent, driveId } = {}) {
  const mode = telematicsMode();
  let stopped = false;
  let accelHandle = null;

  const state = createTelematicsState();

  // Confirmed from a real capture, 2026-10-14: a 3+ hour Android drive lost
  // its entire capture because the old design held every row only in a plain
  // JS array (captureRows) in memory, with nothing written to disk until the
  // drive ended. iOS gets away with that — UIBackgroundModes 'location' in
  // Info.plist keeps the whole process (JS included) alive for as long as
  // location updates keep coming — but Android has no equivalent foreground
  // service pinning the process alive, and OEM battery management (this
  // capture was on a Motorola device) will reclaim a backgrounded app during
  // a multi-hour drive. The component remounts on resume (DriveTimer.jsx's
  // checkpoint/resume, DEV-71) and calls this function again, which used to
  // mean a brand-new empty array — every sample recorded before the kill was
  // gone, matching exactly what was reported: nothing printed at Stop.
  //
  // Fix: in 'capture' mode on a native platform, rows are buffered briefly
  // then flushed to a file (keyed on driveId, so a resumed mount appends to
  // the SAME file instead of starting fresh) every CAPTURE_FLUSH_MS, mirroring
  // the same checkpoint-to-survive-a-kill approach already used for
  // miles/route (see utils/activeDrive.js). On web, or if no driveId was
  // passed, falls back to the original in-memory-only array — web builds
  // don't get killed mid-drive the way a backgrounded native app does.
  const persistCapture = mode === 'capture' && Capacitor.isNativePlatform() && driveId != null;
  const captureRows = mode === 'capture' && !persistCapture ? [] : null;
  const pendingRows = persistCapture ? [] : null;
  const capturePath = persistCapture ? captureFilePath(driveId) : null;
  let flush = null;
  let flushTimer = null;

  if (persistCapture) {
    // Resolves once the file has its header line — either just-written (a
    // fresh drive) or already there (resuming one that was already flushing
    // before a kill). Awaited before every append so a flush can't race the
    // initial write.
    const fileReady = (async () => {
      try {
        await Filesystem.stat({ path: capturePath, directory: Directory.Cache });
        // Already exists — resuming an in-progress capture, nothing to do.
      } catch {
        await Filesystem.writeFile({
          path: capturePath,
          data: CAPTURE_HEADER + '\n',
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
      }
    })();

    flush = async () => {
      if (!pendingRows.length) return;
      const rows = pendingRows.splice(0, pendingRows.length);
      try {
        await fileReady;
        await Filesystem.appendFile({
          path: capturePath,
          data: rows.join('\n') + '\n',
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
      } catch (e) {
        // Put the rows back so the next flush retries rather than silently
        // dropping this chunk.
        pendingRows.unshift(...rows);
        console.warn('[tele] capture flush failed, will retry', e);
      }
    };
    flushTimer = setInterval(flush, CAPTURE_FLUSH_MS);
  }

  let lastDebugAt = 0;

  const onSample = (e) => {
    const sample = normalizeMotionSample(e, {
      t: Date.now(),
      speedMph: getSpeedMph?.() ?? null,
    });
    const { events, debug } = processSample(state, sample);

    if (captureRows || pendingRows) {
      const row = [
        sample.t,
        r4(sample.x),
        r4(sample.y),
        r4(sample.z),
        r4(sample.rAlpha),
        sample.speedMph ?? '',
        r4(debug.linMag),
        r4(debug.smBrake),
        r4(debug.smYaw),
      ].join(',');
      if (captureRows) captureRows.push(row);
      else pendingRows.push(row);
    }

    if (mode === 'debug' && sample.t - lastDebugAt >= DEBUG_LOG_EVERY_MS) {
      lastDebugAt = sample.t;
      const bPct = ((debug.smBrake / THRESHOLDS.hardBrakeMs2) * 100) | 0;
      const yPct = ((debug.smYaw / THRESHOLDS.harshTurnDegS) * 100) | 0;
      console.log(
        `[tele] +${((sample.t - state.startedAt) / 1000).toFixed(1)}s ` +
          `spd=${debug.speedMph ?? '–'} ` +
          `brake=${debug.smBrake.toFixed(2)} (${bPct}%${debug.holdBrakeMs ? ` hold ${debug.holdBrakeMs | 0}ms` : ''}) ` +
          `yaw=${debug.smYaw.toFixed(0)} (${yPct}%${debug.holdYawMs ? ` hold ${debug.holdYawMs | 0}ms` : ''})` +
          `${debug.warm ? '' : ' [warmup]'}${debug.disturbed ? ' [DISTURBED]' : ''}`
      );
    }

    for (const ev of events) {
      if (mode === 'debug' || mode === 'capture') {
        console.log(
          `[tele] EVENT ${ev.type} mag=${ev.magnitude.toFixed(2)} ` +
            `at +${((ev.at - state.startedAt) / 1000).toFixed(1)}s`
        );
      }
      onEvent?.(ev);
    }
  };

  (async () => {
    // iOS 13+ (Safari and the WKWebView) gate motion behind an explicit
    // permission call that must originate from a user gesture. The drive
    // starts from a tap, but the async hop here may already be past that
    // window; if the request rejects, telematics just doesn't run this drive.
    try {
      const req =
        typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission;
      if (typeof req === 'function') {
        const res = await req.call(DeviceMotionEvent);
        if (res !== 'granted') return;
      }
    } catch {
      return;
    }
    if (stopped) return;

    try {
      accelHandle = await Motion.addListener('accel', onSample);
    } catch {
      return;
    }
    if (stopped) accelHandle?.remove?.();
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    accelHandle?.remove?.();
    if (flushTimer) clearInterval(flushTimer);

    if (persistCapture) {
      (async () => {
        await flush(); // catch whatever's accumulated since the last timer tick
        let csv = null;
        try {
          const { data } = await Filesystem.readFile({
            path: capturePath,
            directory: Directory.Cache,
            encoding: Encoding.UTF8,
          });
          csv = data;
        } catch (e) {
          console.warn('[tele] could not read back capture file', e);
        }
        if (csv != null) await dumpCapture(csv);
        try {
          await Filesystem.deleteFile({ path: capturePath, directory: Directory.Cache });
        } catch {
          // Not fatal — it's in the Cache directory, the OS will reclaim it.
        }
      })();
    } else if (captureRows) {
      dumpCapture([CAPTURE_HEADER, ...captureRows].join('\n'));
    }
  };
}

function r4(n) {
  return typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : n;
}

// `csv` is the complete file content, header included.
async function dumpCapture(csv) {
  const filename = `telematics-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  try {
    // Routes through the same native-share-sheet / web-download split as the
    // DMV PDF export (see saveFile.js) — a raw <a download> click is inert in
    // WKWebView, which is exactly why every capture up to now has had to be
    // copy-pasted out of the console by hand.
    await saveOrShareBlob(new Blob([csv], { type: 'text/csv' }), filename);
  } catch (e) {
    console.warn('[tele] could not save/share the capture file', e);
  }
  // Always print it too: still the one method proven to work in every
  // context, and you'll usually be driving the inspector from a laptop
  // anyway. Copy the block below out of the console and save it as a .csv.
  const sampleCount = csv.split('\n').length - 1;
  console.log(`[tele] capture: ${sampleCount} samples\n${csv}`);
}
