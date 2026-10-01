// Shared Apple JWS verification setup — used by both appStore.js (verifying
// a purchase at the moment of sale) and ../appStoreServerNotifications.js
// (verifying Apple's async webhook calls, e.g. refunds). Pulled out here
// rather than duplicated: both need the same root cert, bundle id, and
// sandbox/production fallback logic, and a bug in one place is better than
// a bug that only shows up in one of the two call sites.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SignedDataVerifier, Environment, VerificationStatus } from '@apple/app-store-server-library';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUNDLE_ID = 'com.devworksllc.sdl';
// App Apple ID (from the ITMS-90683 delivery email) — only required when
// verifying against Environment.PRODUCTION; omitted for sandbox.
const APP_APPLE_ID = 6816531193;

// Downloaded from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// (valid through 2039) — see https://www.apple.com/certificateauthority/
// for the canonical source if this ever needs rotating.
const APPLE_ROOT_CA = readFileSync(join(__dirname, 'certs', 'AppleRootCA-G3.cer'));

export function verifierFor(environment) {
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

// There's no header or flag telling us up front whether a given signed blob
// (transaction or notification) is sandbox or production — the environment
// is itself one of the fields SignedDataVerifier checks as part of
// verification, so we have to guess-and-retry rather than branch first.
// Tries sandbox first, since every purchase is sandbox until this ships to
// production and real users start buying it.
export async function withEnvironmentFallback(verify) {
  try {
    return await verify(verifierFor(Environment.SANDBOX));
  } catch (e) {
    if (e?.status !== VerificationStatus.INVALID_ENVIRONMENT) throw e;
  }
  return verify(verifierFor(Environment.PRODUCTION));
}
