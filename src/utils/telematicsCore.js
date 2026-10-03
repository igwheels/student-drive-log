// Pure signal processing for hard-brake / harsh-turn detection — no Capacitor,
// no DOM. Runs identically in the app, in the Node replay harness
// (scripts/replay-telematics.mjs), and in any future test. The plugin
// plumbing and the debug/capture side effects live in telematics.js.

export const G = 9.80665;

// ───────────────────────────────────────────────────────────────────────────
// UNVERIFIED THRESHOLDS.
//
// The DEV-34 spec is explicit: tune these against real driving data before
// the feature is trusted — false positives would erode confidence in the
// safety cue. Detection is OFF by default (see telematicsMode in
// telematics.js). Capture a drive with sdl_telematics='capture', then sweep
// values offline with scripts/replay-telematics.mjs. Exported as a plain
// mutable object so the harness can override without editing this file.
// ───────────────────────────────────────────────────────────────────────────
export const THRESHOLDS = {
  // Hard braking: smoothed linear-accel magnitude, m/s². ~0.3 g is firm
  // normal braking; 0.45 g a deliberate hard stop; ~0.7 g+ is ABS territory.
  // Keys off magnitude, so hard throttle also trips it until an
  // orientation-calibration step exists to isolate the forward axis.
  hardBrakeMs2: 0.45 * G,
  // Harsh turn: smoothed yaw rate about the vertical axis, deg/s. A brisk
  // corner is ~15–25; a swerve or a corner taken too fast passes ~40.
  harshTurnDegS: 40,
  // Confirmed from a real capture, 2026-10-03 (phone handed to a passenger
  // mid-drive): smoothed yaw rate hit 115°/s while GPS speed held rock
  // steady — no car yaws anywhere near that fast; that's the phone itself
  // spinning in a hand, not the vehicle turning. Above this, a "turn" isn't
  // treated as real at all, same as a disturbance — reject outright rather
  // than merely count it as a severe one. Provisional like the rest of
  // THRESHOLDS: picked well above the ~40–60°/s a sharp real swerve could
  // plausibly reach, but there's no captured example yet of a genuine
  // extreme evasive maneuver to calibrate the ceiling precisely against.
  implausibleYawDegS: 90,
  // The signal must stay past threshold this long before an event fires —
  // rejects one-off spikes (a pothole, the phone being picked up).
  eventMinDurationMs: 250,
  // Minimum gap between events of the same type.
  eventCooldownMs: 3000,
  // Below this GPS speed it isn't a driving event (phone jostled while parked
  // or carried). Lenient when speed is unknown — see processSample.
  minSpeedMph: 5,
  // Confirmed from the same 2026-10-03 capture: a candidate hard-brake fired
  // while GPS speed held rock steady at ~58mph the whole time — a real hard
  // brake, by definition, measurably slows the car down. Require GPS speed
  // to have actually dropped at least this much, latched from the moment
  // the raw signal first crossed hardBrakeMs2 (see processSample's
  // speedAtOnset), before the event is allowed to fire — not merely that
  // the car was moving. Lenient when speed is unknown, same as minSpeedMph.
  // Deliberately modest: ~0.45g sustained for even a fraction of a second
  // sheds several mph, so this is a low bar for a real brake to clear while
  // still rejecting a flat-speed false alarm outright. Provisional like the
  // rest of THRESHOLDS.
  hardBrakeMinSpeedDropMph: 2,
  // Exponential smoothing on the event signals (0 = frozen, 1 = raw sample).
  signalSmoothing: 0.35,
  // Slow low-pass that estimates the gravity vector, subtracted from the
  // accel triple to recover linear acceleration. Frozen mid-manoeuvre (see
  // processSample) so a sustained brake / long corner isn't absorbed into it.
  gravitySmoothing: 0.02,
  // Faster gravity adaptation during warmup, so the estimate converges from
  // zero within warmupMs instead of over ~1 min.
  gravityWarmupSmoothing: 0.1,
  // Ignore this first stretch while the gravity estimate converges.
  warmupMs: 1000,
  // Reported 2026-10-02 from real test drives: a phone that isn't mounted or
  // sitting flat and still throws false hard-brake/harsh-turn events. Root
  // cause isn't fixable by threshold tuning alone — detection reads the
  // phone's OWN accelerometer/gyro frame, which only maps cleanly onto the
  // car's motion when the phone's orientation relative to the car is fixed.
  // A loose phone sliding, tipping, or being picked up moves independently
  // of the car, and that motion reads as car motion.
  //
  // This catches one slice of that: a raw accelerometer magnitude far from
  // 1 g means something is physically disturbing the phone (a slide, a
  // small impact) beyond what smooth gravity + vehicle acceleration
  // produces — even a hard 0.7 g stop only pushes magnitude to ~1.2 g. Does
  // NOT fix a phone that tips to a new resting angle and stays there (no
  // magnitude anomaly, just a changed axis mapping) — that needs real
  // orientation tracking, not a threshold. Still unverified like the rest of
  // THRESHOLDS — tune with sdl_telematics='capture' + replay-telematics.mjs.
  disturbanceMagnitudeMs2: 3.5,
  // Confirmed from a real capture, 2026-10-03: the freeze gate below has no
  // way back once it's engaged — a phone that gets picked up/reoriented
  // smoothly enough to not trip disturbanceMagnitudeMs2 (no rawMag spike,
  // just a changed axis mapping — the gap the comment above already named)
  // left smBrake pinned at ~10.36 m/s^2, over 1g, for the rest of a
  // 27-minute drive: once state.smBrake stays above half the hard-brake
  // threshold, gAlpha stays 0 forever, and the stale bias is exactly what
  // keeps it there. Only the 5mph speed floor kept that capture from firing
  // for real — it happened to be stopped. If frozen continuously this long,
  // it isn't a real ongoing manoeuvre (no street hard-brake or turn sustains
  // past-threshold g for anywhere near this long — the car's long since
  // stopped or the turn's long since over), so treat it as a stale gravity
  // estimate and force a re-snap instead of continuing to freeze. Provisional
  // like the rest of THRESHOLDS — tune against real captures.
  gravityStuckMs: 8000,
  // Confirmed from a real capture, 2026-10-03: a 7+ minute total GPS gap
  // (phone off its mount, out of sky view) covered both false harsh-turns
  // AND the one false hard-brake that fired with no speed reading at all —
  // every false positive that capture produced lined up with a GPS gap, and
  // the one true hard-brake fired with GPS healthy. But a GPS gap alone
  // isn't a safe signal to reject on by itself — a tunnel or parking garage
  // produces the identical symptom (no fixes) while the phone stays mounted
  // and driving continues normally, and silently dropping a real event
  // there would defeat the point of a safety feature. The distinguishing
  // signal is whether the phone's orientation was ALSO disturbed recently:
  // a tunnel doesn't touch the accelerometer/gyro at all, a handoff does.
  // So: no GPS speed AND a disturbance or stuck-gravity re-snap within this
  // window → reject (untrustworthy); no GPS speed but orientation's been
  // stable → fall through to the existing lenient behavior (trust the
  // accelerometer alone, same as the tunnel case). Provisional like the
  // rest of THRESHOLDS — long enough to span a realistic unmount/handoff/
  // remount sequence, short enough not to distrust the whole rest of the
  // drive over one jostle.
  recentDisturbanceMs: 15000,
};

