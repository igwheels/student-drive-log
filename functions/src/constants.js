// Shared path/id constants for the entitlement data model. Mirrored (not
// imported — the functions codebase is deployed independently of the web
// app, see functions/README.md) in src/utils/entitlements.js on the client
// side. If you change a value here, change it there too.

// users/{uid}/entitlements/{ENTITLEMENT_ID}
export const ENTITLEMENTS_SUBCOLLECTION = 'entitlements';
export const FAMILY_PACK_ENTITLEMENT_ID = 'familyPack';
export const FAMILY_PACK_PRODUCT_ID = 'family_pack_lifetime';

// Top-level collection recording every receipt/transaction that has ever
// been validated, keyed by `${store}:${transactionId}` — see
// functions/src/validatePurchase.js for why.
export const RECEIPTS_COLLECTION = 'receipts';

export const STORES = Object.freeze({
  APP_STORE: 'app_store',
  PLAY_STORE: 'play_store',
});

// Also mirrors src/utils/entitlements.js's FREE_STUDENT_LIMIT — see
// entitlementFanout.js's onStudentCreated, which is the server-side
// backstop for this limit (the client-side check in AddStudent.jsx is a UX
// convenience, not the enforcement — see that file's history for why it
// couldn't be trusted alone).
export const FREE_STUDENT_LIMIT = 1;
