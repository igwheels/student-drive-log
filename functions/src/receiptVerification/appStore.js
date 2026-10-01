// App Store receipt/transaction verification.
//
// Verifies the StoreKit 2 signed transaction (`jwsRepresentation`, from
// @capgo/native-purchases — see src/utils/entitlements.js) directly against
// Apple's own root certificate, via @apple/app-store-server-library's
// SignedDataVerifier — see appleVerifier.js for the shared setup. This is
// pure JWS/cert-chain verification, not a call to the App Store Server API,
// so no issuer-id/key-id/.p8 App Store Connect API key is needed at all.
// (An API key would only be needed for endpoints this app doesn't use yet,
// like fetching transaction history or subscription status.)
//
// The In-App Purchase's own Apple ID (from App Store Connect's Family Pack
// product page) is NOT used anywhere here — SignedDataVerifier scopes by
// bundle id, not by product.
import { withEnvironmentFallback } from './appleVerifier.js';
import { FAMILY_PACK_PRODUCT_ID } from '../constants.js';

export async function verifyAppStoreReceipt(payload) {
  const { jwsRepresentation } = payload || {};
  if (!jwsRepresentation) {
    throw new Error('Missing jwsRepresentation — the client sent no StoreKit 2 signed transaction to verify.');
  }

  const decoded = await withEnvironmentFallback((verifier) => verifier.verifyAndDecodeTransaction(jwsRepresentation));

  // Defense in depth: today there's only one product, and
  // validatePurchase.js already rejected any other productId before this
  // ran — but SignedDataVerifier only guarantees the transaction belongs to
  // THIS APP (bundle id), not to this specific product. Confirms the
  // Apple-signed payload actually says what the client claimed.
  if (decoded.productId !== FAMILY_PACK_PRODUCT_ID) {
    throw new Error(`Transaction is for a different product: ${decoded.productId}`);
  }
  // A refunded/revoked purchase still verifies (the signature is still
  // valid — Apple just also sets these fields), so this has to be checked
  // explicitly rather than treated as "verification failed". A refund
  // *after* the fact is instead caught by appStoreServerNotifications.js.
  if (decoded.revocationDate) {
    throw new Error('This purchase was refunded.');
  }

  return {
    transactionId: decoded.transactionId,
    productId: decoded.productId,
    environment: decoded.environment,
  };
}
