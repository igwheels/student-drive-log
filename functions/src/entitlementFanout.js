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

async function setFamilyPackActiveForOwner(uid, active) {
  const db = getFirestore();
  const studentsSnap = await db.collection('users').doc(uid).collection('students').get();
  if (studentsSnap.empty) return;

  // Batched writes cap at 500 mutations; chunk defensively even though no
  // household is remotely close to that today.
  const docs = studentsSnap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const docSnap of docs.slice(i, i + 400)) {
      batch.update(docSnap.ref, { familyPackActive: active });
    }
    await batch.commit();
  }
}

export const onEntitlementWritten = onDocumentWritten(
  { document: `users/{uid}/${ENTITLEMENTS_SUBCOLLECTION}/{entitlementId}`, region: 'us-central1' },
  async (event) => {
    if (event.params.entitlementId !== FAMILY_PACK_ENTITLEMENT_ID) return;
    const after = event.data?.after?.data();
    await setFamilyPackActiveForOwner(event.params.uid, Boolean(after?.active));
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
