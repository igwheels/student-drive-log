import React, { useEffect, useState } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { authenticateWithBiometrics, checkBiometryAvailability } from '../utils/biometricAuth';

/**
 * Full-screen overlay shown when AppContext decides the app should be
 * biometric-locked (see the cold-start/resume wiring there). Renders on
 * TOP of whatever page is underneath rather than replacing it — an
 * in-progress drive timer or an open form must not be torn down just
 * because the app was backgrounded and re-locked.
 *
 * Never a dead end (DEV-8's explicit requirement): a failed, cancelled,
 * or errored biometric attempt leaves this screen showing with a "Try
 * Again" button and an explicit "Sign in another way" fallback — it never
 * auto-signs-out or silently retries into a stuck state.
 *
 * "Sign in another way" is a REAL sign-out (signOut(auth)), not a
 * special-cased "peek behind the lock" path. That's deliberate: falling
 * back to normal auth means going through the actual front door again,
 * so it inherits every existing invariant for free — DEV-33's
 * single-session claim, the sign-out data-clearing in AppContext, all of
 * it — rather than this screen re-implementing a slightly different
 * version of "signed in."
 */
export default function BiometricLockScreen({ onUnlock }) {
  const [status, setStatus] = useState('prompting'); // 'prompting' | 'failed'
  const [failureMessage, setFailureMessage] = useState('');
  // Fetched fresh on mount rather than threaded down from AppContext: the
  // enable-time label could be stale by the time a later lock happens
  // (unlikely to actually change, but this is cheap and always current).
  // Starts generic so there's never a flash of a wrong specific name.
  const [label, setLabel] = useState('biometrics');

  useEffect(() => {
    checkBiometryAvailability().then((result) => setLabel(result.label));
  }, []);

  const attempt = async (retriesLeft = 3) => {
    setStatus('prompting');
    setFailureMessage('');
    const result = await authenticateWithBiometrics('Unlock Student Drive Log');
    if (result.ok) {
      onUnlock();
      return;
    }
    // systemCancel = iOS tore the prompt down itself, almost always
    // because it was presented before the scene finished activating on a
    // cold start — not a real auth failure. Wait a beat and try again
    // rather than dropping to the alarming failed state.
    if (result.code === 'systemCancel' && retriesLeft > 0) {
      await new Promise((r) => setTimeout(r, 500));
      return attempt(retriesLeft - 1);
    }
    // userCancel: they deliberately dismissed the system prompt — don't
    // put an alarming error message in front of someone who just tapped
    // "Cancel". Every other code (failed match, lockout, no longer
    // enrolled, plugin error, ...) gets a plain, non-technical message;
    // the exact code isn't actionable for the user either way.
    if (result.code !== 'userCancel') {
      setFailureMessage("Couldn't verify — try again, or sign in another way.");
    }
    setStatus('failed');
  };

  // Auto-prompt shortly after mount. A small delay lets the overlay paint
  // and the scene finish activating on a cold start, which avoids the
  // immediate systemCancel that firing on the same tick as mount can
  // trigger; attempt()'s own systemCancel retry covers whatever slips
  // through.
  useEffect(() => {
    const id = setTimeout(() => attempt(), 300);
    return () => {
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFallback = async () => {
    try {
      await signOut(auth);
    } catch (e) {
      console.warn('Sign-out during biometric fallback failed:', e);
    }
    // No further state to clear here: signOut() triggers AppContext's
    // onAuthStateChanged(null) handler, which clears user/students/logs
    // and, since biometricLocked is derived from user being present,
    // that same update is what makes this overlay stop rendering.
  };

  return (
    <div className="biometric-lock-overlay">
      <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Student Drive Log" className="login-logo" />
      <h1 className="login-title">Student Drive Log</h1>
      <p style={{ color: 'var(--muted)', textAlign: 'center', maxWidth: 320, marginTop: -16, marginBottom: 24 }}>
        {status === 'prompting' ? `Unlock with ${label} to continue.` : 'Locked'}
      </p>
      {failureMessage && (
        <p style={{ color: '#F2A63C', fontSize: 13, textAlign: 'center', maxWidth: 320, marginBottom: 16 }}>
          {failureMessage}
        </p>
      )}
      <div style={{ width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button className="btn btn-primary" onClick={() => attempt()} disabled={status === 'prompting'}>
          {status === 'prompting' ? 'Waiting…' : 'Try Again'}
        </button>
        <button type="button" className="bio-link" onClick={handleFallback}>
          Sign in another way
        </button>
      </div>
    </div>
  );
}
