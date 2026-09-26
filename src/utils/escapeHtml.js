/**
 * Escaping helpers for the outbound email templates.
 *
 * Names in this app are free text typed by a user (a student's first/last
 * name) or taken from a self-chosen auth profile (the owner's displayName),
 * and both get interpolated into HTML email bodies that are delivered to
 * *other* people from this project's own sending address. Without escaping,
 * anyone who can create an account can put arbitrary markup — a link, a
 * hidden block, a whole fake message — into mail that arrives looking like
 * it came from Student Drive Log. Every interpolation of user-controlled
 * text into an email's HTML must go through escapeHtml().
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips CR/LF from a value destined for a mail header (Subject, etc.), so a
 * name containing a newline can't split the header and inject extra ones.
 */
export function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}
