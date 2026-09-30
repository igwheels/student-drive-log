// Client side of the Family Pack entitlement model. See
// functions/src/validatePurchase.js and firestore.rules for the trusted
// half — this file never grants entitlement itself, it only reads what the
// server already decided, plus the callable wrapper for when a purchase
// actually happens.
import { httpsCallable } from 'firebase/functions';
import { doc, onSnapshot } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { NativePurchases, PURCHASE_TYPE } from '@capgo/native-purchases';
import { db, functions } from '../firebase';

// Mirrors functions/src/constants.js — see the note there on why these
// aren't imported directly (the functions codebase deploys independently).
const ENTITLEMENTS_SUBCOLLECTION = 'entitlements';
const FAMILY_PACK_ENTITLEMENT_ID = 'familyPack';
export const FAMILY_PACK_PRODUCT_ID = 'family_pack_lifetime';
// Also mirrors functions/src/constants.js's STORES.
const STORES = { APP_STORE: 'app_store', PLAY_STORE: 'play_store' };

// Same product id must exist on both App Store Connect and Play Console —
// see the DEV-36 store-setup notes. Returns null on web (no IAP there; the
// PWA has never sold Family Pack, only the native apps do).
function currentStore() {
  const platform = Capacitor.getPlatform();
  if (platform === 'ios') return STORES.APP_STORE;
  if (platform === 'android') return STORES.PLAY_STORE;
  return null;
}

// The Android application id, required alongside a purchase token when
// verifying against the Play Developer API — see
// functions/src/receiptVerification/playStore.js.
const ANDROID_PACKAGE_NAME = 'com.devworksllc.sdl';

// Free-tier limits (product decision, 2026-09-07): a free account owns at
// most one student and can't share a dashboard with another supervisor —
// the owner is the only supervisor. Family Pack removes both limits
// (unlimited students, plus sharing). CSV export is NOT gated — it stays
// free regardless of entitlement; see src/pages/Dashboard.jsx.
export const FREE_STUDENT_LIMIT = 1;

// Live-subscribes to the signed-in user's OWN entitlement doc. Used for
// gates on actions the account owner performs (adding another student,
// sharing with another supervisor) — see the DEV-36 report for why those
// are different from gates on a shared student's features, which read
// `familyPackActive` off the student document instead (see
// studentHasFamilyPack below).
export function watchOwnFamilyPack(uid, callback) {
  if (!uid) {
    callback(false);
    return () => {};
  }
  const ref = doc(db, 'users', uid, ENTITLEMENTS_SUBCOLLECTION, FAMILY_PACK_ENTITLEMENT_ID);
  return onSnapshot(
    ref,
    (snap) => callback(Boolean(snap.data()?.active)),
    () => callback(false)
  );
}

// Whether a given student's OWNING household has Family Pack — this is
// what a shared co-parent's gates should check for features on that
// student (CSV export, telematics trends, custom reminders), rather than
// their own entitlement. Reads the flag functions/src/entitlementFanout.js
// denormalizes onto the student document, which the current viewer already
// has read access to (owner or shared, per firestore.rules).
//
// NOTE: like the rest of AppContext's student list, this reflects whatever
// was loaded on the last fetch, not a live subscription — a purchase made
// in another tab won't flip this until students are reloaded (matches the
// existing one-time getDocs() pattern in AppContext.jsx, not a new
// limitation introduced here).
export function studentHasFamilyPack(student) {
  return Boolean(student?.familyPackActive);
}

// Sends a verified receipt/transaction to validatePurchase. Used both right
// after a purchase completes and for Apple's required "Restore Purchases"
// flow — a restore just redelivers the same transaction, which lands on
// the idempotent branch in functions/src/validatePurchase.js.
export async function validatePurchase({ store, productId, transactionId, receiptPayload }) {
  const call = httpsCallable(functions, 'validatePurchase');
  const result = await call({ store, productId, transactionId, receiptPayload });
  return result.data;
}

