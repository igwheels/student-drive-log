import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { auth } from '../firebase';
import {
  sendPasswordResetEmail,
  deleteUser,
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  GoogleAuthProvider,
} from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { watchLocationPermissionStatus, probeLocationAccess } from '../utils/geo';
import { getFamilyPackProduct, purchaseFamilyPack, requestFamilyPackRefund } from '../utils/entitlements';
import {
  getWeeklyEmailOptOut,
  setWeeklyEmailOptOut,
  deleteWeeklyEmailPreference,
} from '../utils/emailPreferences';
import {
  safetyHapticsEnabled,
  setSafetyHapticsEnabled,
  hapticsAvailable,
  pulseSafetyAlert,
} from '../utils/haptics';
import { setTelematicsEnabled } from '../utils/telematics';
import {
  checkBiometryAvailability,
  isBiometricEnabledForUser,
  setBiometricEnabledForUser,
  authenticateWithBiometrics,
} from '../utils/biometricAuth';

const DELETE_PHRASE = 'Delete this account and all its dashboards forever.';

// Student emails are stored as typed (AddStudent/ManageStudents only trim),
// while shared-viewer addresses are already lowercased — so compare normalized.
const normalizeEmail = (email) => email.trim().toLowerCase();

// What the browser's permission registry says. This is only ever a hint: it
// reports the *site's* permission and is blind to the device refusing at the
// OS level, so 'granted' does not mean location actually works. The probe
// below is what settles it.
const LOCATION_STATUS_INFO = {
  granted: { label: 'Allowed for this site', color: 'var(--muted)', hint: 'Checking whether your device actually provides a location…' },
  denied: {
    label: 'Blocked',
    color: 'var(--danger)',
    hint: 'Mileage won’t auto-fill. Allow location for this site in your browser settings to re-enable it.',
  },
  prompt: { label: 'Not yet asked', color: 'var(--muted)', hint: 'You’ll be asked to allow it below.' },
  unsupported: { label: 'Unknown', color: 'var(--muted)', hint: 'This browser can’t report permission status — check it directly instead.' },
};

// What actually happened when a position was requested. Authoritative.
const LOCATION_PROBE_INFO = {
  working: { label: 'Working', color: 'var(--success)', hint: 'Drive mileage will be estimated from GPS.' },
  imprecise: {
    label: 'Too imprecise',
    color: 'var(--danger)',
    hint: 'Location is on, but the readings are too coarse to measure a drive. Turn on precise location for this site — on iOS that’s Settings › Privacy & Security › Location Services › Safari Websites › Precise Location.',
  },
  denied: {
    label: 'Blocked',
    color: 'var(--danger)',
    // The case that prompted this: the site permission read as allowed while
    // the device refused, and the page reported it as working.
    hint: 'Your device refused to provide a location. Check both this site’s permission and your device’s location settings — on iOS that’s Settings › Privacy & Security › Location Services, and the Safari Websites entry within it.',
  },
  unavailable: {
    label: 'No signal',
    color: 'var(--danger)',
    hint: 'Your device couldn’t determine a position. This is common indoors or in a garage.',
  },
  timeout: {
    label: 'No response',
    color: 'var(--danger)',
    hint: 'Your device didn’t return a position in time. Try again, ideally outdoors.',
  },
  unsupported: { label: 'Not supported', color: 'var(--muted)', hint: 'This browser doesn’t provide location at all.' },
};

