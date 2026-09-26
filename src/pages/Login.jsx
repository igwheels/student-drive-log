import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { useApp, SESSION_KICK_KEY } from '../context/AppContext';
import { auth } from '../firebase';
import { requestLocationPermission } from '../utils/geo';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithCredential,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,
  updateProfile,
  GoogleAuthProvider,
  OAuthProvider,
} from 'firebase/auth';

/**
 * AUTH WIRING NOTES
 * -----------------
 * Sign-in options:
 *  1. Email/password: signInWithEmailAndPassword, falling back to
 *     createUserWithEmailAndPassword the first time (so first-time visitors,
 *     including invited co-parents, get a real Firebase account and uid).
 *  2. Google: signInWithPopup + GoogleAuthProvider on the web, but that
 *     fundamentally doesn't work inside a Capacitor WKWebView (no real
 *     browser popup to open — fails with auth/cancelled-popup-request).
 *     Natively, @capacitor-firebase/authentication's signInWithGoogle()
 *     drives the OS-native Google sign-in flow instead and hands back an
 *     OAuth credential (idToken/accessToken) — it does NOT sign the
 *     Firebase JS SDK in on its own (skipNativeAuth: true in
 *     capacitor.config.json makes that explicit: the plugin's native-only
 *     Firebase Auth sign-in, a *separate* thing from the JS SDK `auth`
 *     everything else in this app runs on, is skipped entirely). So that
 *     credential is exchanged with signInWithCredential(auth, ...) here,
 *     which is what actually signs `auth` in and lets Firestore reads
 *     succeed. (An earlier attempt assumed the native and JS SDKs synced
 *     automatically and just waited for onAuthStateChanged — confirmed
 *     live that it never fires, since no such sync happens by default.)
 *  3. Apple Sign-In: implemented in handleAppleLogin, mirroring Google —
 *     OAuthProvider('apple.com') + signInWithPopup on web; the
 *     @capacitor-firebase/authentication signInWithApple() native flow
 *     (skipNativeAuth: true, so the returned OAuth credential is exchanged
 *     here with signInWithCredential) natively. It is NOT wired up end to
 *     end yet and the button is hidden behind APPLE_SIGN_IN_ENABLED (see
 *     below) because three things outside this repo are still missing:
 *       a. An Apple Developer account (blocked on a D-U-N-S number), with the
 *          "Sign in with Apple" capability enabled on an App ID, a Services
 *          ID for the web/redirect flow, and a private signing key (.p8).
 *       b. apple.com enabled as a sign-in provider in the Firebase console,
 *          configured with the Services ID, Team ID, Key ID and .p8 key, and
 *          the OAuth redirect handler domain
 *          (student-driver-log-b1924.firebaseapp.com) registered under the
 *          Services ID's "Website URLs" and as an Apple email source.
 *       c. The com.apple.developer.applesignin entitlement on the iOS target
 *          (needs an App ID with the capability, so it can't be added until
 *          (a) exists — do NOT add it before then or automatic signing
 *          breaks). No SwiftPM trait is involved: Apple is not behind a
 *          package trait, so capacitor.config.json's packageTraits
 *          (["Google"], which keeps the Facebook SDK out of the iOS build)
 *          stays exactly as-is.
 *     Until all three exist the flow can only fail
 *     (auth/operation-not-allowed on web; a missing-entitlement failure on
 *     native), which is why the button must not render. Enable by building
 *     with VITE_ENABLE_APPLE_SIGNIN=true once (a)-(c) are done, then verify
 *     the native round-trip in the Simulator the same way Google was.
 *
 *     Apple-specific quirks already handled in handleAppleLogin:
 *       - The user's full name is returned ONLY on the first authorization,
 *         never on later sign-ins. Native: read result.user.displayName and
 *         persist it onto the Firebase account with updateProfile so later
 *         (nameless) logins still have it. Web: Firebase captures and stores
 *         it server-side on first sign-in.
 *       - The native idToken carries a hashed nonce; the raw nonce the
 *         plugin generated (result.credential.nonce) MUST be passed as
 *         rawNonce to OAuthProvider.credential or Firebase rejects it with
 *         auth/invalid-credential ("nonce mismatch").
 *       - "Hide My Email" yields an @privaterelay.appleid.com address. This
 *         app keys sharing, invitations and the weekly email off the email
 *         address, so a relay address has product implications beyond auth
 *         (see the sharing note below) that are NOT resolved here.
 *
 * Sharing a student takes effect the moment the recipient is signed in with
 * the email it was shared with — see src/context/AppContext.jsx. NOTE: an
 * Apple "Hide My Email" relay address won't match the real address a
 * supervisor was invited under, so the share silently resolves to nothing.
 * Deciding what to do about that (prompt for the invited email, register
 * devworksllc.com as an Apple email source so relay mail is delivered,
 * match on a stable uid instead of email, ...) is an open product decision,
 * tracked with DEV-23 — do not assume the current email-only matching is
 * safe for Apple users.
 */
