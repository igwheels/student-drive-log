import { Motion } from '@capacitor/motion';
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

/**
 * Watches accelerometer / gyro for the duration of a drive.
 *
 * `getSpeedMph()` is polled per sample for the speed gate; `onEvent({ type,
 * magnitude, at })` fires on a detected 'hard-brake' / 'harsh-turn'. The
 * caller decides what to do with an event — this module is detection only
 * (plus the tuning instrumentation).
 *
 * Returns stop() synchronously; the listener attach and the iOS
 * motion-permission request run in the background and are unwound by stop()
 * whether or not they finished. In 'capture' mode, stop() also emits the CSV.
 */
export function startDriveTelematics({ getSpeedMph, onEvent } = {}) {
  const mode = telematicsMode();
  let stopped = false;
  let accelHandle = null;

  const state = createTelematicsState();
  const captureRows = mode === 'capture' ? [] : null;
  let lastDebugAt = 0;

  const onSample = (e) => {
    const sample = normalizeMotionSample(e, {
      t: Date.now(),
      speedMph: getSpeedMph?.() ?? null,
    });
    const { events, debug } = processSample(state, sample);

    if (captureRows) {
      captureRows.push(
        [
          sample.t,
          r4(sample.x),
          r4(sample.y),
          r4(sample.z),
          r4(sample.rAlpha),
          sample.speedMph ?? '',
          r4(debug.linMag),
          r4(debug.smBrake),
          r4(debug.smYaw),
        ].join(',')
      );
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
    if (captureRows) dumpCapture(captureRows);
  };
}

function r4(n) {
  return typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : n;
}

function dumpCapture(rows) {
  const csv = [CAPTURE_HEADER, ...rows].join('\n');
  try {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `telematics-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    // Fall through to the console dump.
  }
  // Always print it too: <a download> is inert in some WKWebView contexts,
  // and you'll usually be driving the inspector from a laptop anyway. Copy
  // the block below out of the console and save it as a .csv.
  console.log(`[tele] capture: ${rows.length} samples\n${csv}`);
}
