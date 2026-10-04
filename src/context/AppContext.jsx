import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { db, auth } from '../firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  addDoc, collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where,
} from 'firebase/firestore';
import { emailDocId } from '../utils/emailHash';
import { STATE_REQUIREMENTS } from '../data/stateRequirements';
import { watchOwnFamilyPack, studentHasFamilyPack, restorePurchases as restorePurchasesCall } from '../utils/entitlements';
import {
  isBiometricEnabledForUser,
  hasAskedBiometricEnrollment,
  checkBiometryAvailability,
  isBiometricPromptActive,
  armBiometricSession,
  evaluateBiometricSession,
} from '../utils/biometricAuth';

const AppContext = createContext(null);
const STORAGE_KEY = 'sdl_data_v1';
// Single-active-session enforcement (untiered, applies to every account):
// signing in claims a fresh token on users/{uid} and remembers it locally;
// any other device watching that same doc sees its own stored token go
// stale and signs itself out. SESSION_KICK_KEY survives just long enough
// for the Login screen's next render to explain why.
const SESSION_TOKEN_KEY = 'sdl_session_token';
export const SESSION_KICK_KEY = 'sdl_session_kicked';

const generateSessionToken = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const normalizeEmail = (email) => email.trim().toLowerCase();

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [students, setStudents] = useState([]);
  const [logs, setLogs] = useState({});
  const [hydrated, setHydrated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  // This account's OWN Family Pack status — for gates on actions the
  // account owner performs. Not what a shared co-parent should check for
  // a particular student's premium features; see studentHasFamilyPack
  // (src/utils/entitlements.js) for that half of the split.
  const [hasFamilyPack, setHasFamilyPack] = useState(false);
  // DEV-28: a local unlock gate in front of this already-authenticated
  // session, not a second auth system — see src/utils/biometricAuth.js's
  // module comment for the full reasoning. biometricLocked gates
  // rendering (App.jsx shows BiometricLockScreen as an overlay, not a
  // route, so nothing underneath unmounts). biometricEnrollLabel gates
  // the one-time "enable Face ID?" offer after a fresh sign-in — null
  // means don't show it; a string ("Face ID", "Touch ID", "fingerprint
  // unlock", ...) means show it, naming the actual mechanism this device
  // has. Carrying the resolved label here (not just a boolean) means
  // BiometricEnrollPrompt never needs its own redundant checkBiometry()
  // call — the one below, at the moment this is decided, is enough.
  const [biometricLocked, setBiometricLocked] = useState(false);
  const [biometricEnrollLabel, setBiometricEnrollLabel] = useState(null);
  // True when this app load began with a session Firebase had already
  // persisted, rather than one established by signing in just now. The app
  // always cold-starts on '/', and Login's completeLogin() is the only
  // thing that navigates off it — so without this, a restored session
  // leaves someone sitting on the sign-in form while actually signed in.
  // Login.jsx watches this and redirects; see the note there for why it
  // keys on this rather than on `user` being present.
  // NOT set on native for a restored session whose account doesn't have
  // biometrics enabled — that path signs the user out instead (see the
  // onAuthStateChanged handler below), and Login must never be told to
  // reveal Students first for a session about to be torn down.
  const [restoredSession, setRestoredSession] = useState(false);
  // True only for the very first onAuthStateChanged callback of this app
  // load — the one that reports whatever session Firebase already had
  // persisted, as opposed to one from an interactive sign-in just now.
  // That distinction is the whole reason this doesn't lock someone
  // immediately after they type their password: a fresh interactive
  // sign-in already proved who they are.
  const isFirstAuthCheck = useRef(true);
  // Live mirror of biometricLocked for the resume listener (a stale
  // closure otherwise) and the wall-clock time of the last successful
  // unlock. The resume listener refuses to re-lock for a few seconds
  // after an unlock: the OS auth sheet's own dismissal posts a
  // foreground event that would otherwise re-lock instantly, forever.
  const biometricLockedRef = useRef(false);
  const lastBiometricUnlockAt = useRef(0);
  useEffect(() => {
    biometricLockedRef.current = biometricLocked;
  }, [biometricLocked]);

  // Keep app-level user state in sync with Firebase's actual auth session,
  // instead of relying solely on the one-time setUser() call at login. Without
  // this, the app's session and Firebase's real session can drift apart (e.g.
  // across a long-idle tab or token refresh edge case), so the UI still
  // thinks you're signed in as the owner while Firestore's rules check the
  // real session and reject writes with a permission-denied that has no
  // visible cause. This also means a returning visitor with an existing
  // Firebase session no longer has to sign in again just because the app's
  // own state reset on reload.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      // Captured before isFirstAuthCheck.current is overwritten below, so
      // the biometric branch after this if/else still knows which case
      // it's in.
      const wasFirstCheck = isFirstAuthCheck.current;
      isFirstAuthCheck.current = false;

      if (firebaseUser) {
        setUser((prev) =>
          prev && prev.id === firebaseUser.uid
            ? prev
            : {
                id: firebaseUser.uid,
                name: firebaseUser.displayName || (firebaseUser.email ? firebaseUser.email.split('@')[0] : 'User'),
                email: firebaseUser.email,
              }
        );

        // DEV-28 / DEV-8 phase 4. Three cases, split on platform and
        // wasFirstCheck:
        //  - Web/PWA has no biometric feature at all (no device to check
        //    against) -> always restore straight in, exactly as before any
        //    of this existed.
        //  - Native, cold start with a session Firebase already had
        //    persisted -> NO BYPASS: an account either has biometrics
        //    enabled (lock behind it, then confirm the biometric session is
        //    still within policy — aged past MAX_BIOMETRIC_SESSION_MS or a
        //    reboot since arming forces a full sign-in instead) or it
        //    doesn't, in which case a full sign-in is required regardless —
        //    reopening the app is never a silent, unauthenticated restore.
        //    The Account "App unlock" toggle is what decides which of these
        //    two path an account is on.
        //    isBiometricEnabledForUser has to be read BEFORE setting
        //    restoredSession: if the answer is "force sign-in", Login must
        //    never be told to navigate to Students first, even for one
        //    render — that would flash a minor's drive history on screen
        //    before the sign-out actually completes.
        //  - Native, fresh interactive sign-in (including one completed
        //    from BiometricLockScreen's "Sign in another way" fallback) ->
        //    the password/Google prompt they just completed IS the proof of
        //    identity; never lock right on top of that. Re-arm the
        //    biometric session window, and if this account hasn't been
        //    asked before and the device has biometrics, offer to enable.
        if (!Capacitor.isNativePlatform()) {
          if (wasFirstCheck) setRestoredSession(true);
        } else if (wasFirstCheck) {
          if (isBiometricEnabledForUser(firebaseUser.uid)) {
            setRestoredSession(true);
            setBiometricLocked(true);
            evaluateBiometricSession(firebaseUser.uid).then(({ ok, reason }) => {
              if (!ok) {
                signOut(auth);
              }
            });
          } else {
            signOut(auth);
          }
        } else {
          armBiometricSession(firebaseUser.uid);
          if (!hasAskedBiometricEnrollment(firebaseUser.uid) && !isBiometricEnabledForUser(firebaseUser.uid)) {
            checkBiometryAvailability().then(({ isAvailable, label }) => {
              if (isAvailable) setBiometricEnrollLabel(label);
            });
          }
        }
      } else {
        setUser(null);
        // Don't leave a signed-out device holding a student's drive history —
        // the cache below includes every logged drive and its GPS route, and
        // these are minors. Without this, signing out cleared the session but
        // left all of it readable in localStorage for whoever used the browser
        // next. Clearing state too keeps the save effect from rewriting it.
        setStudents([]);
        setLogs({});
        // Nothing left to gate or offer once signed out — and this is what
        // makes BiometricLockScreen's "Sign in another way" fallback work:
        // its signOut(auth) call lands here, which is what actually clears
        // biometricLocked (not the button itself).
        setBiometricLocked(false);
        setBiometricEnrollLabel(null);
        setRestoredSession(false);
        try {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(SESSION_TOKEN_KEY);
        } catch (e) {
          console.warn('Failed to clear cached data on sign-out', e);
        }
      }
      setAuthChecked(true);
    });
    return unsubscribe;
  }, []);

  // Re-lock on resume (app backgrounded then foregrounded) if this
  // account has biometric unlock enabled. Cold start is handled above in
  // the onAuthStateChanged effect instead — this only covers background ->
  // foreground transitions after the app was already running.
  //
  // Driven straight off @capacitor/app's appStateChange rather than the
  // biometric plugin's addResumeListener (which fires on *every* foreground
  // and does its own checkBiometry round-trip). The hard problem is that
  // the OS Face ID / Touch ID sheet takes over the screen, so presenting
  // it is itself an inactive->active cycle that lands right after a
  // successful unlock — re-locking on it re-prompts forever. Four guards,
  // any one of which is enough to break the loop:
  //   1. already locked — a prompt is on screen; nothing to do.
  //   2. isBiometricPromptActive() — a prompt is in flight or just resolved.
  //   3. within GRACE_AFTER_UNLOCK_MS of the last successful unlock.
  //   4. the background was shorter than MIN_BACKGROUND_MS (the sheet's
  //      blip is well under a second) — only meaningful when the inactive
  //      edge was actually observed.
  useEffect(() => {
    if (!user?.id) return;
    const MIN_BACKGROUND_MS = 1500;
    const GRACE_AFTER_UNLOCK_MS = 4000;
    let handle;
    let cancelled = false;
    let leftForegroundAt = Date.now();

    import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) {
            leftForegroundAt = Date.now();
            return;
          }
          if (biometricLockedRef.current) return;
          if (isBiometricPromptActive()) return;
          if (Date.now() - lastBiometricUnlockAt.current < GRACE_AFTER_UNLOCK_MS) return;
          if (Date.now() - leftForegroundAt < MIN_BACKGROUND_MS) return;
          if (isBiometricEnabledForUser(user.id)) setBiometricLocked(true);
        })
      )
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => {}); // web / plugin missing — nothing to re-lock

    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [user?.id]);

  // Watches this account's active-session token once signed in. claimSession()
  // (called from Login.jsx right after a successful sign-in) sets this
  // device's local token to match the one it just wrote, so its own write
  // never triggers this — only a *different* device claiming the session
  // afterward changes the remote token out from under this one.
  useEffect(() => {
    if (!user?.id) return;
    const unsubscribe = onSnapshot(doc(db, 'users', user.id), (snap) => {
      const remoteToken = snap.data()?.activeSessionToken;
      let localToken = null;
      try {
        localToken = localStorage.getItem(SESSION_TOKEN_KEY);
      } catch (e) {
        return; // can't compare without it — don't risk a false-positive kick
      }
      if (remoteToken && localToken && remoteToken !== localToken) {
        try {
          sessionStorage.setItem(SESSION_KICK_KEY, '1');
        } catch (e) {
          // Non-fatal — the sign-out below still happens, just without the
          // explanatory message on the next Login screen.
        }
        signOut(auth);
      }
    });
    return unsubscribe;
  }, [user?.id]);

  // Called right after a successful sign-in (Login.jsx's completeLogin) to
  // claim this device as the account's one active session. Writes localStorage
  // BEFORE the Firestore write resolves, so by the time the watcher above
  // sees this same write come back down, the local token already matches —
  // otherwise a device could momentarily see its own claim as a kick.
  const claimSession = async (uid) => {
    const token = generateSessionToken();
    try {
      localStorage.setItem(SESSION_TOKEN_KEY, token);
    } catch (e) {
      console.warn('Failed to store session token locally:', e);
      return;
    }
    try {
      await setDoc(doc(db, 'users', uid), {
        activeSessionToken: token,
        activeSessionUpdatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (e) {
      console.warn('Failed to claim session:', e);
    }
  };

  // Removes the users/{uid} doc (which only ever holds the active-session
  // token). Called by Account.jsx's account-deletion flow while the user is
  // still signed in — after Firebase deletes the auth user, the rules would
  // reject this write. Non-fatal: if the matching firestore.rules change
  // ('allow delete' scoped to the owner) hasn't been published yet, this
  // throws permission-denied and the rest of account deletion still runs,
  // leaving the doc orphaned exactly as before.
  const deleteSessionClaim = async (uid) => {
    try {
      await deleteDoc(doc(db, 'users', uid));
    } catch (e) {
      console.warn('Failed to delete session claim doc:', e);
    }
  };

  // DEV-62: records this account's current sign-in email -> uid, so
  // shareStudent() can resolve a recipient's stable uid immediately if
  // they already have an account, rather than waiting for their next
  // sign-in to self-resolve it (see loadFromFirestore below). Re-runs
  // whenever the reported email changes, which is exactly what keeps this
  // useful for an Apple "Hide My Email" account whose relay address can
  // rotate — each address it's ever signed in under stays mapped to the
  // same uid.
  useEffect(() => {
    if (!user?.id || !user?.email) return;
    setDoc(doc(db, 'emailToUid', normalizeEmail(user.email)), { uid: user.id }).catch((e) =>
      console.warn("Failed to record email->uid mapping (non-fatal — a new share to this address just won't resolve instantly):", e)
    );
  }, [user?.id, user?.email]);

  // Live-subscribes to this account's own Family Pack entitlement doc
  // (functions/src/validatePurchase.js is the only thing that ever writes
  // it). Resets to false on sign-out so a previous session's entitlement
  // never lingers into the next signed-in account on a shared device.
  useEffect(() => {
    if (!user?.id) {
      setHasFamilyPack(false);
      return;
    }
    return watchOwnFamilyPack(user.id, setHasFamilyPack);
  }, [user?.id]);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        setStudents(data.students ?? []);
        setLogs(data.logs ?? {});
      }
    } catch (e) {
      console.warn('Failed to load from localStorage', e);
    } finally {
      setHydrated(true);
    }
  }, []);

  // Save to localStorage when data changes (offline fallback / cache).
  // Only while someone is actually signed in — otherwise this would just
  // recreate the cache that the sign-out branch above deliberately cleared.
  useEffect(() => {
    if (!hydrated || !user) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ students, logs }));
    } catch (e) {
      console.warn('Failed to save to localStorage', e);
    }
  }, [students, logs, hydrated, user]);

  // Load owned + shared students (and their logs) from Firestore when user logs in
  // — also re-runs whenever hasFamilyPack flips. Reported 2026-10-04:
  // functions/src/entitlementFanout.js correctly denormalizes
  // familyPackActive/locked onto every student document the moment the
  // entitlement doc changes (refund locks them, a later repurchase unlocks
  // them again), but this effect used to only depend on [user?.id,
  // user?.email, hydrated] — the owner's OWN live entitlement subscription
  // (watchOwnFamilyPack, below) flips `hasFamilyPack` immediately, which is
  // enough to re-enable the "add a student" / "share" UI, but the already-
  // loaded `students` array (one-time getDocs(), not a subscription) kept
  // its stale `locked: true` from before the repurchase until the next full
  // reload — so a student correctly unlocked server-side stayed grayed out
  // client-side for the rest of the session. Refetching here closes that
  // gap in both directions (it's symmetric: a refund during an active
  // session now grays students out immediately too, not just on next
  // launch).
  useEffect(() => {
    if (!user?.id || !hydrated) return;

    const loadFromFirestore = async () => {
      try {
        setSyncing(true);
        const userEmail = normalizeEmail(user.email || '');

        // Students this user owns
        const ownedSnap = await getDocs(collection(db, 'users', user.id, 'students'));
        const ownedStudents = ownedSnap.docs.map((d) => ({
          ...d.data(),
          id: d.id,
          ownerId: d.data().ownerId || user.id,
          isOwner: true,
        }));

        // Students shared with this user, found via two collection-group
        // queries (avoids scanning every user's data — only matches
        // students that list this uid or email). DEV-62: sharedWithUids is
        // the durable path — once a share has resolved to this uid, access
        // survives whatever address Firebase later reports for this
        // account (Apple's Hide My Email can rotate the relay address, or
        // start reporting one for someone previously matched on their real
        // address). sharedWithEmails is what grants access the FIRST time,
        // before any uid has been recorded, and finding a student there
        // that isn't in sharedWithUids yet is exactly the signal to
        // self-resolve this uid onto it below.
        let sharedStudents = [];
        try {
          const [byUidSnap, byEmailSnap] = await Promise.all([
            getDocs(
              query(collectionGroup(db, 'students'), where('sharedWithUids', 'array-contains', user.id))
            ),
            getDocs(
              query(collectionGroup(db, 'students'), where('sharedWithEmails', 'array-contains', userEmail))
            ),
          ]);

          const byId = new Map();
          for (const d of byUidSnap.docs) byId.set(d.id, d);
          for (const d of byEmailSnap.docs) {
            byId.set(d.id, d);
            const data = d.data();
            const uids = data.sharedWithUids || [];
            if (!uids.includes(user.id)) {
              // First time this uid has shown up signed in with the invited
              // address — pin it so future access no longer depends on
              // which address is currently signed in. Fire-and-forget:
              // email-based access already works this session regardless.
              updateDoc(d.ref, { sharedWithUids: [...uids, user.id] }).catch((e) =>
                console.warn('Failed to self-resolve shared-student access (non-fatal, email-based access still works this session):', e)
              );
            }
          }

          sharedStudents = Array.from(byId.values())
            .filter((d) => d.data().ownerId !== user.id) // safety: don't double-list own students
            .map((d) => ({ ...d.data(), id: d.id, isOwner: false }));
        } catch (e) {
          console.error('Failed to load shared students (likely a Firestore rules issue):', e);
        }

        const allStudents = [...ownedStudents, ...sharedStudents];
        setStudents(allStudents);

        const logsData = {};
        for (const student of allStudents) {
          try {
            if (typeof student.ownerId !== 'string' || typeof student.id !== 'string') {
              console.error(
                `Skipping logs for ${student.firstName} ${student.lastName}: bad ownerId/id`,
                { ownerId: student.ownerId, id: student.id, isOwner: student.isOwner }
              );
              logsData[student.id] = logs[student.id] ?? [];
              continue;
            }
            const logsSnap = await getDocs(
              collection(db, 'users', student.ownerId, 'students', student.id, 'logs')
            );
            logsData[student.id] = logsSnap.docs
              .map((d) => ({ ...d.data(), id: d.id }))
              .sort((a, b) => new Date(b.date) - new Date(a.date));
          } catch (e) {
            // Keep whatever was already cached rather than wiping it with an
            // empty array — a failure loading one student's logs shouldn't
            // erase previously-synced data for them, or block every other
            // student in this session from loading at all.
            console.error(`Failed to load logs for ${student.firstName} ${student.lastName}:`, e);
            logsData[student.id] = logs[student.id] ?? [];
          }
        }
        setLogs(logsData);
      } catch (e) {
        console.error('Failed to load from Firestore:', e);
      } finally {
        setSyncing(false);
      }
    };

    loadFromFirestore();
  }, [user?.id, user?.email, hydrated, hasFamilyPack]);

  const addStudent = async (student) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const newStudent = {
      id,
      ...student,
      ownerId: user?.id,
      ownerName: user?.name ?? '',
      ownerEmail: user?.email ?? '',
      sharedWith: [],
      sharedWithEmails: [],
      sharedWithUids: [],
      isOwner: true,
    };
    setStudents((prev) => [...prev, newStudent]);

    if (user?.id) {
      try {
        await setDoc(doc(db, 'users', user.id, 'students', id), newStudent);
      } catch (e) {
        console.error('Failed to save student to Firestore:', e);
      }

      // A small, separate directory entry (not the full student record) so
      // addStudent() can check whether a dashboard for this student's email
      // already exists elsewhere, without exposing every owner's full
      // student/logs data to a cross-account lookup. Keyed by a hash of the
      // email so that check is a direct read rather than a query — see
      // src/utils/emailHash.js.
      //
      // Written separately from the student itself, and deliberately not
      // fatal: one entry per email means a second student registered under an
      // address someone else already used can't claim the entry (the rules
      // only let its owner overwrite it). That student is still created and
      // fully usable — it just isn't the one the directory points at.
      try {
        await setDoc(doc(db, 'studentDirectory', await emailDocId(newStudent.email)), {
          studentId: id,
          ownerId: user.id,
          ownerName: user.name ?? '',
          firstName: newStudent.firstName,
          lastName: newStudent.lastName,
          email: normalizeEmail(newStudent.email || ''),
        });
      } catch (e) {
        console.warn('Directory entry not written for this student (an entry for that email may already belong to another account):', e);
      }
    }
    return id;
  };

  // Looks up whether a dashboard already exists for this student's email,
  // via the studentDirectory collection (see addStudent above) — used by
  // AddStudent.jsx before creating a new, possibly-duplicate dashboard.
  const findExistingStudentByEmail = async (email) => {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    // A direct read of the one document this email maps to. This used to be a
    // where('email','==') query, which forced the rules to allow listing the
    // whole collection — and with it, enumeration of every student's name and
    // email by any signed-in user.
    const snap = await getDoc(doc(db, 'studentDirectory', await emailDocId(normalized)));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() };
  };

  // Files a request to be added as a shared viewer on someone else's
  // existing student dashboard. The owner sees it as a pending entry on
  // their dashboard (see getPendingRequests/approveRequest/denyRequest)
  // and can approve or deny it.
  const requestStudentAccess = async (directoryEntry) => {
    await addDoc(collection(db, 'accessRequests'), {
      studentId: directoryEntry.studentId,
      ownerId: directoryEntry.ownerId,
      ownerName: directoryEntry.ownerName,
      studentFirstName: directoryEntry.firstName,
      requesterId: user.id,
      requesterName: user.name,
      requesterEmail: normalizeEmail(user.email || ''),
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  };

  const getPendingRequests = async (studentId) => {
    if (!user?.id) return [];
    const snap = await getDocs(
      query(collection(db, 'accessRequests'), where('ownerId', '==', user.id), where('studentId', '==', studentId))
    );
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => r.status === 'pending');
  };

  const approveRequest = async (request) => {
    await shareStudent(request.studentId, request.requesterEmail);
    await deleteDoc(doc(db, 'accessRequests', request.id));
  };

  const denyRequest = async (requestId) => {
    await deleteDoc(doc(db, 'accessRequests', requestId));
  };

  const addLog = async (studentId, log) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const newLog = { id, ...log };
    setLogs((prev) => ({
      ...prev,
      [studentId]: [newLog, ...(prev[studentId] ?? [])],
    }));

    if (user?.id) {
      try {
        const student = students.find((s) => s.id === studentId);
        const ownerId = student?.ownerId || user.id;
        await setDoc(doc(db, 'users', ownerId, 'students', studentId, 'logs', id), newLog);
      } catch (e) {
        console.error('Failed to save log to Firestore:', e);
      }
    }
  };

  const updateLog = async (studentId, logId, changes) => {
    setLogs((prev) => ({
      ...prev,
      [studentId]: (prev[studentId] ?? []).map((log) =>
        log.id === logId ? { ...log, ...changes } : log
      ),
    }));

    if (user?.id) {
      try {
        const student = students.find((s) => s.id === studentId);
        const ownerId = student?.ownerId || user.id;
        await updateDoc(doc(db, 'users', ownerId, 'students', studentId, 'logs', logId), changes);
      } catch (e) {
        console.error('Failed to update log in Firestore:', e);
      }
    }
  };

  const getLogs = (studentId) => logs[studentId] ?? [];

  const getTotals = (studentId) => {
    const entries = getLogs(studentId);

    // Texas counts at most two hours of behind-the-wheel instruction per
    // calendar day toward the 30-hour requirement — one hour day, one hour
    // night — regardless of how much was actually driven that day, per the
    // state's own DES150N log ("Only two (2) hours of behind-the-wheel
    // instruction per day will count towards the 30 hours regardless of the
    // number of hours the student actually drives in a day"). Every other
    // state counts the full logged time.
    const student = students.find((s) => s.id === studentId);
    if (student?.state === 'TX') {
      const byDate = new Map();
      for (const e of entries) {
        const bucket = byDate.get(e.date) ?? { day: 0, night: 0 };
        if (e.timeOfDay === 'night') bucket.night += e.durationMinutes;
        else bucket.day += e.durationMinutes;
        byDate.set(e.date, bucket);
      }
      let total = 0;
      let night = 0;
      for (const { day, night: n } of byDate.values()) {
        const cappedDay = Math.min(day, 60);
        const cappedNight = Math.min(n, 60);
        total += cappedDay + cappedNight;
        night += cappedNight;
      }
      return { totalMinutes: total, nightMinutes: night };
    }

    let total = 0;
    let night = 0;
    for (const e of entries) {
      total += e.durationMinutes;
      if (e.timeOfDay === 'night') night += e.durationMinutes;
    }
    return { totalMinutes: total, nightMinutes: night };
  };

  const updateStudentEmail = async (studentId, newEmail) => {
    const student = students.find((s) => s.id === studentId);
    if (!student || student.ownerId !== user?.id) {
      throw new Error('Only the owner can edit a student');
    }
    const email = newEmail.trim();
    const previousEmail = student.email || '';

    setStudents((prev) => prev.map((s) => (s.id === studentId ? { ...s, email } : s)));

    await updateDoc(doc(db, 'users', user.id, 'students', studentId), { email });

    // The directory is keyed by the email, so changing it moves the entry to a
    // new document rather than editing one in place: write the new key first,
    // then drop the old one. Neither step is fatal — the student's own record
    // is already updated above, and a stale directory entry only affects the
    // duplicate-email check.
    try {
      await setDoc(doc(db, 'studentDirectory', await emailDocId(email)), {
        studentId,
        ownerId: user.id,
        ownerName: user.name ?? '',
        firstName: student.firstName,
        lastName: student.lastName,
        email: normalizeEmail(email),
      });
      if (previousEmail && normalizeEmail(previousEmail) !== normalizeEmail(email)) {
        // Only remove the old entry if it actually points at this student —
        // another student could legitimately be registered under that address.
        const oldRef = doc(db, 'studentDirectory', await emailDocId(previousEmail));
        const oldSnap = await getDoc(oldRef);
        if (oldSnap.exists() && oldSnap.data().studentId === studentId) {
          await deleteDoc(oldRef);
        }
      }
    } catch (e) {
      console.warn('Failed to sync studentDirectory entry:', e);
    }
  };

  // For a student who moves. The state determines which hour requirement the
  // dashboard measures against and which DMV form the app produces, so it has
  // to be changeable without recreating the dashboard and losing its drives.
  //
  // Logged drives are untouched: the hours were driven either way, and it is
  // the requirement they count toward that moves. studentDirectory holds no
  // state, so nothing needs syncing there.
  const updateStudentState = async (studentId, newState) => {
    const student = students.find((s) => s.id === studentId);
    if (!student || student.ownerId !== user?.id) {
      throw new Error('Only the owner can edit a student');
    }
    // An unrecognised code would leave the dashboard reading requirements off
    // undefined, so refuse it here rather than write it and break the page.
    if (!STATE_REQUIREMENTS[newState]) {
      throw new Error('Please choose a state.');
    }
    if (newState === student.state) return;

    setStudents((prev) => prev.map((s) => (s.id === studentId ? { ...s, state: newState } : s)));
    await updateDoc(doc(db, 'users', user.id, 'students', studentId), { state: newState });
  };

  // Records outside the student document that reference it, and would
  // otherwise outlive it: the directory entry (which any signed-in user can
  // read given the email), plus any access requests and queued invitations
  // naming this student. Each is attempted independently and none of them
  // block the others — the student itself is already gone by this point, so a
  // failure here means a leftover to clean up, not a half-deleted student.
  //
  // Everything below is scoped to this one studentId and to records this user
  // owns; nothing here can reach another student or another account.
  const deleteRecordsReferencingStudent = async (studentId, student) => {
    if (student?.email) {
      try {
        // Only if it still points at this student — the entry is keyed by
        // email, and a different student could legitimately hold it.
        const ref = doc(db, 'studentDirectory', await emailDocId(student.email));
        const snap = await getDoc(ref);
        if (snap.exists() && snap.data().studentId === studentId) {
          await deleteDoc(ref);
        }
      } catch (e) {
        console.warn('Failed to remove studentDirectory entry:', e);
      }
    }

    for (const [label, collectionName] of [
      ['access requests', 'accessRequests'],
      ['invitations', 'invitations'],
    ]) {
      try {
        const snap = await getDocs(
          query(
            collection(db, collectionName),
            where('ownerId', '==', user.id),
            where('studentId', '==', studentId)
          )
        );
        await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
      } catch (e) {
        console.warn(`Failed to remove ${label} for the deleted student:`, e);
      }
    }
  };

  const deleteStudent = async (studentId) => {
    // Captured before the optimistic removal below, since the cleanup needs
    // the student's email to find its directory entry.
    const student = students.find((s) => s.id === studentId);

    setStudents((prev) => prev.filter((s) => s.id !== studentId));
    setLogs((prev) => {
      const updated = { ...prev };
      delete updated[studentId];
      return updated;
    });

    if (user?.id) {
      try {
        // Deleting a document doesn't cascade-delete its subcollections —
        // remove the logs first or they'd be left orphaned in Firestore.
        const logsSnap = await getDocs(collection(db, 'users', user.id, 'students', studentId, 'logs'));
        await Promise.all(logsSnap.docs.map((d) => deleteDoc(d.ref)));
        await deleteDoc(doc(db, 'users', user.id, 'students', studentId));
      } catch (e) {
        console.warn('Failed to delete student from Firestore', e);
      }

      await deleteRecordsReferencingStudent(studentId, student);
    }
  };

  const deleteDrive = async (studentId, driveId) => {
    setLogs((prev) => ({
      ...prev,
      [studentId]: prev[studentId]?.filter((log) => log.id !== driveId) ?? [],
    }));

    if (user?.id) {
      try {
        const student = students.find((s) => s.id === studentId);
        const ownerId = student?.ownerId || user.id;
        await deleteDoc(doc(db, 'users', ownerId, 'students', studentId, 'logs', driveId));
      } catch (e) {
        console.warn('Failed to delete log from Firestore', e);
      }
    }
  };

  const isOwner = (studentId) => {
    const student = students.find((s) => s.id === studentId);
    return student?.ownerId === user?.id;
  };

  // Share a student by email. Access takes effect immediately once the recipient is
  // signed in with that email (Firestore rules check sharedWithEmails directly) —
  // whether they already have an account or create one later. An invitation record
  // is always created so a background job (see scripts/send-invitation-emails.js) can
  // email the recipient a link, either way.
  const shareStudent = async (studentId, recipientEmail) => {
    const email = normalizeEmail(recipientEmail);
    const student = students.find((s) => s.id === studentId);
    if (!student || student.ownerId !== user?.id) {
      throw new Error('Only the owner can share a student');
    }
    if (email === normalizeEmail(user.email || '')) {
      throw new Error("You can't share with yourself");
    }

    const currentSharedWith = student.sharedWith || [];
    if (currentSharedWith.some((s) => s.email === email)) {
      throw new Error('Already shared with that email');
    }

    // DEV-62: if the recipient already has an account, resolve their uid
    // right now instead of waiting for their next sign-in to self-resolve
    // it — see the emailToUid doc written on every sign-in above. Not
    // fatal if this lookup fails or finds nothing: the recipient signing
    // in with this exact address later still grants access the same way
    // it always has (sharedWithEmails), and self-resolves the uid then.
    let recipientUid = null;
    try {
      const mapSnap = await getDoc(doc(db, 'emailToUid', email));
      if (mapSnap.exists()) recipientUid = mapSnap.data().uid || null;
    } catch (e) {
      console.warn('Could not check for an existing account at that email (non-fatal):', e);
    }

    const updatedSharedWith = [
      ...currentSharedWith,
      { email, uid: recipientUid, addedAt: new Date().toISOString() },
    ];
    const updatedSharedWithEmails = updatedSharedWith.map((s) => s.email);
    const updatedSharedWithUids = updatedSharedWith.map((s) => s.uid).filter(Boolean);

    const studentRef = doc(db, 'users', user.id, 'students', studentId);
    await updateDoc(studentRef, {
      sharedWith: updatedSharedWith,
      sharedWithEmails: updatedSharedWithEmails,
      sharedWithUids: updatedSharedWithUids,
    });

    setStudents((prev) =>
      prev.map((s) =>
        s.id === studentId
          ? {
              ...s,
              sharedWith: updatedSharedWith,
              sharedWithEmails: updatedSharedWithEmails,
              sharedWithUids: updatedSharedWithUids,
            }
          : s
      )
    );

    await addDoc(collection(db, 'invitations'), {
      email,
      studentId,
      studentName: `${student.firstName} ${student.lastName}`,
      ownerId: user.id,
      ownerName: user.name,
      ownerEmail: user.email,
      createdAt: new Date().toISOString(),
      emailSent: false,
    });
  };

  const unshareStudent = async (studentId, recipientEmail) => {
    const email = normalizeEmail(recipientEmail);
    const student = students.find((s) => s.id === studentId);
    if (!student || student.ownerId !== user?.id) {
      throw new Error('Only the owner can unshare a student');
    }

    const updatedSharedWith = (student.sharedWith || []).filter((s) => s.email !== email);
    const updatedSharedWithEmails = updatedSharedWith.map((s) => s.email);
    const updatedSharedWithUids = updatedSharedWith.map((s) => s.uid).filter(Boolean);

    const studentRef = doc(db, 'users', user.id, 'students', studentId);
    await updateDoc(studentRef, {
      sharedWith: updatedSharedWith,
      sharedWithEmails: updatedSharedWithEmails,
      sharedWithUids: updatedSharedWithUids,
    });

    setStudents((prev) =>
      prev.map((s) =>
        s.id === studentId
          ? {
              ...s,
              sharedWith: updatedSharedWith,
              sharedWithEmails: updatedSharedWithEmails,
              sharedWithUids: updatedSharedWithUids,
            }
          : s
      )
    );
  };

  return (
    <AppContext.Provider
      value={{
        user,
        setUser,
        students,
        addStudent,
        findExistingStudentByEmail,
        requestStudentAccess,
        getPendingRequests,
        approveRequest,
        denyRequest,
        addLog,
        updateLog,
        getLogs,
        getTotals,
        updateStudentEmail,
        updateStudentState,
        deleteStudent,
        deleteDrive,
        hydrated,
        authChecked,
        syncing,
        isOwner,
        shareStudent,
        unshareStudent,
        claimSession,
        deleteSessionClaim,
        hasFamilyPack,
        studentHasFamilyPack,
        restorePurchases: restorePurchasesCall,
        biometricLocked,
        dismissBiometricLock: () => {
          lastBiometricUnlockAt.current = Date.now();
          setBiometricLocked(false);
        },
        biometricEnrollLabel,
        dismissBiometricEnrollPrompt: () => setBiometricEnrollLabel(null),
        restoredSession,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => {
  const context = useContext(AppContext);
  return {
    ...context,
    // signOut() triggers onAuthStateChanged(null), which is what actually
    // clears user state now — calling setUser(null) alone would leave
    // Firebase's real session active, and the listener would just set it
    // right back on its next check.
    logout: () => signOut(auth),
  };
};