// Sign in with Apple is fully implemented (handleAppleLogin) but stays hidden
// until the Apple Developer account exists and apple.com is configured as a
// Firebase provider — see item 3 of AUTH WIRING NOTES for the full checklist.
// With those missing the flow can only error, so the button must never be
// reachable. Flip this on by building with VITE_ENABLE_APPLE_SIGNIN=true
// (e.g. an .env entry locally, or an `env:` on the build step in
// .github/workflows/deploy.yml) once the checklist is complete.
const APPLE_SIGN_IN_ENABLED = import.meta.env.VITE_ENABLE_APPLE_SIGNIN === 'true';

export default function Login() {
  const { setUser, claimSession, restoredSession } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(searchParams.get('email') || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [resetStatus, setResetStatus] = useState('');
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState('');
  const [resendStatus, setResendStatus] = useState('');
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [sessionKickedMessage, setSessionKickedMessage] = useState('');

  // If AppContext's session watcher just signed this device out because the
  // account signed in somewhere else, it leaves this flag behind so the
  // Login screen can explain why instead of the sign-out looking random.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KICK_KEY)) {
        setSessionKickedMessage("You've been signed out because this account signed in on another device.");
        sessionStorage.removeItem(SESSION_KICK_KEY);
      }
    } catch (e) {
      // Not worth failing login over — just skip the explanation.
    }
  }, []);

  // The app always cold-starts on this route, and completeLogin() below is
  // the only thing that ever navigates off it — so a session Firebase
  // restored at launch used to land here and stay here, showing the sign-in
  // form to someone who was already signed in. With biometric unlock on,
  // that is what the lock overlay dismissed *to*, which is why the unlock
  // flow could trace as fully successful and still end on the login screen.
  //
  // Keyed on restoredSession, not on `user` being set: an interactive
  // sign-in sets `user` too, and redirecting on that would tear this screen
  // down mid-flow — the unverified-email path signs in, checks
  // emailVerified, and signs back out before it can show "check your email".
  useEffect(() => {
    if (restoredSession) navigate('/students', { replace: true });
  }, [restoredSession, navigate]);

  const completeLogin = (profile) => {
    setUser(profile);
    claimSession(profile.id);
    // Prompt for location access now, so it's already resolved by the time
    // a drive timer needs live GPS to estimate mileage.
    requestLocationPermission();
    navigate('/students');
  };

  const handleEmailLogin = async (e) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    const trimmedEmail = email.trim();
    try {
      const { user } = await signInWithEmailAndPassword(auth, trimmedEmail, password);
      // Sign-up sends a verification link and signs the new account out, but
      // nothing used to stop them simply signing in again unverified — which
      // made the whole verification step decorative. This branch sends them
      // to the "check your email" screen instead, so a typo'd or unowned
      // address can't be used to spin up a working account.
      if (!user.emailVerified) {
        await signOut(auth);
        setPendingVerificationEmail(trimmedEmail);
        return;
      }
      completeLogin({ id: user.uid, name: user.displayName || trimmedEmail.split('@')[0], email: user.email });
    } catch (err) {
      const code = err.code || '';
      if (code.includes('user-not-found') || code.includes('invalid-credential')) {
        // No account yet for this email — create one (covers first-time visitors
        // and invited co-parents signing up for the first time). Require email
        // verification before the new account can sign in, so a bogus/typo'd
        // address can't be used to spin up accounts.
        try {
          const { user } = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
          await sendEmailVerification(user);
          await signOut(auth);
          setPendingVerificationEmail(trimmedEmail);
        } catch (createErr) {
          setError(createErr.message || 'Could not create an account with that email.');
        }
      } else {
        setError(err.message || 'Sign-in failed. Check your email and password.');
      }
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setResetStatus('');
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Enter your email above first, then tap "Forgot your password?".');
      return;
    }
    try {
      await sendPasswordResetEmail(auth, trimmedEmail);
      setResetStatus(`Password reset email sent to ${trimmedEmail}.`);
    } catch (err) {
      setError(err.message || 'Could not send reset email.');
    }
  };

  const handleGoogleLogin = async () => {
    if (googleLoading) return; // guard against a second tap queuing another native flow
    setError('');
    setGoogleLoading(true);
    try {
      if (Capacitor.isNativePlatform()) {
        // signInWithPopup has no real browser popup to open inside a native
        // WebView — this drives the OS-native Google sign-in UI instead and
        // hands back an OAuth credential (skipNativeAuth: true in
        // capacitor.config.json — see the note above handleGoogleLogin's
        // JSDoc for why). Exchange it with the JS SDK ourselves.
        const { credential } = await FirebaseAuthentication.signInWithGoogle();
        if (!credential?.idToken) throw new Error('Google sign-in did not return a credential.');
        const googleCredential = GoogleAuthProvider.credential(credential.idToken, credential.accessToken);
        const { user } = await signInWithCredential(auth, googleCredential);
        completeLogin({ id: user.uid, name: user.displayName || 'User', email: user.email });
        return;
      }
      const provider = new GoogleAuthProvider();
      const customParams = { prompt: 'select_account' };
      // Arrived via a share invitation link — suggest that email in Google's
      // account picker so they're more likely to end up signed in with the
      // exact address the dashboard was shared with.
      if (email.trim()) customParams.login_hint = email.trim();
      provider.setCustomParameters(customParams);
      const { user } = await signInWithPopup(auth, provider);
      completeLogin({ id: user.uid, name: user.displayName || 'User', email: user.email });
    } catch (err) {
      if (err.code === 'auth/popup-closed-by-user') {
        setError('Sign-in cancelled.');
      } else {
        setError(err.message || 'Google sign-in failed.');
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  // Mirrors handleGoogleLogin. Gated by APPLE_SIGN_IN_ENABLED at the render
  // site — this handler is dead code until the Apple Developer account and
  // Firebase apple.com provider exist (see AUTH WIRING NOTES item 3).
  const handleAppleLogin = async () => {
    if (appleLoading) return; // guard against a second tap queuing another native flow
    setError('');
    setAppleLoading(true);
    try {
      if (Capacitor.isNativePlatform()) {
        // Same shape as the Google native branch: the plugin runs the OS
        // Apple sheet and hands back an OAuth credential; skipNativeAuth
        // (capacitor.config.json) means it does NOT sign the JS SDK `auth`
        // in, so we exchange the credential here.
        //
        // NONCE: the plugin generates a raw nonce, sends only its SHA-256 to
        // Apple, and returns the raw value as credential.nonce. Apple embeds
        // that hash in the idToken; Firebase re-hashes whatever rawNonce we
        // pass and rejects the credential (auth/invalid-credential, "nonce
        // mismatch") if it's absent. So rawNonce is mandatory here.
        const result = await FirebaseAuthentication.signInWithApple();
        const idToken = result.credential?.idToken;
        if (!idToken) throw new Error('Apple sign-in did not return a credential.');
        const provider = new OAuthProvider('apple.com');
        const appleCredential = provider.credential({ idToken, rawNonce: result.credential?.nonce });
        const { user } = await signInWithCredential(auth, appleCredential);
        // NAME: Apple only returns the user's name on the FIRST authorization,
        // in result.user.displayName here — never afterwards, and it is not
        // in the idToken, so signInWithCredential won't set it. Capture it now
        // and persist it onto the Firebase account so later (nameless) Apple
        // logins still resolve a name via firebaseUser.displayName.
        const appleName = result.user?.displayName?.trim();
        if (appleName && !user.displayName) {
          try {
            await updateProfile(user, { displayName: appleName });
          } catch (e) {
            // Non-fatal — they're signed in; the name just won't stick for
            // next time. Not worth blocking login over a profile write.
          }
        }
        completeLogin({
          id: user.uid,
          name: user.displayName || appleName || (user.email ? user.email.split('@')[0] : 'User'),
          email: user.email,
        });
        return;
      }
      // Web: a real popup exists. Firebase handles Apple's form_post response
      // server-side, including capturing the first-authorization name onto the
      // account, so user.displayName is populated on first sign-in and
      // persisted for subsequent ones.
      const provider = new OAuthProvider('apple.com');
      provider.addScope('email');
      provider.addScope('name');
      // Arrived via a share invitation link — suggest that address to Apple.
      if (email.trim()) provider.setCustomParameters({ login_hint: email.trim() });
      const { user } = await signInWithPopup(auth, provider);
      completeLogin({
        id: user.uid,
        name: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
        email: user.email,
      });
    } catch (err) {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        setError('Sign-in cancelled.');
      } else {
        setError(err.message || 'Apple sign-in failed.');
      }
    } finally {
      setAppleLoading(false);
    }
  };

  const handleResendVerification = async () => {
    setError('');
    setResendStatus('');
    try {
      // sendEmailVerification needs a live user session; sign back in briefly
      // with the credentials still in the form, then sign out again.
      const { user } = await signInWithEmailAndPassword(auth, pendingVerificationEmail, password);
      if (user.emailVerified) {
        // They verified since we last checked — just let them in.
        completeLogin({ id: user.uid, name: user.displayName || pendingVerificationEmail.split('@')[0], email: user.email });
        return;
      }
      await sendEmailVerification(user);
      await signOut(auth);
      setResendStatus(`Verification email resent to ${pendingVerificationEmail}.`);
    } catch (err) {
      setError(err.message || 'Could not resend the verification email.');
    }
  };

  const invitedEmail = searchParams.get('email');

  if (pendingVerificationEmail) {
    return (
      <div className="login-screen">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Student Drive Log" className="login-logo" />
        <h1 className="login-title">Check your email</h1>
        <p style={{ color: 'var(--muted)', textAlign: 'center', maxWidth: 340, marginTop: 8 }}>
          We sent a verification link to <strong>{pendingVerificationEmail}</strong>. Click it to finish
          creating your account, then come back here and sign in.
        </p>
        {error && <p style={{ color: '#F2A63C', fontSize: 13, marginTop: 12 }}>{error}</p>}
        {resendStatus && <p style={{ color: '#7FA8F0', fontSize: 13, marginTop: 12 }}>{resendStatus}</p>}
        <div style={{ width: '100%', maxWidth: 340, marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="btn btn-primary" onClick={handleResendVerification}>Resend verification email</button>
          <button
            type="button"
            className="bio-link"
            onClick={() => {
              setPendingVerificationEmail('');
              setError('');
              setResendStatus('');
            }}
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Student Drive Log" className="login-logo" />
      <h1 className="login-title">Student Drive Log</h1>

      {sessionKickedMessage && (
        <p style={{ color: '#F2A63C', fontSize: 13, textAlign: 'center', maxWidth: 340, marginTop: 4, marginBottom: 12 }}>
          {sessionKickedMessage}
        </p>
      )}

      <form className="login-form" onSubmit={handleEmailLogin}>
        <input
          type="email" placeholder="Email" autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" placeholder="Password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p style={{ color: '#F2A63C', fontSize: 13, marginBottom: 12 }}>{error}</p>}
        {resetStatus && <p style={{ color: '#7FA8F0', fontSize: 13, marginBottom: 12 }}>{resetStatus}</p>}
        <button type="submit" className="btn btn-primary">Sign in</button>
        <button type="button" className="bio-link" onClick={handleForgotPassword}>
          Forgot your password?
        </button>
      </form>

      <div className="divider" style={{ width: '100%', maxWidth: 340 }}>or</div>

      <div style={{ width: '100%', maxWidth: 340 }}>
        <button className="btn btn-ghost" onClick={handleGoogleLogin} disabled={googleLoading}>
          {googleLoading ? 'Signing in…' : 'Continue with Google'}
        </button>
        {invitedEmail && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10, textAlign: 'center' }}>
            Use the Google account for {invitedEmail} to see the shared dashboard.
          </p>
        )}
        {/* Hidden until the Apple Developer account + Firebase apple.com
            provider exist — see APPLE_SIGN_IN_ENABLED and AUTH WIRING NOTES. */}
        {APPLE_SIGN_IN_ENABLED && (
          <button
            className="btn btn-ghost"
            style={{ marginTop: 10 }}
            onClick={handleAppleLogin}
            disabled={appleLoading}
          >
            {appleLoading ? 'Signing in…' : 'Continue with Apple'}
          </button>
        )}
      </div>
    </div>
  );
}
