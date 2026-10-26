import { Capacitor } from '@capacitor/core';
import { getSharePlatform } from './device';
import { PUBLIC_APP_URL } from './snapshot';

// Pages that don't hand ShareButton an explicit url (e.g. the student list,
// Account) fall through to this. window.location.href is "capacitor://..."
// inside the native shell — not a link anyone outside the app can open — so
// native always shares the real published app instead; browsers keep sharing
// whatever page is actually open.
export function defaultShareUrl() {
  if (Capacitor.isNativePlatform()) return PUBLIC_APP_URL;
  return typeof window !== 'undefined' ? window.location.href : '';
}

/** True when the device offers a native share sheet, false everywhere else
 * (desktop browsers, some Android WebViews) — that's when explicit
 * email/SMS/social links stand in for it. */
export function hasNativeShare() {
  // WebKit defines navigator.share inside a Capacitor WKWebView, but calling
  // it there fails silently rather than opening a share sheet (no real
  // top-level browsing context for the Web Share API to hook into) — so
  // feature detection alone reports a working share sheet that isn't one.
  // The mailto/sms/whatsapp link fallback below is what actually works
  // inside the native shell, so never trust navigator.share there.
  if (Capacitor.isNativePlatform()) return false;
  return typeof navigator !== 'undefined' && !!navigator.share;
}

// Shared "share this" action used by both the topbar ShareButton and any
// other share-style buttons (e.g. "Brag on your student"). Uses the native
// share sheet when available, falling back to copying the link with an
// onCopied callback the caller can use to show a toast.
export async function shareContent({ title, text, url }, { onCopied } = {}) {
  const shareUrl = url || defaultShareUrl();
  const shareData = { title: title || document.title, text, url: shareUrl };

  if (hasNativeShare()) {
    try {
      await navigator.share(shareData);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error('Share failed:', err);
      }
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(shareUrl);
    onCopied?.();
  } catch (err) {
    console.error('Copy to clipboard failed:', err);
  }
}

// Explicit per-channel links for wherever there's no native share sheet to
// fall back on (see hasNativeShare above) — email, SMS, and WhatsApp compose
// screens pre-filled with the same title/text/url a native share would carry.
//
// The sms: URI has no agreed syntax across platforms once there's no phone
// number to address it to: iOS Safari only accepts "sms:&body=", while
// Android wants "sms:?body=" — getSharePlatform() picks the right one rather
// than guessing a single form that half of users would silently drop the
// pre-filled text on.
export function buildShareLinks({ title, text, url }) {
  const shareUrl = url || defaultShareUrl();
  const subject = title || (typeof document !== 'undefined' ? document.title : '');
  const body = [text, shareUrl].filter(Boolean).join('\n\n');
  const smsSeparator = getSharePlatform() === 'ios' ? '&' : '?';

  return {
    email: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    sms: `sms:${smsSeparator}body=${encodeURIComponent(body)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(body)}`,
  };
}
