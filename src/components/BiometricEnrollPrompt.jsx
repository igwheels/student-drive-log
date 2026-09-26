import React, { useState } from 'react';
import {
  authenticateWithBiometrics,
  setBiometricEnabledForUser,
  markBiometricEnrollmentAsked,
} from '../utils/biometricAuth';

/**
 * Shown once, right after a fresh interactive sign-in on native, offering
 * to enable biometric unlock — DEV-28's "offer to enable it after first
 * sign-in." AppContext decides WHEN this should render (device has
 * biometrics available, this account hasn't been asked before); this
 * component only handles the accept/decline choice itself.
 *
 * "Enable" actually runs a real authenticate() before flipping the
 * preference on, rather than trusting the tap alone — so a device that
 * reports biometrics as available but then fails outright (a plugin/OS
 * quirk) doesn't get silently marked "enabled" and start locking someone
 * out on the very next open.
 *
 * `label` is the human-readable name for THIS device's actual mechanism
 * ("Face ID", "Touch ID", "your fingerprint", ...) — resolved once by
 * AppContext from checkBiometryAvailability() and passed down, so this
 * never hardcodes "Face ID" and shows wrong copy on a Touch ID iPhone or
 * an Android fingerprint device.
 */
export default function BiometricEnrollPrompt({ uid, label, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const finish = (enabled) => {
    markBiometricEnrollmentAsked(uid);
    setBiometricEnabledForUser(uid, enabled);
    onDone();
  };

  const handleEnable = async () => {
    setBusy(true);
    setError('');
    // Generic on purpose — this text only surfaces inside the OS's own
    // system prompt (a one-line caption under the Face ID/fingerprint
    // icon), not the app's UI, so it doesn't need label to read
    // naturally the way the app's own copy below does.
    const result = await authenticateWithBiometrics('Confirm to enable biometric unlock for Student Drive Log');
    setBusy(false);
    if (result.ok) {
      finish(true);
      return;
    }
    if (result.code === 'userCancel') {
      // Not an error — they just backed out of confirming. Leave the
      // prompt up rather than treating a cancel as a decline.
      return;
    }
    setError("Couldn't confirm biometric unlock on this device — you can try again later from Account.");
  };

  const handleNotNow = () => finish(false);

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : handleNotNow}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-text">Unlock with {label} next time, instead of typing your password?</div>
        {error && <p style={{ color: '#D8503F', fontSize: 13, marginTop: 12 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={handleNotNow} disabled={busy}>
            Not now
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleEnable} disabled={busy}>
            {busy ? 'Confirming…' : 'Enable'}
          </button>
        </div>
      </div>
    </div>
  );
}