export default function Account() {
  const { user, students, deleteStudent, deleteSessionClaim, logout, hasFamilyPack, restorePurchases, isOwner } =
    useApp();
  const navigate = useNavigate();

  const [resetStatus, setResetStatus] = useState('');

  const [locationStatus, setLocationStatus] = useState(null);
  useEffect(() => watchLocationPermissionStatus(setLocationStatus), []);

  const [probe, setProbe] = useState(null);
  const [probing, setProbing] = useState(false);

  const [familyPackProduct, setFamilyPackProduct] = useState(null);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState('');
  const [refunding, setRefunding] = useState(false);
  const [refundStatus, setRefundStatus] = useState('');
  const [confirmingRefund, setConfirmingRefund] = useState(false);

  // Which student stays fully usable if Family Pack is refunded — matches
  // functions/src/entitlementFanout.js's "oldest by creation time" rule.
  // Student ids are Date.now().toString(36) + a random suffix (see
  // AppContext.jsx's addStudent), so ascending string sort already sorts by
  // creation time for any id created this app has ever existed (holds
  // until roughly the year 2059, when the base-36 timestamp gains an
  // extra digit — the server-side version doesn't have this limit, since
  // it sorts by Firestore's own creation-time metadata instead; this is
  // only for naming the right student in the warning below).
  const ownedStudents = students.filter((s) => isOwner(s.id));
  const oldestOwnedStudent = [...ownedStudents].sort((a, b) => (a.id < b.id ? -1 : 1))[0];

  // Fetches the live price to display — required by both stores' review
  // guidelines, see getFamilyPackProduct. Skipped once already entitled,
  // and silently left null if unavailable (e.g. no store account signed
  // in), in which case the button falls back to a static "$9.99".
  useEffect(() => {
    if (hasFamilyPack || !Capacitor.isNativePlatform()) return;
    getFamilyPackProduct().then(setFamilyPackProduct);
  }, [hasFamilyPack]);

  const handleBuyFamilyPack = async () => {
    setPurchaseError('');
    setPurchasing(true);
    try {
      await purchaseFamilyPack();
      // hasFamilyPack flips on its own via AppContext's live entitlement
      // subscription once the server grants it — nothing to set here.
    } catch (e) {
      setPurchaseError(
        e.code === 'functions/unimplemented'
          ? 'Family Pack purchases aren’t live yet — check back soon.'
          : e.message || 'Purchase failed.'
      );
    } finally {
      setPurchasing(false);
    }
  };

  const handleRestorePurchases = async () => {
    setPurchaseError('');
    setRestoreStatus('');
    setRestoring(true);
    try {
      await restorePurchases();
      setRestoreStatus('Restored — Family Pack is now active.');
    } catch (e) {
      setRestoreStatus(e.message || 'Nothing to restore.');
    } finally {
      setRestoring(false);
    }
  };

  const handleRequestRefund = async () => {
    setConfirmingRefund(false);
    setRefundStatus('');
    setRefunding(true);
    try {
      const status = await requestFamilyPackRefund();
      setRefundStatus(
        status === 'success'
          ? 'Refund requested. Family Pack stays active until Apple approves it — if approved, the limits below take effect then.'
          : status === 'userCancelled'
            ? ''
            : 'Refund request submitted.'
      );
    } catch (e) {
      setRefundStatus(e.message || 'Could not start the refund request.');
    } finally {
      setRefunding(false);
    }
  };

  const runProbe = () => {
    setProbing(true);
    probeLocationAccess()
      .then(setProbe)
      .finally(() => setProbing(false));
  };

  // Probe automatically only when the site permission already says granted —
  // that's the case where the answer can be wrong, and asking costs no prompt
  // because permission is already held. When the state is 'prompt' or
  // 'denied', probing would either raise a surprise permission dialog or tell
  // us nothing new, so it's left to the buttons below.
  useEffect(() => {
    if (locationStatus === 'granted') runProbe();
    else setProbe(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationStatus]);

  // No document for this email means subscribed by default — matches the
  // weekly-email sender's own default, so a brand-new account starts opted in.
  const [weeklyEmailOptIn, setWeeklyEmailOptIn] = useState(true);
  useEffect(() => {
    if (!user?.email) return;
    getWeeklyEmailOptOut(user.email).then((optedOut) => setWeeklyEmailOptIn(!optedOut));
  }, [user?.email]);

  const handleWeeklyEmailToggle = async (e) => {
    const checked = e.target.checked;
    setWeeklyEmailOptIn(checked);
    try {
      await setWeeklyEmailOptOut(user.email, !checked);
    } catch (err) {
      console.error('Failed to update email preference:', err);
      setWeeklyEmailOptIn(!checked);
    }
  };

  const [safetyHaptics, setSafetyHaptics] = useState(() => safetyHapticsEnabled());
  // sdl_telematics (detection) used to have no UI at all — see the toggle
  // handler below — so an install from before this was wired up can have
  // safetyHaptics already 'on' (its default) while detection has still
  // never once been turned on. Sync it here too, not just on toggle, so
  // reaching this page is enough to fix that without the user having to
  // uncheck and recheck a box that already looks correct.
  useEffect(() => {
    setTelematicsEnabled(safetyHaptics);
  }, [safetyHaptics]);
  const handleSafetyHapticsToggle = (e) => {
    const on = e.target.checked;
    setSafetyHaptics(on);
    setSafetyHapticsEnabled(on);
    // sdl_telematics (detection itself) is kept in sync by the effect
    // above, driven off this same state — see its comment for why that's
    // needed on top of just handling the toggle here.
    // Buzz once on enable so it's clear what was just turned on.
    if (on) pulseSafetyAlert();
  };

  // DEV-28: only shown at all if this device actually has biometrics
  // available — a toggle for a feature the hardware can't do isn't a real
  // choice, it's just clutter. checkBiometryAvailability() is a no-op
  // returning isAvailable:false on web, so this naturally never shows
  // there without needing its own platform check first.
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  // The human-readable name for THIS device's actual mechanism ("Face
  // ID", "Touch ID", "your fingerprint", ...) — never hardcode a
  // specific one, an iPhone SE or an Android device doesn't have Face ID.
  const [biometricLabel, setBiometricLabel] = useState('biometrics');
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState('');
  useEffect(() => {
    if (!user?.id) return;
    checkBiometryAvailability().then(({ isAvailable, label }) => {
      setBiometricAvailable(isAvailable);
      setBiometricLabel(label);
      if (isAvailable) setBiometricEnabled(isBiometricEnabledForUser(user.id));
    });
  }, [user?.id]);

  const handleBiometricToggle = async (e) => {
    const checked = e.target.checked;
    setBiometricError('');
    if (!checked) {
      // Turning off never needs to prove anything — just stop gating.
      setBiometricEnabled(false);
      setBiometricEnabledForUser(user.id, false);
      return;
    }
    // Turning on: confirm it actually works on this device right now
    // before flipping the preference, same as the post-sign-in enrollment
    // prompt — otherwise a device that reports biometrics as available
    // but then fails outright would start locking someone out on the
    // very next open.
    setBiometricBusy(true);
    // Generic, like the enrollment prompt's equivalent call — this text
    // only surfaces inside the OS's own system dialog, not this page.
    const result = await authenticateWithBiometrics('Confirm to enable biometric unlock for Student Drive Log');
    setBiometricBusy(false);
    if (result.ok) {
      setBiometricEnabled(true);
      setBiometricEnabledForUser(user.id, true);
    } else if (result.code !== 'userCancel') {
      setBiometricError("Couldn't confirm biometric unlock on this device.");
    }
  };

  const [deleteInput, setDeleteInput] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');

  const handlePasswordReset = async () => {
    setResetStatus('');
    try {
      await sendPasswordResetEmail(auth, user.email);
      setResetStatus(`Password reset email sent to ${user.email}.`);
    } catch (e) {
      setResetStatus(e.message || 'Could not send reset email.');
    }
  };

  const performDeletion = async () => {
    const owned = students.filter((s) => s.ownerId === user.id);
    for (const s of owned) {
      // Also clears each student's directory entry, access requests, and
      // queued invitations — see deleteStudent in AppContext.jsx.
      await deleteStudent(s.id);
    }

    // The preference document is keyed by the email address itself, so
    // normally it's dropped here rather than left on file after the account
    // is gone.
    //
    // Not when the address is still a recipient, though. Weekly emails go to
    // each student's own address and to anyone the dashboard is shared with
    // (see scripts/send-weekly-emails.js), and those live on dashboards this
    // account doesn't own — so they outlive it. Since "no preference
    // document" means subscribed, deleting the record unconditionally would
    // silently resubscribe someone who had deliberately opted out: a student
    // who opts out and then deletes their login would start receiving the
    // emails again. Keeping the record costs only that the address stays in
    // emailPreferences, and it's already on the owner's student document
    // regardless.
    const myEmail = normalizeEmail(user.email || '');
    const survivingStudents = students.filter((s) => s.ownerId !== user.id);
    const stillAnEmailRecipient = survivingStudents.some(
      (s) =>
        normalizeEmail(s.email || '') === myEmail ||
        (s.sharedWithEmails ?? []).some((e) => normalizeEmail(e) === myEmail)
    );

    if (!stillAnEmailRecipient) {
      try {
        await deleteWeeklyEmailPreference(user.email);
      } catch (e) {
        console.warn('Failed to remove email preference:', e);
      }
    }

    // Take the single-active-session record with the account, while still
    // authenticated — the rules can't authorize this once the auth user is
    // gone. Non-fatal (see deleteSessionClaim in AppContext.jsx).
    await deleteSessionClaim(user.id);

    await deleteUser(auth.currentUser);
    logout();
    navigate('/');
  };

  const handleDeleteAccount = async () => {
    setDeleteError('');
    if (deleteInput !== DELETE_PHRASE) return;
    setDeleting(true);
    try {
      await performDeletion();
    } catch (e) {
      if (e.code === 'auth/requires-recent-login') {
        setNeedsReauth(true);
      } else {
        setDeleteError(e.message || 'Could not delete account.');
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleReauthAndDelete = async () => {
    setDeleteError('');
    setDeleting(true);
    try {
      const providerId = auth.currentUser.providerData[0]?.providerId;
      if (providerId === 'google.com') {
        await reauthenticateWithPopup(auth.currentUser, new GoogleAuthProvider());
      } else {
        if (!reauthPassword) {
          setDeleteError('Enter your password to confirm.');
          setDeleting(false);
          return;
        }
        await reauthenticateWithCredential(
          auth.currentUser,
          EmailAuthProvider.credential(user.email, reauthPassword)
        );
      }
      await performDeletion();
    } catch (e) {
      setDeleteError(e.message || 'Could not re-authenticate.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Account</h2>
      <p style={{ color: 'var(--muted)', marginBottom: 28 }}>{user?.email}</p>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>Password</h3>
        <button className="btn btn-outline" onClick={handlePasswordReset}>
          Send password reset email
        </button>
        {resetStatus && <p style={{ fontSize: 13, marginTop: 10, color: 'var(--muted)' }}>{resetStatus}</p>}
      </section>

      <section style={{ borderTop: '1px solid var(--line)', paddingTop: 24, marginBottom: 32 }}>
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>Location access</h3>
        {!locationStatus && (
          <p style={{ fontSize: 14, color: 'var(--muted)' }}>Checking…</p>
        )}
        {locationStatus && (() => {
          // The probe wins wherever it has run: it reflects what the device
          // actually did, while the permission state only reflects what this
          // site was granted.
          const info = probe
            ? LOCATION_PROBE_INFO[probe.state] ?? LOCATION_STATUS_INFO.unsupported
            : LOCATION_STATUS_INFO[locationStatus];
          const showCheckButton =
            !probing && (locationStatus === 'unsupported' || (probe && probe.state !== 'working'));

          return (
            <>
              <p style={{ fontSize: 14, marginBottom: 4 }}>
                Status:{' '}
                <span style={{ fontWeight: 700, color: info.color }}>
                  {probing ? 'Checking…' : info.label}
                </span>
                {probe?.state === 'imprecise' && probe.accuracy != null && (
                  <span style={{ color: 'var(--muted)' }}> (±{Math.round(probe.accuracy)} m)</span>
                )}
              </p>
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>{info.hint}</p>

              {probe?.message && (
                <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12, opacity: 0.8 }}>
                  Reported by your browser: {probe.message}
                  {probe.code != null ? ` (code ${probe.code})` : ''}
                </p>
              )}

              {locationStatus === 'prompt' && probe?.state !== 'working' && (
                // runProbe, not requestLocationPermission: both ask for a
                // position (which is what actually triggers the OS/WebView
                // permission prompt), but only the probe reports back what
                // happened. requestLocationPermission is fire-and-forget, so
                // this card used to just sit on "Not yet asked" after a
                // click — it was relying on the Permissions API's onchange
                // event to notice the grant, which Android's WebView doesn't
                // reliably fire (see watchLocationPermissionStatus). The
                // probe?.state check hides this once the probe below has
                // already confirmed it's working, even though locationStatus
                // itself may never flip to 'granted' on Android.
                <button className="btn btn-outline" onClick={runProbe} disabled={probing}>
                  {probing ? 'Checking…' : 'Allow location access'}
                </button>
              )}
              {showCheckButton && (
                <button className="btn btn-outline" onClick={runProbe}>
                  Check again
                </button>
              )}
            </>
          );
        })()}
      </section>

      <section style={{ borderTop: '1px solid var(--line)', paddingTop: 24, marginBottom: 32 }}>
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>Family Pack</h3>
        {hasFamilyPack ? (
          <>
            <p style={{ fontSize: 14, color: 'var(--success)', fontWeight: 700, marginBottom: 12 }}>
              Active — unlimited students, and you can share a dashboard with another supervisor.
            </p>
            {Capacitor.getPlatform() === 'ios' && (
              <>
                {refundStatus && (
                  <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>{refundStatus}</p>
                )}
                {confirmingRefund ? (
                  <div
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 10,
                      padding: 14,
                      marginBottom: 12,
                      background: 'var(--off-white)',
                    }}
                  >
                    <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                      If Apple approves this refund:
                    </p>
                    <ul style={{ fontSize: 13, color: 'var(--navy)', margin: '0 0 12px', paddingLeft: 20 }}>
                      <li style={{ marginBottom: 4 }}>
                        {ownedStudents.length > 1
                          ? `You'll only be able to log new drives for ${oldestOwnedStudent?.firstName || 'your first student'} — ${ownedStudents.length - 1} other student${ownedStudents.length > 2 ? 's' : ''} will be locked (existing history stays visible, but you can't add to it).`
                          : "You'll be limited to one student driver going forward."}
                      </li>
                      <li>Any dashboard sharing with another supervisor will be revoked.</li>
                    </ul>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button className="btn btn-dark" onClick={handleRequestRefund} disabled={refunding}>
                        {refunding ? 'Opening…' : 'Yes, Request Refund'}
                      </button>
                      <button className="btn btn-outline" onClick={() => setConfirmingRefund(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-outline" onClick={() => setConfirmingRefund(true)}>
                    Request Refund
                  </button>
                )}
              </>
            )}
            {Capacitor.getPlatform() === 'android' && (
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                To request a refund, use the Play Store app → Account → Order history.
              </p>
            )}
          </>
        ) : Capacitor.isNativePlatform() ? (
          <>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              One-time purchase. Removes the one-student limit and lets you share a dashboard with
              another parent or supervisor.
            </p>
            {purchaseError && (
              <p style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 12 }}>{purchaseError}</p>
            )}
            {restoreStatus && (
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>{restoreStatus}</p>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-dark" onClick={handleBuyFamilyPack} disabled={purchasing}>
                {purchasing ? 'Processing…' : `Buy Family Pack — ${familyPackProduct?.priceString || '$9.99'}`}
              </button>
              <button className="btn btn-outline" onClick={handleRestorePurchases} disabled={restoring}>
                {restoring ? 'Restoring…' : 'Restore Purchases'}
              </button>
            </div>
          </>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
            Family Pack is available in the iOS and Android app.
          </p>
        )}
      </section>

      <section style={{ borderTop: '1px solid var(--line)', paddingTop: 24, marginBottom: 32 }}>
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>Email preferences</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={weeklyEmailOptIn} onChange={handleWeeklyEmailToggle} />
          Send me weekly progress emails
        </label>
      </section>

      {hapticsAvailable() && (
        <section style={{ borderTop: '1px solid var(--line)', paddingTop: 24, marginBottom: 32 }}>
          <h3 style={{ fontSize: 16, marginBottom: 10 }}>Driving-safety alerts</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={safetyHaptics} onChange={handleSafetyHapticsToggle} />
            Vibrate this phone on hard-brake and harsh-turn events during a drive
          </label>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '10px 0 0' }}>
            A short double buzz, so the supervising adult notices without looking at the screen.
            Saved on this device only.
          </p>
          <button
            type="button"
            className="btn btn-outline"
            style={{ marginTop: 12 }}
            onClick={() => pulseSafetyAlert({ force: true })}
          >
            Test vibration
          </button>
        </section>
      )}

      {biometricAvailable && (
        <section style={{ borderTop: '1px solid var(--line)', paddingTop: 24, marginBottom: 32 }}>
          <h3 style={{ fontSize: 16, marginBottom: 10 }}>App unlock</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={biometricEnabled}
              onChange={handleBiometricToggle}
              disabled={biometricBusy}
            />
            Unlock with {biometricLabel} instead of your password
          </label>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            Reopening the app on this device always asks for one or the other — {biometricLabel} if
            this is on, your password (or Google) if it's off. It doesn't change your account's
            password or who can sign in with it.
          </p>
          {biometricError && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{biometricError}</p>}
        </section>
      )}

      <section style={{ borderTop: '1px solid var(--line)', paddingTop: 24 }}>
        <h3 style={{ fontSize: 16, marginBottom: 10, color: 'var(--danger)' }}>Delete account</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          This permanently deletes your account and every dashboard you own, including all logged
          drives. Dashboards owned by someone else that were shared with you aren't affected,
          though your email may stay listed on them until their owner removes it. This can't be
          undone.
        </p>

        {!needsReauth ? (
          <>
            <div className="field">
              <label>Type "{DELETE_PHRASE}" to confirm</label>
              <input value={deleteInput} onChange={(e) => setDeleteInput(e.target.value)} />
            </div>
            <button
              className="btn"
              style={{ marginTop: 12, background: 'var(--danger)', color: 'var(--white)' }}
              disabled={deleteInput !== DELETE_PHRASE || deleting}
              onClick={handleDeleteAccount}
            >
              {deleting ? 'Deleting…' : 'Delete account'}
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, marginBottom: 12 }}>
              For your security, please confirm your identity again before deleting your account.
            </p>
            {auth.currentUser?.providerData[0]?.providerId !== 'google.com' && (
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={reauthPassword}
                  onChange={(e) => setReauthPassword(e.target.value)}
                />
              </div>
            )}
            <button
              className="btn"
              style={{ marginTop: 12, background: 'var(--danger)', color: 'var(--white)' }}
              disabled={deleting}
              onClick={handleReauthAndDelete}
            >
              {deleting ? 'Deleting…' : 'Confirm and delete account'}
            </button>
          </>
        )}
        {deleteError && <p style={{ fontSize: 13, marginTop: 10, color: 'var(--danger)' }}>{deleteError}</p>}
      </section>

      {/* Which build this device is actually running. Phones cache the app
          shell aggressively, and without this the only way to tell a stale
          copy from a broken feature is to reason backwards from the UI. */}
      <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 32, textAlign: 'center' }}>
        Build {__BUILD_ID__}
      </p>
    </div>
  );
}
