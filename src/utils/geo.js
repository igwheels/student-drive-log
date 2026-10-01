import { Capacitor, registerPlugin } from '@capacitor/core';

// @capacitor-community/background-geolocation — keeps delivering fixes while
// the app is backgrounded during a drive (DEV-71). Native only; on web the
// proxy throws when called, which is why every use is behind
// Capacitor.isNativePlatform().
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const EARTH_RADIUS_MILES = 3958.8;

// Ignore GPS points that jump further than this in one reading — almost
// always a bad fix rather than the car actually teleporting.
const MAX_JUMP_MILES = 1;

// Reject fixes coarser than this when accumulating mileage. This was 50m,
// which turned out to be stricter than a phone in a moving car reliably
// achieves — an urban canyon or an overcast cold start can sit above it for
// a whole drive, and every reading was then dropped in silence, producing a
// drive with no distance and no map. 100m still excludes the ~1-3km readings
// that "approximate location" (iOS Precise Location off, Android approximate
// mode) reports, which is the case actually worth rejecting.
const MAX_ACCURACY_METERS = 100;

// coords.speed is metres per second; the rest of the app is US units (miles,
// mph). Exact by definition: 1 mile = 1609.344 m, 1 h = 3600 s.
const MPH_PER_MPS = 3600 / 1609.344;

// Above this, a "speed" is a GPS artefact — a bad fix or a cold start — not a
// car on a road with a learner at the wheel. Drop it rather than flash 140
// on the timer or bank it as the drive's top speed.
const IMPLAUSIBLE_SPEED_MPH = 120;

// Below this, a "speed" is Doppler noise, not motion — consumer GNSS derives
// coords.speed from the carrier's Doppler shift, which commonly jitters a
// few mph even sitting still (multipath, satellite geometry), especially at
// a stop light with buildings/trees around. Clamped to 0 rather than
// dropped like IMPLAUSIBLE_SPEED_MPH: dropping it would freeze the readout
// on the last real speed instead of honestly showing the vehicle stopped.
const MIN_PLAUSIBLE_SPEED_MPH = 3;

// Reject a speed sample that would need harder acceleration than any street
// car manages (~0.5 g). One-directional on purpose: real braking can be
// sharper than this, so a large drop is left alone — only an implausible
// jump *up* between consecutive fixes is treated as noise.
const MAX_ACCEL_MPH_PER_S = 12;

// Reported 2026-10-02 from real test drives: speed didn't reliably reach 0
// at a stop. MIN_PLAUSIBLE_SPEED_MPH alone can't fully fix this — the
// comment on it already admits Doppler jitter is "a few mph", which isn't
// bounded at 3, and raising that floor further would start hiding genuine
// slow driving (a parking lot, stop-and-go traffic). Position is the more
// reliable signal at a stop: consecutive fixes from a genuinely stationary
// car cluster within normal GPS wander, while coords.speed keeps deriving
// from the noisier Doppler estimate regardless. If fixes haven't shown real
// movement for STOPPED_LATCH_MS, the displayed speed is forced to 0 no
// matter what coords.speed still reports.
const STOPPED_LATCH_MS = 2000;
// A fix-to-fix jump below this is normal GPS wander while parked, not
// movement — roughly a car length, well under what even a slow walk covers
// between the ~1s fixes watchPosition typically delivers.
const STOPPED_LATCH_DISTANCE_MILES = 0.003;

// GeolocationPositionError codes, per spec.
const GEO_PERMISSION_DENIED = 1;
const GEO_POSITION_UNAVAILABLE = 2;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

/**
 * Converts a GPS `coords.speed` value (metres per second) to mph.
 *
 * Returns null for the values the Geolocation spec allows in place of a real
 * reading: null (device can't measure ground speed — common on desktop and
 * some Android fixes) and, defensively, anything negative or non-finite.
 * A genuine 0 (stopped, speed known) passes through as 0.
 */
export function metersPerSecondToMph(mps) {
  if (mps == null || !Number.isFinite(mps) || mps < 0) return null;
  return mps * MPH_PER_MPS;
}