// The @capgo/native-purchases result shape differs per platform (see its
// README's "Transaction Properties by Platform" table) — this is the only
// place that needs to know that. iOS carries both the legacy base64
// `receipt` and the StoreKit 2 `jwsRepresentation`; sending both lets
// verifyAppStoreReceipt (functions/src/receiptVerification/appStore.js) use
// whichever the App Store Server API integration ends up needing. Android
// has no receipt blob at all — verification there is a server-side call to
// the Play Developer API keyed on `purchaseToken` + the package name.
function receiptPayloadFrom(store, result) {
  if (store === STORES.APP_STORE) {
    return { receipt: result.receipt ?? null, jwsRepresentation: result.jwsRepresentation ?? null };
  }
  return { purchaseToken: result.purchaseToken, packageName: ANDROID_PACKAGE_NAME };
}

// Fetches the live product info (title, formatted price) to display before
// purchase — required by both stores' review guidelines: the price shown
// must come from the store, never be hardcoded, since a live price change
// would otherwise go stale in the app. Returns null on web or if the store
// can't be reached (e.g. simulator/emulator without a signed-in store
// account); the caller should fall back to a static "$9.99" in that case.
export async function getFamilyPackProduct() {
  const store = currentStore();
  if (!store) return null;
  try {
    const { product } = await NativePurchases.getProduct({
      productIdentifier: FAMILY_PACK_PRODUCT_ID,
      productType: PURCHASE_TYPE.INAPP,
    });
    return product;
  } catch {
    return null;
  }
}

// Runs the native purchase flow, then validates the resulting
// receipt/token server-side. Throws on cancellation, a store-side failure,
// or a failed/unimplemented server validation (see
// functions/src/receiptVerification/{appStore,playStore}.js — both are
// stubs until real Apple/Google credentials exist, so this currently
// always rejects with functions/unimplemented after a real purchase; the
// purchase itself still completes on the store's side, so restorePurchases
// below is how it gets credited once verification is wired up).
export async function purchaseFamilyPack() {
  const store = currentStore();
  if (!store) throw new Error('Family Pack can only be purchased in the iOS or Android app.');

  const { isBillingSupported } = await NativePurchases.isBillingSupported();
  if (!isBillingSupported) throw new Error('Purchases aren’t supported on this device right now.');

  const result = await NativePurchases.purchaseProduct({
    productIdentifier: FAMILY_PACK_PRODUCT_ID,
    productType: PURCHASE_TYPE.INAPP,
    quantity: 1,
  });

  return validatePurchase({
    store,
    productId: FAMILY_PACK_PRODUCT_ID,
    transactionId: result.transactionId,
    receiptPayload: receiptPayloadFrom(store, result),
  });
}

// The "Restore Purchases" button Apple requires be somewhere in the app
// (Google has no equivalent requirement, but re-running this on Android is
// harmless — getPurchases() there just lists what the signed-in Google
// account already owns). NativePurchases.restorePurchases() re-syncs
// StoreKit's transaction list on iOS; Android doesn't need an explicit
// restore step, since Play purchases are already tied to the signed-in
// account, but calling it anyway keeps this one code path cross-platform.
//
// Throws if Family Pack isn't among the restored purchases — the caller
// (Account.jsx) shows that as "Nothing to restore" rather than an error.
export async function restorePurchases() {
  const store = currentStore();
  if (!store) throw new Error('Restore Purchases is only available in the iOS or Android app.');

  await NativePurchases.restorePurchases().catch(() => {
    // iOS: restorePurchases() can reject if there's simply nothing to
    // restore, which getPurchases() below will also correctly report as
    // empty — no need to surface this as a separate failure.
  });

  const { purchases } = await NativePurchases.getPurchases({ productType: PURCHASE_TYPE.INAPP });
  const purchase = purchases.find((p) => p.productIdentifier === FAMILY_PACK_PRODUCT_ID);
  if (!purchase) throw new Error('No previous Family Pack purchase found for this account.');

  return validatePurchase({
    store,
    productId: FAMILY_PACK_PRODUCT_ID,
    transactionId: purchase.transactionId,
    receiptPayload: receiptPayloadFrom(store, purchase),
  });
}
