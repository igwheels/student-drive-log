import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { ENTITLEMENTS_SUBCOLLECTION, FAMILY_PACK_ENTITLEMENT_ID, FREE_STUDENT_LIMIT } from './constants.js';
import { logger } from 'firebase-functions/v2';

// Denormalizes the OWNER's Family Pack status onto every student document
// they own, as `familyPackActive`. This is what lets DEV-37's gates work
// for a shared co-parent, not just the owner: firestore.rules already lets
// anyone in a student's sharedWithEmails read that student document (see
// isSharedWithMe in firestore.rules), but it deliberately does NOT let them
// read users/{ownerId} — that doc/subcollection belongs to the owner alone,
// and opening it up would leak more than the one boolean a viewer actually
// needs. Riding the flag along on the student doc means a shared viewer's
// existing read of the student (already happening in
// src/context/AppContext.jsx) is enough to know whether the household this
// student belongs to has Family Pack — no new cross-account read rule
// required.
//
// Per-account, not per-student: a free co-parent viewing a paying owner's
// student sees premium features on THAT student, while their own
// separately-owned students still gate off their own (un-purchased)
// entitlement. See the DEV-36 report for the full reasoning.
//
// Two triggers keep this correct regardless of ordering:
//  - onEntitlementWritten: purchase happens after students already exist ->
//    fan out to all of them now.
//  - onStudentCreated: a new student is added after Family Pack was already
//    purchased -> seed the flag on creation instead of waiting for the
//    entitlement doc to change again.
//
// Losing entitlement (refund approved — functions/src/
// appStoreServerNotifications.js writes active: false, which lands here the
// same as any other entitlement change) does more than flip the flag, per
// the product decision on DEV-36 (2026-10-01): it locks every student
// beyond the owner's single free one (`locked: true`, enforced in
// firestore.rules by blocking writes to a locked student's logs — reading
// existing history is still allowed, nothing is deleted), and revokes
// sharing on ALL of the owner's students, including the one that stays
// unlocked (the free tier never allows sharing at all). Regaining
// entitlement unlocks every student again, but deliberately does NOT
// restore a share that was revoked — the owner has to re-share explicitly,
// since the invited email may no longer be who they'd choose.
//
// "The owner's single free one" is whichever student has the oldest
// Firestore creation time — not a stored field (no client ever had reason
// to write one), but every document carries this as server-trusted
// metadata regardless of when it was created, so no backfill is needed for
// students that already existed before this logic did.
async function syncFamilyPackForOwner(uid, active) {
  const db = getFirestore();
  const studentsSnap = await db.collection('users').doc(uid).collection('students').get();
  if (studentsSnap.empty) return;

  const docs = [...studentsSnap.docs].sort((a, b) => a.createTime.toMillis() - b.createTime.toMillis());
  const keptStudentId = docs[0]?.id;

  // Batched writes cap at 500 mutations; chunk defensively even though no
  // household is remotely close to that today.
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const docSnap of docs.slice(i, i + 400)) {
      if (active) {
        batch.update(docSnap.ref, { familyPackActive: true, locked: false });
        continue;
      }
      batch.update(docSnap.ref, {
        familyPackActive: false,
        locked: docSnap.id !== keptStudentId,
        sharedWith: [],
        sharedWithEmails: [],
        sharedWithUids: [],
      });
    }
    await batch.commit();
  }
}

export const onEntitlementWritten = onDocumentWritten(
  { document: `users/{uid}/${ENTITLEMENTS_SUBCOLLECTION}/{entitlementId}`, region: 'us-central1' },
  async (event) => {
    if (event.params.entitlementId !== FAMILY_PACK_ENTITLEMENT_ID) return;
    const after = event.data?.after?.data();
    await syncFamilyPackForOwner(event.params.uid, Boolean(after?.active));
  }
);

export const onStudentCreated = onDocumentCreated(
  { document: 'users/{ownerId}/students/{studentId}', region: 'us-central1' },
  async (event) => {
    const db = getFirestore();
    const entitlementSnap = await db
      .collection('users')
      .doc(event.params.ownerId)
      .collection(ENTITLEMENTS_SUBCOLLECTION)
      .doc(FAMILY_PACK_ENTITLEMENT_ID)
      .get();
    const active = Boolean(entitlementSnap.data()?.active);
    if (active) {
      await event.data.ref.update({ familyPackActive: true });
      return;
    }

    // Server-side backstop for the free-tier student limit. AddStudent.jsx
    // checks this client-side before calling addStudent(), but that's a UX
    // convenience, not enforcement — firestore.rules' create rule for
    // students only checks that the caller owns the doc, not how many they
    // already have (Security Rules can't cheaply count a collection), so
    // nothing before this point actually stopped someone from creating a
    // second student without Family Pack. Reported 2026-10-01: buying
    // Family Pack, adding a second student, then refunding left that
    // second student fully usable — the purchase bought a one-time bypass
    // of a limit that was never real. This closes it by deleting a
    // just-created student over the limit, the moment it's created.
    const ownedSnap = await db.collection('users').doc(event.params.ownerId).collection('students').get();
    if (ownedSnap.size > FREE_STUDENT_LIMIT) {
      logger.warn('Deleting a student created over the free-tier limit without Family Pack', {
        ownerId: event.params.ownerId,
        studentId: event.params.studentId,
        count: ownedSnap.size,
      });
      await event.data.ref.delete();
    }
  }
);