/**
 * Reads the current geolocation permission state ('granted' | 'denied' |
 * 'prompt' | 'unsupported') and calls onChange with it whenever it changes.
 * Returns an unsubscribe function.
 */
export function watchLocationPermissionStatus(onChange) {
  if (!navigator.permissions?.query) {
    onChange('unsupported');
    return () => {};
  }

  let status = null;
  try {
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((result) => {
        status = result;
        onChange(status.state);
        status.onchange = () => onChange(status.state);
      })
      .catch(() => onChange('unsupported'));
  } catch {
    // Some browsers throw synchronously for an unsupported permission name
    // rather than rejecting the promise.
    onChange('unsupported');
  }

  return () => {
    if (status) status.onchange = null;
  };
}

/**
 * Actually asks for a position and reports what happens, rather than what the
 * permission registry claims.
 *
 * navigator.permissions.query() only knows the *site's* permission. It will
 * happily answer 'granted' while the device refuses at the OS level — iOS
 * Settings › Privacy & Security › Location Services › Safari Websites set to
 * Never does exactly that. The Account page previously reported that state as
 * "Allowed", so someone whose location was switched off system-wide was told
 * everything was fine while no drive could record any mileage.
 *
 * Resolves (never rejects) to { state, accuracy?, code?, message? } where
 * state is 'working' | 'imprecise' | 'denied' | 'unavailable' | 'timeout' |
 * 'unsupported'. 'imprecise' means a position came back but is too coarse to
 * accumulate mileage from — the other way tracking fails while looking fine.
 */
export function probeLocationAccess() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ state: 'unsupported' });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const accuracy = position.coords.accuracy ?? null;
        resolve({
          state: accuracy != null && accuracy > MAX_ACCURACY_METERS ? 'imprecise' : 'working',
          accuracy,
        });
      },
      (error) => {
        const code = error?.code ?? null;
        const message = error?.message || '';
        if (code === GEO_PERMISSION_DENIED) resolve({ state: 'denied', code, message });
        else if (code === GEO_POSITION_UNAVAILABLE) resolve({ state: 'unavailable', code, message });
        else resolve({ state: 'timeout', code, message });
      },
      // Deliberately not high-accuracy: this is a "does location work at all"
      // check, and a cached recent fix answers that just as well.
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  });
}

export function requestLocationPermission() {
  if (!navigator.geolocation) return;
  // Triggers the browser's permission prompt now, so it's already granted
  // (or denied) by the time a drive timer needs live position updates.
  navigator.geolocation.getCurrentPosition(
    () => {},
    () => {},
    { enableHighAccuracy: false, timeout: 5000 }
  );
}

/**
 * Tracks cumulative miles traveled — as the sum of the distance between each
 * consecutive GPS fix along the way, not a straight line from start to end —
 * plus the full sequence of fixes.
 *
 * `options.background: true` on a native build routes fixes through
 * @capacitor-community/background-geolocation, which keeps them coming while
 * the app is backgrounded (see docs/background-drive-tracking-spec.md);
 * `options.backgroundTitle` / `.backgroundMessage` set the Android
 * foreground-service notification text. On web (and native without
 * `background`) it uses navigator.geolocation.watchPosition, which the OS
 * suspends when the app leaves the foreground.
 *
 * Returns a stop() function. onUpdate({ miles, start, end, route, status,
 * accuracy, speedMph, heading, maxSpeedMph }) fires immediately and then on
 * every fix or error, where start/end are { lat, lng } and route is the full
 * [{ lat, lng }, ...] path.
 *
 * speedMph and heading are the current fix's `coords.speed` (converted to
 * mph) and `coords.heading` (degrees clockwise from true north), for the
 * real-time driving-safety layer (the drive-timer speed readout, the
 * accel-event speed gate). speedMph is passed through a plausibility gate
 * first (see IMPLAUSIBLE_SPEED_MPH / MAX_ACCEL_MPH_PER_S); maxSpeedMph is the
 * highest gated reading so far this drive, for recording a drive's top speed.
 * Any of the three is null when the device doesn't report speed/heading, when
 * heading is undefined because the vehicle is stationary, or on a fix too
 * coarse to use — trust them only while status is 'tracking', as with
 * `accuracy`.
 *
 * status is one of:
 *   'unsupported' — no geolocation API in this browser
 *   'waiting'     — watching, no usable fix yet
 *   'tracking'    — recording fixes
 *   'imprecise'   — fixes arriving but too coarse to use (see
 *                   MAX_ACCURACY_METERS); `accuracy` carries the last value
 *   'denied'      — permission refused
 *   'unavailable' — position could not be determined
 *
 * The caller is expected to surface anything other than 'tracking'. Reporting
 * status is the point: these states previously failed silently, so a drive
 * could run to completion having recorded nothing, and the first sign of it
 * was a saved log with no distance and no map.
 */
