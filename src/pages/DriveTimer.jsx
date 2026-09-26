import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { startMileageTracking } from '../utils/geo';
import { keepScreenAwake } from '../utils/device';
import { savePendingDrive } from '../utils/pendingDrive';
import { saveActiveDrive, readActiveDrive, clearActiveDrive } from '../utils/activeDrive';
import { localOffsetMinutes } from '../utils/driveTime';
import { startDriveTelematics, telematicsEnabled } from '../utils/telematics';
import { pulseSafetyAlert } from '../utils/haptics';

// What to tell the driver about GPS before any mileage has accumulated.
// `warning: true` means mileage will not be recorded in this state, so it is
// worth interrupting for — the drive would otherwise save with no distance
// and no map, with nothing having looked wrong along the way.
function gpsNotice({ status, accuracy }) {
  switch (status) {
    case 'tracking':
      return { label: 'GPS ready — 0.0 mi so far' };
    case 'imprecise':
      return {
        label: accuracy ? `Location too imprecise (±${Math.round(accuracy)} m)` : 'Location too imprecise',
        warning: true,
        hint: "Mileage won't be recorded. Turn on precise location for this site in your browser or phone settings, then restart the drive.",
      };
    case 'denied':
      return {
        label: 'Location access blocked',
        warning: true,
        // The site-level permission can read as allowed while the device
        // still refuses, so name both places rather than only the browser.
        hint: "Mileage won't be recorded. Check location is allowed both for this site and for your browser in the phone's privacy settings — on iOS that's Settings › Privacy & Security › Location Services › Safari Websites. You can still log the distance by hand.",
      };
    case 'unavailable':
      return {
        label: 'GPS signal unavailable',
        warning: true,
        hint: "Mileage won't be recorded until a signal is found — this is common indoors or in a garage.",
      };
    case 'unsupported':
      return {
        label: 'GPS not supported on this device',
        warning: true,
        hint: 'You can still time the drive and enter the distance by hand.',
      };
    default:
      return { label: 'Waiting for GPS…' };
  }
}