export function createTelematicsState() {
  return {
    startedAt: null,
    gx: 0,
    gy: 0,
    gz: 0,
    smBrake: 0,
    smYaw: 0,
    overSince: { 'hard-brake': null, 'harsh-turn': null },
    lastFired: { 'hard-brake': 0, 'harsh-turn': 0 },
    // When the gravity freeze gate (see gravityStuckMs) last engaged
    // continuously — null whenever it's not currently frozen. Drives the
    // stuck-plateau re-snap in processSample.
    frozenSince: null,
    // GPS speed latched the moment overSince['hard-brake'] was first set —
    // the "onset" speed a candidate brake is judged against (see
    // hardBrakeMinSpeedDropMph). Cleared alongside overSince. Latched from
    // lastKnownSpeed, not the instantaneous sample — see that field's
    // comment for why.
    speedAtBrakeOnset: null,
    // The most recent non-null speed reading, updated every sample
    // regardless of brake/turn state. A hard-brake's onset can land on the
    // exact sample a GPS gap begins (speed already null that instant) — using
    // the last known-good value instead of the instantaneous one means a
    // real onset still has a real number to compare against once GPS
    // resumes, rather than silently defaulting to lenient for the rest of
    // the gap because the one sample it happened to latch on was empty.
    lastKnownSpeed: null,
    // Last sample timestamps where (respectively) the raw-magnitude
    // disturbance gate tripped, and the stuck-gravity re-snap fired — null
    // until the first one. Drives the no-GPS/recent-disturbance reject in
    // consider() (see recentDisturbanceMs).
    lastDisturbedAt: null,
    lastSnapAt: null,
  };
}

