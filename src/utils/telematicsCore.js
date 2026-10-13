// Pure signal processing for hard-brake / harsh-turn detection — no Capacitor,
// no DOM. Runs identically in the app, in the Node replay harness
// (scripts/replay-telematics.mjs), and in any future test. The plugin
// plumbing and the debug/capture side effects live in telematics.js.

export const G = 9.80665;
// m/s^2 -> mph/s, for comparing an accelerometer-claimed deceleration rate
// against a GPS-measured one (see hardBrakeMinProportion).
const MPS2_TO_MPH_PER_S = 2.236936;

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
  // Originally: no GPS speed AND a disturbance/re-snap within this window
  // -> reject as untrustworthy (a tunnel doesn't touch the accelerometer,
  // a handoff does); confirmed from a real capture, 2026-10-03, where a
  // 7+ minute GPS gap covered every false positive that capture produced.
  //
  // Broadened 2026-10-12 after a capture (phone unmounted, held/jostled
  // for an entire drive, GPS fully available throughout) produced 14 false
  // events — 7 hard-brake, 7 harsh-turn — because the old gate only ever
  // applied when speed was null. GPS being present says nothing about
  // whether the PHONE is currently stable; continuous jostling during
  // normal driving evades every GPS-gated check by definition, since GPS
  // obviously isn't missing while the car is being driven. Now drives
  // `unstable` in processSample unconditionally (see its comment) — same
  // time constant, same "was there a disturbance or re-snap recently"
  // question, just no longer gated behind speed being null. Provisional
  // like the rest of THRESHOLDS — long enough to span a realistic
  // unmount/handoff/remount sequence, short enough not to distrust the
  // whole rest of the drive over one jostle; re-validate the exact
  // duration once more continuously-unmounted captures exist.
  recentDisturbanceMs: 15000,
  // Confirmed from the same 2026-10-12 capture: even restricted to GPS-
  // present windows, the old hardBrakeMinSpeedDropMph check only asked
  // "did speed drop by >=2mph somewhere in this window," never whether
  // that drop was anywhere close to what the claimed g-force implies. A
  // 27-second ordinary, gentle coast-down (38mph->12mph, ~1mph/s average —
  // nothing like a hard stop) provided cover for repeated accelerometer
  // spikes up to 16.1 m/s^2 (>=3x hardBrakeMs2), each one individually
  // "confirmed" because the car genuinely was slowing down for an
  // unrelated, mundane reason at the same time.
  //
  // Require the most recently OBSERVED GPS deceleration rate (speed delta
  // between the last two genuinely distinct fixes, over the real elapsed
  // time between them — see createTelematicsState's priorKnownSpeed
  // comment) to be at least this fraction of what the peak accelerometer
  // magnitude claims (converted to the same mph/s units), not merely
  // nonzero. Deliberately uses the GPS pair's own real time base rather
  // than the brake candidate's duration: an earlier version divided the
  // speed drop by the (often ~200-500ms) candidate window instead, which
  // overstated the rate by 5-10x whenever a ~1Hz GPS step update happened
  // to land inside a short candidate window — caught when a second false
  // brake in the same 2026-10-12 capture (a smooth rhythmic jostle that
  // never once crossed the magnitude or reorientation disturbance gates —
  // raw magnitude deviation peaked at 2.15, under disturbanceMagnitudeMs2)
  // still cleared the original version of this check. GPS inherently
  // averages/lags a sub-second real spike, so this is deliberately lenient
  // rather than requiring a close match — picked low enough that a real
  // brief hard brake (high claimed rate, modest-but-real GPS-measured
  // rate) still clears it, while rejecting the >10x mismatches this
  // capture produced. Only applies when there's a real GPS pair to compare
  // against — same lenient-when-unknown philosophy as
  // hardBrakeMinSpeedDropMph. Unvalidated against a confirmed true
  // hard-brake capture (none was available this session) — more
  // provisional than the rest of THRESHOLDS; check this doesn't reject a
  // real brake once one is captured again.
  hardBrakeMinProportion: 0.15,
  // Confirmed from the same 2026-10-12/13 captures: splitting the stability
  // gate (see recentDisturbanceMs) and fixing the proportionality time base
  // still left 2 false hard-brakes, both inside a continuous unmounted-
  // jostling cluster. What they have in common, confirmed by comparing
  // against BOTH confirmed true hard-brakes (old captures, 2026-10-03 and
  // 2026-10-04): smYaw never exceeds the low single digits for the ENTIRE
  // duration around a real brake — a car braking in a straight line simply
  // doesn't yaw. The false ones instead show smYaw swinging wildly between
  // ~0 and 125+ deg/s continuously throughout the same window brake is
  // elevated; the hard-brake `over` gate's instantaneous `smYaw <
  // harshTurnDegS` check only caught the brief instants this chaotic signal
  // happened to dip under 40 by chance, while the candidate quietly
  // accumulated qualifying duration across several such dips.
  //
  // Require smYaw to have stayed under harshTurnDegS for this long before
  // confirming a hard-brake, not just at the instant it qualified — see
  // processSample's lastHighYawAt. Deliberately much shorter than
  // recentDisturbanceMs: a real sharp turn followed by a real hard brake a
  // couple seconds later should still be trusted, this only needs to
  // outlast the sub-second oscillation period seen in both false cases.
  // Provisional like the rest of THRESHOLDS — no case yet of a genuine
  // brake-while-recovering-from-a-real-turn to confirm this doesn't
  // overreach.
  hardBrakeYawQuietMs: 3000,
  // Confirmed from a real capture, 2026-10-04: three genuine hard brakes
  // (GPS speed dropping ~45mph->27mph each time) went undetected because the
  // ~1Hz GPS update lagged the ~1s accelerometer g-spike — by the sample
  // where GPS finally reported the drop, smBrake had already decayed back
  // under hardBrakeMs2, and the old logic cleared speedAtBrakeOnset the
  // instant `over` went false, so there was nothing left to confirm against.
  // A real hard brake's g-spike is brief; the GPS fix that proves it
  // happened routinely arrives after the spike itself has already ended.
  // Once a candidate satisfies the magnitude+duration gate, keep its onset
  // speed alive for this long waiting on GPS corroboration even after the
  // signal itself drops back under threshold, rather than discarding it on
  // the very next sample. Long enough to span a couple of 1Hz GPS updates,
  // short enough not to confirm an unrelated later slowdown as the same
  // event. Provisional like the rest of THRESHOLDS — tune against real
  // captures.
  hardBrakeConfirmGraceMs: 2000,
  // Confirmed from a real capture, 2026-10-12 (phone unmounted, held, no GPS
  // fix yet acquired this early in the drive): a hard-brake fired 6.4s into
  // the drive at smBrake=9.36 m/s^2 (over 2x threshold) from the phone being
  // picked up and rotated — raw x/y/z went from (-1.17,-0.08,-9.71) to
  // (0.21,-8.02,-4.73) within one 16ms sample, a ~59deg instantaneous swing
  // in the raw vector's direction, while its MAGNITUDE barely moved (stayed
  // within disturbanceMagnitudeMs2 of G the whole time) — exactly the gap
  // that threshold's own comment already named: a smooth reorientation has
  // no magnitude anomaly for it to catch, just a changed axis mapping. The
  // slow gravitySmoothing filter couldn't track a near-instant rotation, so
  // the stale-vs-new mismatch read as a phantom brake.
  //
  // This catches that slice specifically: the angle between consecutive raw
  // vectors, normalized to deg/s (see processSample's reorientRateDegS) —
  // a real brake/turn changes the car's (and phone's) acceleration vector
  // gradually over hundreds of ms; a hand rotating the phone changes its
  // raw vector's direction almost instantly. Checked across this capture's
  // full 72 minutes: driving (GPS speed present) maxed out at 1932deg/s
  // (a bump at 44.8mph); every no-GPS window — this false positive plus
  // every other pickup/set-down moment in the same drive — hit
  // 2841-8393deg/s. Picked with margin above the driving max and below the
  // lowest handling spike. Feeds into the same `disturbed` flag the
  // magnitude check already sets, so it rides the existing
  // lastInstabilityAt/unstable/cooldown plumbing rather than needing new
  // state. Validated against exactly one capture so far — provisional like
  // the rest of THRESHOLDS, tune further once more unmounted-handling
  // captures confirm this margin holds.
  reorientationDegS: 2400,
  // Confirmed from a real capture, 2026-10-13 (phone unmounted for the first
  // part of a highway drive, mounted for the rest): 5 false harsh-turns fired
  // at steady highway speed (33-58mph) with neither disturbanceMagnitudeMs2
  // nor reorientationDegS ever tripping. Both of those catch a SUDDEN
  // disturbance; this was a gradual tip/slide — smBrake and smYaw climbed
  // together smoothly over ~1s, not instantly — so the phone itself
  // physically rotating (and the stale, slowly-adapting gravity estimate
  // producing a phantom linMag alongside the real gyro rotation) never
  // crossed either rate-of-change gate.
  //
  // Catches it a different way: a real harsh turn's yaw rate and the car's
  // GPS speed together imply a cornering (centripetal) acceleration —
  // lateral accel = speed * yawRate. All 5 false turns implied 1.7-3.4 g of
  // lateral force (24.7-33.2 m/s^2) — physically impossible for a
  // street-driven passenger car, which loses traction well under 1 g even in
  // a genuine emergency swerve. A real sharp turn at a plausible speed stays
  // comfortably under this cap; a loose phone's own rotation, read against
  // the car's actual (much slower-turning) GPS track, blows past it by
  // 2-3x. Picked with real margin above a hard emergency maneuver (~0.8-1g)
  // so a genuine swerve isn't rejected. Lenient when speed is unknown, same
  // philosophy as the other GPS-dependent checks. Unvalidated against a
  // confirmed true harsh-turn capture (none exists yet) — provisional like
  // the rest of THRESHOLDS; revisit if a real sharp turn is ever caught
  // landing near this cap.
  harshTurnMaxLateralAccelMs2: 0.6 * G,
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
    // When lastKnownSpeed was last set to a genuinely NEW reading (not a
    // repeat of the same value while GPS sits between its own ~1Hz
    // updates), and the previous distinct reading/timestamp pair before
    // that. Together these give the real elapsed time between two actual
    // GPS fixes, for computing a true current deceleration rate (see
    // hardBrakeMinProportion's comment) — using a hard-brake candidate's
    // own (often much shorter) duration instead systematically overstates
    // the rate whenever a GPS step update happens to land inside it.
    lastKnownSpeedAt: null,
    priorKnownSpeed: null,
    priorKnownSpeedAt: null,
    // Last sample timestamp where smYaw exceeded harshTurnDegS — null until
    // the first one. Drives hardBrakeYawQuietMs's windowed check (see its
    // comment): a real forward brake keeps yaw low for its whole duration,
    // not just at the instant a candidate happens to qualify.
    lastHighYawAt: null,
    // Last sample timestamp where ANY instability evidence fired — a
    // magnitude disturbance, a rapid reorientation, or a stuck-gravity
    // re-snap. Null until the first one. Drives `unstable` in
    // processSample (see recentDisturbanceMs's comment): unconditional,
    // not gated behind GPS being unavailable, which is what makes it work
    // whether the phone is mounted or not.
    lastInstabilityAt: null,
    // When the magnitude+duration gate for a hard-brake candidate was first
    // satisfied — null whenever there's no candidate awaiting GPS
    // confirmation. Separate from overSince['hard-brake'] (which tracks the
    // raw over-threshold streak): see hardBrakeConfirmGraceMs's comment for
    // why a candidate has to survive past the moment the g-spike itself
    // subsides.
    brakeQualifiedAt: null,
    // Peak smBrake seen during the current hard-brake candidate's
    // over-threshold streak, latched for the event's reported magnitude —
    // by the time GPS confirms a candidate that outlived its own g-spike,
    // the live smBrake value has already decayed back down.
    brakePeakMag: null,
    // The previous sample's RAW (x, y, z) and its timestamp — null until the
    // second sample ever seen. Drives reorientRateDegS in processSample (see
    // reorientationDegS's comment): the angle between consecutive raw
    // vectors catches a phone being physically rotated, which the
    // magnitude-only disturbance check can miss entirely.
    prevRawX: null,
    prevRawY: null,
    prevRawZ: null,
    prevRawAt: null,
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
  // See hardBrakeYawQuietMs's comment.
  if (state.smYaw > th.harshTurnDegS) state.lastHighYawAt = now;

  // See disturbanceMagnitudeMs2's comment: the RAW (pre-gravity-subtraction)
  // vector magnitude straying far from 1 g means something is physically
  // disturbing the phone itself, not just the car — a mounted/flat phone's
  // raw magnitude stays near G plus whatever the car is doing, but a phone
  // that's sliding or getting jostled adds real force beyond that.
  const rawMag = Math.hypot(sample.x, sample.y, sample.z);
  const magnitudeDisturbed = Math.abs(rawMag - G) > th.disturbanceMagnitudeMs2;

  // See reorientationDegS's comment: the angle between this sample's raw
  // vector and the previous one, normalized to deg/s — catches a phone
  // being physically rotated even when its magnitude never leaves G's
  // neighbourhood (a smooth reorientation, not a slide or impact).
  let reorientRateDegS = 0;
  if (state.prevRawAt != null) {
    const dt = (now - state.prevRawAt) / 1000;
    const prevMag = Math.hypot(state.prevRawX, state.prevRawY, state.prevRawZ);
    if (dt > 0 && rawMag > 0.1 && prevMag > 0.1) {
      const dot = sample.x * state.prevRawX + sample.y * state.prevRawY + sample.z * state.prevRawZ;
      const cosAngle = Math.min(1, Math.max(-1, dot / (rawMag * prevMag)));
      const angleDeg = (Math.acos(cosAngle) * 180) / Math.PI;
      reorientRateDegS = angleDeg / dt;
    }
  }
  state.prevRawX = sample.x;
  state.prevRawY = sample.y;
  state.prevRawZ = sample.z;
  state.prevRawAt = now;

  const disturbed = magnitudeDisturbed || reorientRateDegS > th.reorientationDegS;
  if (disturbed || snapped) state.lastInstabilityAt = now;

  // Still "settling in" — see justStarted's use below. A drive's first-ever
  // candidate has nothing before it to have flagged lastInstabilityAt from,
  // since starting a drive IS a handling event (placing the phone in a
  // mount, or just setting it down) — there's no prior "settled" baseline
  // to have detected a change away from yet. Confirmed from a real capture,
  // 2026-10-12.
  const justStarted = now - state.startedAt < th.recentDisturbanceMs;

  // Persistent instability, not a per-sample flag — see recentDisturbanceMs's
  // comment. A phone jostling continuously (unmounted, in a cupholder or a
  // hand, for an entire drive) doesn't necessarily show `disturbed` on the
  // EXACT sample a candidate would fire; it shows a disturbance every second
  // or two. Staying "unstable" for recentDisturbanceMs after the last one
  // bridges those gaps, and — unconditional, not gated behind GPS being
  // unavailable like the old untrustworthyGap was, which is what makes it
  // catch the unmounted-while-driving case.
  //
  // Used for harsh-turn only, not hard-brake — see hardBrakeMinProportion's
  // comment for why: confirmed from a real capture, 2026-10-13, that
  // ordinary road vibration during NORMAL MOUNTED highway driving trips the
  // same magnitude/reorientation disturbance gate every few seconds, not
  // just continuous unmounted jostling does. Gating hard-brake on this long
  // dwell cost 4 of 5 confirmed-real hard brakes in that capture — each one
  // landed within recentDisturbanceMs of an earlier, unrelated road-noise
  // blip despite the phone being properly mounted throughout. Harsh-turn
  // has no equivalent proportionality cross-check and no confirmed true
  // positive in any capture yet to protect, so the stronger blanket
  // suppression stays there; hard-brake instead relies on per-sample
  // `disturbed` (immediate, not lingering) plus hardBrakeMinProportion to
  // tell a real brake from a jostled one.
  const unstable =
    justStarted ||
    (state.lastInstabilityAt != null && now - state.lastInstabilityAt < th.recentDisturbanceMs);

  const speed = sample.speedMph;
  if (speed != null && speed !== state.lastKnownSpeed) {
    // A genuinely new fix, not just another sample read against the same
    // ~1Hz GPS value — see priorKnownSpeed's comment. Keep the pair so the
    // real rate between them can be computed later, independent of how
    // long any particular brake/turn candidate has been open.
    if (state.lastKnownSpeed != null) {
      state.priorKnownSpeed = state.lastKnownSpeed;
      state.priorKnownSpeedAt = state.lastKnownSpeedAt;
    }
    state.lastKnownSpeed = speed;
    state.lastKnownSpeedAt = now;
  }
  const movingFastEnough = speed == null || speed >= th.minSpeedMph;

  // See harshTurnMaxLateralAccelMs2's comment: a real turn's yaw rate and the
  // car's GPS speed together imply a cornering force; reject a candidate
  // whose implied force is physically impossible for a street-driven car,
  // regardless of whether anything tripped `disturbed`/`unstable`. Lenient
  // when speed is unknown.
  const impliedLateralAccelMs2 =
    speed == null ? null : (speed * 0.44704) * ((state.smYaw * Math.PI) / 180);
  const yawPhysicallyPlausible =
    impliedLateralAccelMs2 == null ||
    impliedLateralAccelMs2 <= th.harshTurnMaxLateralAccelMs2;

  const events = [];

  const resetBrakeCandidate = () => {
    state.overSince['hard-brake'] = null;
    state.speedAtBrakeOnset = null;
    state.brakeQualifiedAt = null;
    state.brakePeakMag = null;
  };

  // Hard-brake gets its own path (rather than sharing the simple harsh-turn
  // one below) because of hardBrakeConfirmGraceMs: a qualified candidate has
  // to keep living, waiting on GPS, even after `over` itself goes false.
  const considerHardBrake = (over) => {
    if (!warm || disturbed || justStarted || !movingFastEnough) {
      resetBrakeCandidate();
      return;
    }

    if (over) {
      if (state.overSince['hard-brake'] == null) {
        state.overSince['hard-brake'] = now;
        state.speedAtBrakeOnset = state.lastKnownSpeed;
        state.brakePeakMag = state.smBrake;
      } else {
        state.brakePeakMag = Math.max(state.brakePeakMag, state.smBrake);
      }
      if (
        state.brakeQualifiedAt == null &&
        now - state.overSince['hard-brake'] >= th.eventMinDurationMs
      ) {
        state.brakeQualifiedAt = now;
      }
    } else if (state.brakeQualifiedAt == null) {
      // Dropped back under threshold before ever satisfying the duration
      // gate — a one-off spike (pothole, pickup), not a candidate.
      resetBrakeCandidate();
      return;
    }
    // else: the g-spike subsided after already qualifying — fall through and
    // keep resolving against the latched onset/peak for up to
    // hardBrakeConfirmGraceMs (see its comment).

    if (state.brakeQualifiedAt == null) return;

    const expired = now - state.brakeQualifiedAt > th.hardBrakeConfirmGraceMs;
    if (now - state.lastFired['hard-brake'] < th.eventCooldownMs) {
      if (expired) resetBrakeCandidate();
      return;
    }
    // See hardBrakeMinSpeedDropMph's comment: require GPS to corroborate an
    // actual slowdown since this candidate began, not just that the car was
    // moving. Lenient (let it through) when there was never an onset reading
    // at all, same philosophy as movingFastEnough.
    const onset = state.speedAtBrakeOnset;
    let confirmed = onset == null;
    if (!confirmed && speed != null && onset - speed >= th.hardBrakeMinSpeedDropMph) {
      confirmed = true; // the drop itself cleared the bar — proportion check may still downgrade it
      // See hardBrakeMinProportion's comment: a nonzero drop isn't enough by
      // itself — require it to be at least roughly in proportion to what the
      // peak accelerometer reading claims, using the real rate between the
      // last two distinct GPS fixes (not the brake candidate's own, often
      // much shorter, duration). Lenient — same as above — when there isn't
      // yet a distinct pair to compute a real rate from.
      if (state.priorKnownSpeed != null && state.priorKnownSpeedAt != null) {
        const gpsElapsedS = (state.lastKnownSpeedAt - state.priorKnownSpeedAt) / 1000;
        if (gpsElapsedS > 0) {
          const recentGpsMphPerS = (state.priorKnownSpeed - state.lastKnownSpeed) / gpsElapsedS;
          const impliedAccelMphPerS = state.brakePeakMag * MPS2_TO_MPH_PER_S;
          confirmed =
            impliedAccelMphPerS <= 0 ||
            recentGpsMphPerS / impliedAccelMphPerS >= th.hardBrakeMinProportion;
        }
      }
    }
    // See hardBrakeYawQuietMs's comment: applies regardless of GPS
    // availability — a chaotically jostling phone with no GPS fix is still
    // exactly the case this is meant to catch.
    if (confirmed && state.lastHighYawAt != null) {
      confirmed = now - state.lastHighYawAt >= th.hardBrakeYawQuietMs;
    }
    if (!confirmed) {
      if (expired) resetBrakeCandidate();
      return;
    }

    state.lastFired['hard-brake'] = now;
    const magnitude = state.brakePeakMag;
    resetBrakeCandidate();
    events.push({ type: 'hard-brake', magnitude, at: now });
  };

  const considerHarshTurn = (over) => {
    if (!warm || !over || !movingFastEnough || unstable) {
      state.overSince['harsh-turn'] = null;
      return;
    }
    if (state.overSince['harsh-turn'] == null) state.overSince['harsh-turn'] = now;
    if (now - state.overSince['harsh-turn'] < th.eventMinDurationMs) return;
    if (now - state.lastFired['harsh-turn'] < th.eventCooldownMs) return;
    state.lastFired['harsh-turn'] = now;
    state.overSince['harsh-turn'] = null;
    events.push({ type: 'harsh-turn', magnitude: state.smYaw, at: now });
  };

  // A turn also throws linear accel, so gate hard-brake on low yaw to keep one
  // physical event from firing as both.
  considerHardBrake(state.smBrake > th.hardBrakeMs2 && state.smYaw < th.harshTurnDegS);
  // Excludes implausibly fast yaw (see implausibleYawDegS) — that's the
  // phone spinning in a hand, not the vehicle turning.
  considerHarshTurn(
    state.smYaw > th.harshTurnDegS &&
      state.smYaw <= th.implausibleYawDegS &&
      yawPhysicallyPlausible
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
      reorientRateDegS,
      disturbed,
      unstable,
      impliedLateralAccelMs2,
      yawPhysicallyPlausible,
      holdBrakeMs: state.overSince['hard-brake'] == null ? 0 : now - state.overSince['hard-brake'],
      holdYawMs: state.overSince['harsh-turn'] == null ? 0 : now - state.overSince['harsh-turn'],
    },
  };
}