export default function DriveTimer() {
  const { studentId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Arrived via the Dashboard's "Resume" on a checkpoint left by a drive
  // whose app was killed mid-timing (see utils/activeDrive.js). Read once.
  const [resumed] = useState(() => {
    if (searchParams.get('resume') !== '1') return null;
    const cp = readActiveDrive();
    return cp && cp.studentId === studentId ? cp : null;
  });

  const [startTime] = useState(() => (resumed ? new Date(resumed.startTime) : new Date()));
  // Captured when the drive begins, so a drive that crosses into another zone
  // is still written down in the one it started in — see utils/driveTime.js.
  const [startOffsetMinutes] = useState(() => resumed?.startOffsetMinutes ?? localOffsetMinutes());
  const [elapsed, setElapsed] = useState(0);
  const [miles, setMiles] = useState(resumed?.miles ?? 0);
  const [gps, setGps] = useState({ status: 'waiting', accuracy: null, speedMph: null, maxSpeedMph: null });
  // hard-brake / harsh-turn counts for this drive. Only ever non-zero when
  // telematics detection is switched on (off by default — see telematics.js).
  const [safetyEvents, setSafetyEvents] = useState(
    () => resumed?.safetyEventCounts ?? { hardBrake: 0, harshTurn: 0 }
  );
  const safetyEventsRef = useRef(resumed?.safetyEventCounts ?? { hardBrake: 0, harshTurn: 0 });
  const interval = useRef(null);
  const checkpoint = useRef(null);
  const trackingRef = useRef(
    resumed
      ? {
          miles: resumed.miles ?? 0,
          start: resumed.start ?? null,
          end: resumed.end ?? null,
          route: resumed.route ?? [],
          maxSpeedMph: resumed.maxSpeedMph ?? null,
        }
      : { miles: 0, start: null, end: null, route: [], maxSpeedMph: null }
  );
  const stopTracking = useRef(null);
  const stopTelematics = useRef(null);
  const releaseWakeLock = useRef(null);

  useEffect(() => {
    // A resumed drive keeps its pre-kill miles/route as a fixed base; a fresh
    // tracking session only reports what it records from here.
    const base = resumed;

    const writeCheckpoint = () => {
      const t = trackingRef.current;
      saveActiveDrive(studentId, {
        startTime: startTime.toISOString(),
        startOffsetMinutes,
        miles: t.miles,
        route: t.route,
        start: t.start,
        end: t.end,
        maxSpeedMph: t.maxSpeedMph,
        safetyEventCounts: safetyEventsRef.current,
      });
    };

    interval.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.getTime()) / 1000));
    }, 1000);
    stopTracking.current = startMileageTracking(
      (update) => {
        const combined = base
          ? {
              ...update,
              miles: (base.miles ?? 0) + update.miles,
              route: [...(base.route ?? []), ...update.route],
              start: base.start ?? update.start,
              end: update.end ?? base.end ?? null,
              maxSpeedMph: Math.max(base.maxSpeedMph ?? 0, update.maxSpeedMph ?? 0) || null,
            }
          : update;
        trackingRef.current = combined;
        setMiles(combined.miles);
        setGps({
          status: update.status,
          accuracy: update.accuracy,
          speedMph: update.speedMph,
          maxSpeedMph: combined.maxSpeedMph,
          error: update.error,
        });
      },
      // Native: keep recording while the app is backgrounded (DEV-71). No-op
      // flag on web — falls back to watchPosition.
      { background: true }
    );

    // Checkpoint straight away (catches a kill in the first 20 s) then on a
    // slow interval — see utils/activeDrive.js.
    writeCheckpoint();
    checkpoint.current = setInterval(writeCheckpoint, 20000);
    if (telematicsEnabled()) {
      stopTelematics.current = startDriveTelematics({
        getSpeedMph: () => trackingRef.current?.speedMph ?? null,
        onEvent: ({ type }) => {
          pulseSafetyAlert();
          const key = type === 'harsh-turn' ? 'harshTurn' : 'hardBrake';
          safetyEventsRef.current = {
            ...safetyEventsRef.current,
            [key]: safetyEventsRef.current[key] + 1,
          };
          setSafetyEvents(safetyEventsRef.current);
        },
      });
    }
    releaseWakeLock.current = keepScreenAwake();
    return () => {
      clearInterval(interval.current);
      clearInterval(checkpoint.current);
      stopTracking.current?.();
      stopTelematics.current?.();
      releaseWakeLock.current?.();
      // Leave the checkpoint in place on a plain unmount (back button, tab
      // switch) so the Dashboard can still offer to resume. Only End Drive
      // and an explicit Discard clear it.
    };
  }, [startTime]);

  const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  const endDrive = () => {
    clearInterval(interval.current);
    clearInterval(checkpoint.current);
    stopTracking.current?.();
    stopTelematics.current?.();
    clearActiveDrive(); // the drive is being handed to the log form now
    const endTime = new Date();
    const { miles: trackedMiles, start, end, route, maxSpeedMph } = trackingRef.current;
    const ev = safetyEventsRef.current;
    const prefill = {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      startOffsetMinutes,
      distanceMiles: trackedMiles > 0 ? Number(trackedMiles.toFixed(1)) : null,
      maxSpeedMph: maxSpeedMph != null ? Math.round(maxSpeedMph) : null,
      safetyEventCounts: ev.hardBrake || ev.harshTurn ? { ...ev } : null,
      startLocation: start,
      endLocation: end,
      route: route && route.length > 1 ? route : null,
    };

    // Navigation state alone is lost if the log form's tab reloads before the
    // drive is saved, which takes the GPS results with it — back it up, and
    // mark the URL so the form knows to look. See src/utils/pendingDrive.js.
    savePendingDrive(studentId, prefill);
    navigate(`/log-drive/${studentId}?pending=1`, { state: { prefill }, replace: true });
  };

  return (
    <div className="timer-screen">
      <div className="timer-label">Drive in progress</div>
      <div className="timer-readout mono">{hh}:{mm}:{ss}</div>
      <div className="timer-hint">
        Started at {startTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>

      {/* Live speed, for the supervising adult to glance at against the
          posted signs — the app has no speed-limit data of its own, so the
          comparison is theirs to make. '--' whenever there's no trustworthy
          reading (no fix yet, too coarse, or the plausibility gate rejected
          it) rather than a stale or zero number that looks real. */}
      <div className="timer-speed">
        <span className="timer-speed-value mono">
          {gps.status === 'tracking' && gps.speedMph != null ? Math.round(gps.speedMph) : '––'}
        </span>
        <span className="timer-speed-unit">mph</span>
        <span className="timer-speed-max">
          {gps.maxSpeedMph != null ? `Top speed this drive: ${Math.round(gps.maxSpeedMph)} mph` : ' '}
        </span>
      </div>

      {/* Always say something about GPS. A drive that records nothing should
          look wrong while it's happening, not at save time. */}
      {miles > 0 ? (
        <div className="timer-miles mono">{miles.toFixed(1)} mi (GPS estimate)</div>
      ) : (
        <div className="timer-miles" style={gpsNotice(gps).warning ? { color: 'var(--danger)' } : undefined}>
          {gpsNotice(gps).label}
        </div>
      )}
      {(safetyEvents.hardBrake > 0 || safetyEvents.harshTurn > 0) && (
        <div className="timer-events">
          {safetyEvents.hardBrake > 0 && `${safetyEvents.hardBrake} hard braking`}
          {safetyEvents.hardBrake > 0 && safetyEvents.harshTurn > 0 && ' · '}
          {safetyEvents.harshTurn > 0 && `${safetyEvents.harshTurn} harsh turn${safetyEvents.harshTurn > 1 ? 's' : ''}`}
        </div>
      )}
      <button className="ignition-btn" onClick={endDrive}>End Drive</button>
      <p className="timer-gps-hint">
        {gpsNotice(gps).hint ??
          (Capacitor.isNativePlatform()
            ? 'Mileage and route keep recording if you switch apps. Tracking still stops if you close Student Drive Log.'
            : 'Keep this screen open for accurate GPS mileage — tracking pauses if you switch apps or lock your phone.')}
      </p>
      {/* The browser's own wording for the failure. Kept small and last: it's
          for working out what actually went wrong, which reasoning from the
          symptom alone has proven unreliable. */}
      {gps.error?.message && (
        <p className="timer-gps-hint" style={{ marginTop: 8, opacity: 0.7 }}>
          Reported by your browser: {gps.error.message}
          {gps.error.code != null ? ` (code ${gps.error.code})` : ''}
        </p>
      )}
    </div>
  );
}