/**
 * Flattens a @capacitor/motion 'accel' event into the sample shape
 * processSample and the capture CSV both use: { t, x, y, z, rAlpha, speedMph }.
 *
 * x/y/z are accelerationIncludingGravity when present (the only field Android
 * reliably fills), else acceleration. rAlpha is |rotationRate.alpha| (yaw).
 */
export function normalizeMotionSample(event, { t = Date.now(), speedMph = null } = {}) {
  const a = event.accelerationIncludingGravity || event.acceleration || {};
  return {
    t,
    x: a.x || 0,
    y: a.y || 0,
    z: a.z || 0,
    rAlpha: Math.abs(event.rotationRate?.alpha || 0),
    speedMph,
  };
}

/**
 * Feeds one sample through the detector. Mutates `state`. Returns
 * `{ events: [{ type, magnitude, at }], debug: {...} }`.
 *
 * `opts.thresholds` overrides THRESHOLDS wholesale — the harness passes a
 * merged copy to sweep values.
 */
export function processSample(state, sample, opts = {}) {
  const th = opts.thresholds || THRESHOLDS;
  const now = sample.t;
  if (state.startedAt == null) state.startedAt = now;
  const warm = now - state.startedAt >= th.warmupMs;

  // Gravity estimate: converge fast during warmup; after that adapt slowly,
  // but freeze entirely once a manoeuvre is underway (judged from the last
  // sample's smoothed values) so a sustained hard brake or long corner isn't
  // low-passed into "gravity" and self-cancelled. Both failure directions
  // were caught with scripts/replay-telematics.mjs.
  let gAlpha;
  let snapped = false;
  if (!warm) {
    gAlpha = th.gravityWarmupSmoothing;
    state.frozenSince = null;
  } else if (
    state.smBrake > th.hardBrakeMs2 * 0.5 ||
    state.smYaw > th.harshTurnDegS * 0.5
  ) {
    if (state.frozenSince == null) state.frozenSince = now;
    if (now - state.frozenSince >= th.gravityStuckMs) {
      // See gravityStuckMs's comment — frozen implausibly long, more likely
      // a stale estimate than a real ongoing event. Snap straight to the
      // current raw reading rather than another slow blend, and start the
      // freeze window over so a genuinely-stuck sensor can't wedge forever.
      state.gx = sample.x;
      state.gy = sample.y;
      state.gz = sample.z;
      state.frozenSince = now;
      state.lastSnapAt = now;
      snapped = true;
    } else {
      gAlpha = 0;
    }
  } else {
    gAlpha = th.gravitySmoothing;
    state.frozenSince = null;
  }
  if (!snapped) {
    state.gx += gAlpha * (sample.x - state.gx);
    state.gy += gAlpha * (sample.y - state.gy);
    state.gz += gAlpha * (sample.z - state.gz);
  }

  const linMag = Math.hypot(sample.x - state.gx, sample.y - state.gy, sample.z - state.gz);
  const yawRate = Math.abs(sample.rAlpha || 0);

  state.smBrake += th.signalSmoothing * (linMag - state.smBrake);
  state.smYaw += th.signalSmoothing * (yawRate - state.smYaw);

  // See disturbanceMagnitudeMs2's comment: the RAW (pre-gravity-subtraction)
  // vector magnitude straying far from 1 g means something is physically
  // disturbing the phone itself, not just the car — a mounted/flat phone's
  // raw magnitude stays near G plus whatever the car is doing, but a phone
  // that's sliding or getting jostled adds real force beyond that.
  const rawMag = Math.hypot(sample.x, sample.y, sample.z);
  const disturbed = Math.abs(rawMag - G) > th.disturbanceMagnitudeMs2;
  if (disturbed) state.lastDisturbedAt = now;

  const speed = sample.speedMph;
  if (speed != null) state.lastKnownSpeed = speed;
  const movingFastEnough = speed == null || speed >= th.minSpeedMph;
  // See recentDisturbanceMs's comment: no GPS to corroborate with, combined
  // with a recent sign the phone's orientation was actually disturbed (not
  // just "no fix," which a tunnel produces too) — don't trust the
  // accelerometer alone right now.
  const untrustworthyGap =
    speed == null &&
    ((state.lastDisturbedAt != null && now - state.lastDisturbedAt < th.recentDisturbanceMs) ||
      (state.lastSnapAt != null && now - state.lastSnapAt < th.recentDisturbanceMs));

  const events = [];
  const consider = (type, over) => {
    if (!warm || !over || !movingFastEnough || disturbed || untrustworthyGap) {
      state.overSince[type] = null;
      if (type === 'hard-brake') state.speedAtBrakeOnset = null;
      return;
    }
    if (state.overSince[type] == null) {
      state.overSince[type] = now;
      if (type === 'hard-brake') state.speedAtBrakeOnset = state.lastKnownSpeed;
    }
    if (now - state.overSince[type] < th.eventMinDurationMs) return;
    if (now - state.lastFired[type] < th.eventCooldownMs) return;
    if (type === 'hard-brake') {
      // See hardBrakeMinSpeedDropMph's comment: require GPS to corroborate
      // an actual slowdown since this candidate began, not just that the
      // car was moving. Lenient (let it through) whenever either reading is
      // unavailable — same philosophy as movingFastEnough. Deliberately
      // doesn't reset overSince/speedAtBrakeOnset on failure: a real brake
      // that's still sustaining just needs another sample or two for GPS to
      // catch up, so keep retrying rather than discarding the window.
      const onset = state.speedAtBrakeOnset;
      if (onset != null) {
        // We had a real GPS reading when this candidate began, so there's
        // something concrete to confirm against — if GPS has since gone
        // quiet, wait for it rather than firing blind. Confirmed from a
        // drive where a short (~18s) GPS gap started right as mild braking
        // began: with a known onset speed and no CURRENT reading, letting it
        // through by default (the old behavior) fired on no real evidence
        // either way. Only the genuine "never had GPS at all this drive"
        // case below stays lenient.
        if (speed == null) return;
        if (onset - speed < th.hardBrakeMinSpeedDropMph) return;
      }
    }
    state.lastFired[type] = now;
    state.overSince[type] = null;
    if (type === 'hard-brake') state.speedAtBrakeOnset = null;
    events.push({
      type,
      magnitude: type === 'harsh-turn' ? state.smYaw : state.smBrake,
      at: now,
    });
  };

  // A turn also throws linear accel, so gate hard-brake on low yaw to keep one
  // physical event from firing as both.
  consider('hard-brake', state.smBrake > th.hardBrakeMs2 && state.smYaw < th.harshTurnDegS);
  // Excludes implausibly fast yaw (see implausibleYawDegS) — that's the
  // phone spinning in a hand, not the vehicle turning.
  consider(
    'harsh-turn',
    state.smYaw > th.harshTurnDegS && state.smYaw <= th.implausibleYawDegS
  );

  return {
    events,
    debug: {
      t: now,
      linMag,
      yawRate,
      smBrake: state.smBrake,
      smYaw: state.smYaw,
      speedMph: speed ?? null,
      warm,
      movingFastEnough,
      rawMag,
      disturbed,
      holdBrakeMs: state.overSince['hard-brake'] == null ? 0 : now - state.overSince['hard-brake'],
      holdYawMs: state.overSince['harsh-turn'] == null ? 0 : now - state.overSince['harsh-turn'],
    },
  };
}