export function startMileageTracking(onUpdate, options = {}) {
  let totalMiles = 0;
  let lastFix = null;
  const route = [];
  let watchId = null;
  let status = 'waiting';
  let lastAccuracy = null;
  let lastSpeedMph = null;
  let lastHeading = null;
  let maxSpeedMph = null;
  // The last speed reading that cleared the plausibility gate, with the time
  // of its fix — the next reading is checked for impossible acceleration
  // against it.
  let lastAcceptedSpeed = null;
  let lastAcceptedSpeedAt = null;
  // When a fix last showed real movement (see STOPPED_LATCH_DISTANCE_MILES) —
  // null until the first fix, then updated on every fix that clears it, never
  // on one that doesn't. Drives the STOPPED_LATCH_MS force-to-0 above.
  let lastMovedAt = null;
  // The browser's own account of the last failure, passed through so the UI
  // can show it. Geolocation failures are otherwise indistinguishable from
  // the outside, and guessing at them from behaviour alone has cost time.
  let lastError = null;

  const report = () =>
    onUpdate({
      miles: totalMiles,
      start: route[0] ?? null,
      end: route[route.length - 1] ?? null,
      route: route.slice(),
      status,
      accuracy: lastAccuracy,
      speedMph: lastSpeedMph,
      heading: lastHeading,
      maxSpeedMph,
      error: lastError,
    });

  // One fix, from either source, normalized to
  // { latitude, longitude, accuracy, speed, heading } + a time in ms.
  const handleFix = ({ latitude, longitude, accuracy, speed, heading }, timeMs) => {
    lastAccuracy = accuracy ?? null;

    // A very inaccurate fix can swing distance wildly, so it isn't recorded —
    // but it is reported, so the timer can tell the driver that location is
    // too coarse to log rather than just showing nothing.
    if (accuracy != null && accuracy > MAX_ACCURACY_METERS) {
      status = 'imprecise';
      // Don't vouch for speed/heading off a fix we're rejecting for distance.
      lastSpeedMph = null;
      lastHeading = null;
      report();
      return;
    }

    lastError = null; // a usable fix supersedes any earlier failure

    // The spec leaves heading NaN (not just null) when the device is
    // stationary, so a plain null-check isn't enough.
    lastHeading = Number.isFinite(heading) && heading >= 0 ? heading : null;

    // Plausibility-gate the speed before showing it or letting it set the
    // drive's top speed: drop GPS artefacts (IMPLAUSIBLE_SPEED_MPH) and any
    // reading that implies impossible acceleration since the last trusted one.
    // A gap of several seconds (backgrounded app) makes the allowed delta
    // large, which is the honest answer — we can't judge across it.
    let speedMph = metersPerSecondToMph(speed);
    if (speedMph != null && speedMph > IMPLAUSIBLE_SPEED_MPH) speedMph = null;
    if (speedMph != null && speedMph < MIN_PLAUSIBLE_SPEED_MPH) speedMph = 0;
    if (speedMph != null && lastAcceptedSpeed != null && lastAcceptedSpeedAt != null) {
      const dtSec = (timeMs - lastAcceptedSpeedAt) / 1000;
      if (dtSec > 0 && speedMph - lastAcceptedSpeed > MAX_ACCEL_MPH_PER_S * dtSec) {
        speedMph = null;
      }
    }
    lastSpeedMph = speedMph;
    if (speedMph != null) {
      lastAcceptedSpeed = speedMph;
      lastAcceptedSpeedAt = timeMs;
      if (maxSpeedMph == null || speedMph > maxSpeedMph) maxSpeedMph = speedMph;
    }

    let delta = null;
    if (lastFix) {
      delta = haversineMiles(lastFix.latitude, lastFix.longitude, latitude, longitude);
      // An implausible jump between fixes doesn't count toward mileage — it is
      // a gap in tracking (backgrounded app, tunnel), not distance we can
      // vouch for. lastFix still advances: leaving it behind would measure
      // every later fix against a stale point, and once the car had moved more
      // than MAX_JUMP_MILES away, every one of them would be rejected too and
      // tracking would never recover for the rest of the drive.
      if (delta <= MAX_JUMP_MILES) totalMiles += delta;
    }

    // Stop latch (see STOPPED_LATCH_MS above) — overrides whatever the
    // plausibility gate above produced. No baseline yet (delta == null, the
    // very first fix of the drive) counts as "just moved": there's nothing to
    // measure a stop against, and assuming stationary before the drive has
    // even started isn't the honest default.
    if (delta == null || delta > STOPPED_LATCH_DISTANCE_MILES) {
      lastMovedAt = timeMs;
    } else if (lastMovedAt != null && timeMs - lastMovedAt >= STOPPED_LATCH_MS) {
      lastSpeedMph = 0;
      lastAcceptedSpeed = 0;
      lastAcceptedSpeedAt = timeMs;
    }

    lastFix = { latitude, longitude };
    route.push({ lat: latitude, lng: longitude });
    status = 'tracking';
    report();
  };

  // One failure, normalized to { code, message } where code follows the
  // GeolocationPositionError spec numbers. Compared against 1 and 2 rather
  // than error.PERMISSION_DENIED etc.: hand it anything that isn't a real
  // GeolocationPositionError and both sides are undefined, so a plain timeout
  // would report as a denied permission. Comparing to numbers just doesn't
  // match instead.
  const handleError = (error) => {
    lastError = { code: error?.code ?? null, message: error?.message || '' };
    if (error?.code === GEO_PERMISSION_DENIED) status = 'denied';
    else if (error?.code === GEO_POSITION_UNAVAILABLE) status = 'unavailable';
    // A timeout just means no fix yet; the watch keeps trying, so the honest
    // state is still 'waiting' unless we already had one.
    else if (route.length === 0) status = 'waiting';
    report();
  };

  // Native + background: the community background-geolocation plugin. Its
  // callback keeps firing while the app is backgrounded (iOS location
  // background mode / Android foreground service).
  if (options.background && Capacitor.isNativePlatform()) {
    let watcherId = null;
    let removed = false;

    report(); // 'waiting'

    BackgroundGeolocation.addWatcher(
      {
        // Defining backgroundMessage is what enables background delivery.
        backgroundTitle: options.backgroundTitle || 'Recording your drive',
        backgroundMessage:
          options.backgroundMessage || 'Mileage and route are still being logged.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10,
      },
      (location, error) => {
        if (error) {
          handleError(
            error.code === 'NOT_AUTHORIZED'
              ? { code: GEO_PERMISSION_DENIED, message: error.message }
              : { code: GEO_POSITION_UNAVAILABLE, message: error?.message }
          );
          return;
        }
        if (!location) return;
        handleFix(
          {
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy,
            speed: location.speed,
            heading: location.bearing, // plugin's name for heading
          },
          location.time ?? Date.now()
        );
      }
    )
      .then((id) => {
        watcherId = id;
        if (removed) BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
      })
      .catch((e) => handleError({ code: GEO_POSITION_UNAVAILABLE, message: String(e?.message || e) }));

    return () => {
      removed = true;
      if (watcherId != null) BackgroundGeolocation.removeWatcher({ id: watcherId }).catch(() => {});
    };
  }

  if (!navigator.geolocation) {
    status = 'unsupported';
    report();
    return () => {};
  }

  report(); // 'waiting', so the UI can say so before the first fix lands

  watchId = navigator.geolocation.watchPosition(
    (position) => handleFix(position.coords, position.timestamp),
    (error) => handleError(error),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );

  return () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
  };
}
