// App Store receipt/transaction verification.
//
// Verifies the StoreKit 2 signed transaction (`jwsRepresentation`, from
// @capgo/native-purchases — see src/utils/entitlements.js) directly against
// Apple's own root certificate, via @apple/app-store-server-library's
// SignedDataVerifier. This is pure JWS/cert-chain verification — no App
// Store Server API call, and no issuer-id/key-id/.p8 App Store Connect API
// key needed at all, unlike the older verifyReceipt endpoint this comment
// used to describe. (An API key would only be needed for endpoints this app
// doesn't use yet, like fetching transaction history or subscription
// status.)
//
// App Apple ID (6816531193 — from the ITMS-90683 delivery email) is only
// required when verifying against Environment.PRODUCTION; sandbox
// verification (all testing, and real purchases until this ships to
// production) omits it. The In-App Purchase's own Apple ID (6817931021,
// from App Store Connect's Family Pack product page) is NOT used here —
// SignedDataVerifier scopes by bundle id, not by product.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SignedDataVerifier, Environment, VerificationStatus } from '@apple/app-store-server-library';
import { FAMILY_PACK_PRODUCT_ID } from '../constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_ID = 'com.devworksllc.sdl';
const APP_APPLE_ID = 6816531193;

// Downloaded from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// (valid through 2039) — see
// https://www.apple.com/certificateauthority/ for the canonical source if
// this ever needs rotating.
const APPLE_ROOT_CA = readFileSync(join(__dirname, 'certs', 'AppleRootCA-G3.cer'));

function verifierFor(environment) {
  // enableOnlineChecks: true does live revocation (OCSP) checking, which
  // needs outbound internet access — Cloud Functions has that by default.
  return new SignedDataVerifier(
    [APPLE_ROOT_CA],
    true,
    environment,
    BUNDLE_ID,
    environment === Environment.PRODUCTION ? APP_APPLE_ID : undefined
  );
}

// A transaction is genuinely sandbox or production — there's no header
// flag telling us which before we try, and StoreKit doesn't expose it to
// the client. Try sandbox first, since every purchase is sandbox until this
// ships to production and real users start buying it; fall back to
// production so this keeps working once it does.
async function verifyAndDecode(jwsRepresentation) {
  try {
    return await verifierFor(Environment.SANDBOX).verifyAndDecodeTransaction(jwsRepresentation);
  } catch (e) {
    if (e?.status !== VerificationStatus.INVALID_ENVIRONMENT) throw e;
  }
  return verifierFor(Environment.PRODUCTION).verifyAndDecodeTransaction(jwsRepresentation);
}

export async function verifyAppStoreReceipt(payload) {
  const { jwsRepresentation } = payload || {};
  if (!jwsRepresentation) {
    throw new Error('Missing jwsRepresentation — the client sent no StoreKit 2 signed transaction to verify.');
  }

  const decoded = await verifyAndDecode(jwsRepresentation);

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
  // explicitly rather than treated as "verification failed".
  if (decoded.revocationDate) {
    throw new Error('This purchase was refunded.');
  }

  return {
    transactionId: decoded.transactionId,
    productId: decoded.productId,
    environment: decoded.environment,
  };
}
