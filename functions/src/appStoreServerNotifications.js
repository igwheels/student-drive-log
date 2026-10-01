// Receives Apple's App Store Server Notifications V2 — the gap flagged
// after shipping verifyAppStoreReceipt: that function only checks for a
// refund at the moment someone calls Restore Purchases, so a refund that
// happens afterwards with no further app activity would otherwise leave
// `active: true` forever. This closes that gap by reacting the moment
// Apple tells us, rather than waiting for the user to do something.
//
// Setup (one-time, in App Store Connect): App info → App Store Server
// Notifications → set both the Production and Sandbox Server URL to this
// function's URL, version 2. One URL handles both — environment is a field
// INSIDE the signed payload, not something the URL needs to encode.
//
// Not auth-gated (onCall requires a Firebase ID token; Apple's servers
// don't have one) — onRequest instead, with the signature on the payload
// itself as the only thing establishing that this really came from Apple.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { withEnvironmentFallback } from './receiptVerification/appleVerifier.js';
import {
  ENTITLEMENTS_SUBCOLLECTION,
  FAMILY_PACK_ENTITLEMENT_ID,
  FAMILY_PACK_PRODUCT_ID,
  RECEIPTS_COLLECTION,
  STORES,
} from './constants.js';

// Notification types that mean "this account should no longer have the
// entitlement" vs. "give it back" (a refund Apple later reversed, e.g. after
// a successful dispute). Every other notification type either doesn't apply
// to a non-consumable (subscription renewal/billing events) or needs no
// action from us (ONE_TIME_CHARGE is informational — the purchase itself
// was already handled by validatePurchase.js at the moment of sale).
const REVOKE_TYPES = new Set(['REFUND', 'REVOKE']);
const RESTORE_TYPES = new Set(['REFUND_REVERSED']);

export const appStoreServerNotifications = onRequest({ region: 'us-central1' }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const signedPayload = req.body?.signedPayload;
  if (typeof signedPayload !== 'string') {
    res.status(400).send('Missing signedPayload');
    return;
  }

  let notification;
  try {
    notification = await withEnvironmentFallback((verifier) => verifier.verifyAndDecodeNotification(signedPayload));
  } catch (e) {
    logger.warn('Rejected an unverifiable App Store Server Notification', e);
    res.status(400).send('Could not verify signedPayload');
    return;
  }

  const { notificationType, subtype, data } = notification;
  logger.info('App Store Server Notification', { notificationType, subtype, environment: data?.environment });

  // Apple's "Send Test Notification" button in App Store Connect — nothing
  // to act on, just confirms the endpoint is reachable and verifiable.
  if (notificationType === 'TEST') {
    res.status(200).send('ok');
    return;
  }

  if (!REVOKE_TYPES.has(notificationType) && !RESTORE_TYPES.has(notificationType)) {
    // Expected for most notification types this app will ever receive —
    // see the comment on REVOKE_TYPES above. Not an error.
    res.status(200).send('ignored');
    return;
  }

  if (!data?.signedTransactionInfo) {
    logger.warn('Refund-type notification with no signedTransactionInfo', { notificationType });
    res.status(200).send('ignored');
    return;
  }

  let transaction;
  try {
    transaction = await withEnvironmentFallback((verifier) =>
      verifier.verifyAndDecodeTransaction(data.signedTransactionInfo)
    );
  } catch (e) {
    logger.error('Notification verified, but its embedded transaction did not', e);
    res.status(400).send('Could not verify embedded transaction');
    return;
  }

  if (transaction.productId !== FAMILY_PACK_PRODUCT_ID) {
    // A notification for some other product this app doesn't sell (yet) —
    // ignore rather than reject, since a stricter check here only matters
    // once a second product exists.
    res.status(200).send('ignored');
    return;
  }

  const active = RESTORE_TYPES.has(notificationType);
  const receiptId = `${STORES.APP_STORE}:${transaction.transactionId}`;
  const db = getFirestore();
  const receiptSnap = await db.collection(RECEIPTS_COLLECTION).doc(receiptId).get();

  if (!receiptSnap.exists) {
    // A refund for a transaction this app never recorded — e.g. one that
    // predates this deploy, or a sandbox test transaction that was never
    // actually sent through validatePurchase. Nothing to revoke.
    logger.warn('Refund notification for an unknown receipt', { receiptId, notificationType });
    res.status(200).send('ignored');
    return;
  }

  const { uid } = receiptSnap.data();
  await db
    .collection('users')
    .doc(uid)
    .collection(ENTITLEMENTS_SUBCOLLECTION)
    .doc(FAMILY_PACK_ENTITLEMENT_ID)
    .set(
      {
        active,
        revokedAt: active ? FieldValue.delete() : FieldValue.serverTimestamp(),
        revocationReason: active ? FieldValue.delete() : notificationType,
      },
      { merge: true }
    );
  // Kept for audit — doesn't gate anything (the entitlement doc above is
  // the only thing src/utils/entitlements.js reads).
  await receiptSnap.ref.set({ revokedAt: active ? FieldValue.delete() : FieldValue.serverTimestamp() }, { merge: true });

  logger.info(active ? 'Restored Family Pack after a reversed refund' : 'Revoked Family Pack after a refund', {
    uid,
    receiptId,
    notificationType,
  });
  res.status(200).send('ok');
});
