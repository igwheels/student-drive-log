/**
 * Weekly progress emails — run by .github/workflows/weekly-emails.yml
 * on a Monday-morning schedule via GitHub Actions (no separate server needed).
 *
 * Sent to everyone with access to the student's dashboard: the student
 * themselves (student.email, if set), the owner (ownerEmail), and anyone
 * the student has been shared with (sharedWithEmails) — see shareStudent
 * in src/context/AppContext.jsx. A recipient who has opted out (via the
 * unsubscribe link in the email, or the checkbox on their Account page —
 * see src/pages/Unsubscribe.jsx and src/pages/Account.jsx) is skipped;
 * opt-out status lives in emailPreferences/{email} and defaults to
 * subscribed when no document exists.
 *
 * Requires:
 *   - Firestore mirroring the app's students + logs
 *   - Repo secrets: FIREBASE_SERVICE_ACCOUNT (JSON), RESEND_API_KEY
 *
 * Emails deliberately contain no maps, routes, or start/end locations: the
 * recipients include minors, and repeated route imagery would expose their
 * location patterns. Only aggregate hours/mileage and drive type are included.
 *
 * Student names and drive fields come from user input and land in an HTML
 * body delivered to everyone with access to the dashboard, so every value
 * interpolated into `html` below is escaped and the subject is stripped of
 * newlines — see src/utils/escapeHtml.js. The plain-text part needs neither.
 *
 * Firestore structure expected:
 *   users/{uid}/students/{studentId}         -> { firstName, lastName, email, state,
 *                                                 ownerEmail, sharedWithEmails,
 *                                                 lastProgressEmailAt }
 *   users/{uid}/students/{studentId}/logs/*  -> { startTime, durationMinutes, timeOfDay,
 *                                                 type, distanceMiles }
 *   emailPreferences/{email}                 -> { weeklyEmailOptOut }
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Resend } from 'resend';
import { STATE_REQUIREMENTS } from '../src/data/stateRequirements.js';
import { renderGaugePng } from './lib/staticImages.js';
import { escapeHtml, sanitizeHeader } from '../src/utils/escapeHtml.js';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });

const resend = new Resend(process.env.RESEND_API_KEY);

// Resend requires the sender to be a domain-verified address — see the
// Resend dashboard's Domains section for devworksllc.com's setup.
const FROM_EMAIL = 'ian@devworksllc.com';

const APP_URL = process.env.APP_URL || 'https://sdl.devworksllc.com/';
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const fmt = (mins) => `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
// Formats the drive's own calendar date, which the app already recorded in
// the zone the drive started in. Formatting startTime here instead would
// render it in the Actions runner's zone (UTC), so an evening drive would be
// listed a day later in the email than it appears in the app.
const fmtDate = (log) => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(log.date || '');
  const asUtc = parts
    ? new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))
    : new Date(log.startTime); // pre-dating the stored date; best available
  return asUtc.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const DRIVE_TYPE_LABELS = { local: 'Local', rural: 'Rural', highway: 'Highway' };

function unsubscribeUrl(email) {
  const base = APP_URL.endsWith('/') ? APP_URL : `${APP_URL}/`;
  return `${base}#/unsubscribe?email=${encodeURIComponent(email)}`;
}

async function isOptedOut(db, cache, email) {
  if (cache.has(email)) return cache.get(email);
  const snap = await db.collection('emailPreferences').doc(email).get();
  const optedOut = snap.exists && snap.data().weeklyEmailOptOut === true;
  cache.set(email, optedOut);
  return optedOut;
}

async function main() {
  const db = getFirestore();
  const students = await db.collectionGroup('students').get();
  const optOutCache = new Map();

  const sends = [];
  for (const doc of students.docs) {
    const student = doc.data();

    const allRecipients = new Set();
    for (const email of [student.email, student.ownerEmail, ...(student.sharedWithEmails ?? [])]) {
      if (email) allRecipients.add(email.trim().toLowerCase());
    }
    if (allRecipients.size === 0) continue;

    const recipients = [];
    for (const email of allRecipients) {
      if (!(await isOptedOut(db, optOutCache, email))) recipients.push(email);
    }

    const logsSnap = await doc.ref.collection('logs').get();
    const allLogs = logsSnap.docs.map((l) => l.data());

    let total = 0;
    let night = 0;
    allLogs.forEach((d) => {
      total += d.durationMinutes ?? 0;
      if (d.timeOfDay === 'night') night += d.durationMinutes ?? 0;
    });

    const since = student.lastProgressEmailAt
      ? new Date(student.lastProgressEmailAt)
      : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    const recentLogs = allLogs
      .filter((d) => d.startTime && new Date(d.startTime) > since)
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    const req = STATE_REQUIREMENTS[student.state] ?? { totalHours: 0, nightHours: 0, name: student.state };
    const totalGoalMinutes = req.totalHours * 60;
    const nightGoalMinutes = req.nightHours * 60;
    const pct = req.totalHours > 0 ? Math.min(100, Math.round((total / totalGoalMinutes) * 100)) : null;
    const progressLine =
      pct != null
        ? `${student.firstName} is ${pct}% of the way to the ${req.totalHours}-hour goal.` +
          (req.nightHours > 0 ? ` Night driving: ${fmt(night)} of ${req.nightHours}h.` : '')
        : `${req.name ?? 'Your state'} has no minimum hour requirement — every hour logged is above and beyond!`;

    if (recipients.length === 0) {
      // Everyone with access has opted out — still advance the "since last
      // email" window below, but skip the (costly) image rendering and send.
      await doc.ref.update({ lastProgressEmailAt: new Date().toISOString() });
      continue;
    }

    // Pre-render the images shared by every recipient of this student's email
    // once, rather than per recipient.
    const totalGaugePng = await renderGaugePng({
      label: 'Total hours',
      value: total,
      goal: totalGoalMinutes || 1,
      color: '#2F6FDE',
    });
    const nightGaugePng =
      req.nightHours > 0
        ? await renderGaugePng({ label: 'Night hours', value: night, goal: nightGoalMinutes, color: '#6C5CE7' })
        : null;

    const driveRows = recentLogs
      .map((d) => {
        const meta = `${DRIVE_TYPE_LABELS[d.type] ?? d.type} · ${d.timeOfDay === 'night' ? 'Night' : 'Day'}${
          d.distanceMiles != null ? ` · ${d.distanceMiles} mi` : ''
        }`;
        return { date: fmtDate(d), meta, duration: fmt(d.durationMinutes) };
      });

    const driveTextBlock = driveRows.length
      ? driveRows.map((r) => `- ${r.date}: ${r.meta}, ${r.duration}`).join('\n')
      : 'No new drives logged this week.';

    const driveHtmlBlock = driveRows.length
      ? driveRows
          .map(
            (r) => `
            <div style="border:1px solid #DBE0EA;border-radius:10px;padding:14px;margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;font-size:14px;">
                <div><strong>${escapeHtml(r.date)}</strong><div style="color:#7C86A0;font-size:12px;text-transform:capitalize;">${escapeHtml(r.meta)}</div></div>
                <div style="font-weight:700;color:#2F6FDE;">${escapeHtml(r.duration)}</div>
              </div>
            </div>`
          )
          .join('')
      : '<p style="color:#7C86A0;">No new drives logged this week.</p>';

    const gaugesHtmlBlock = `
      <div style="text-align:center;margin:20px 0;">
        <img src="cid:gaugetotal" width="180" style="display:inline-block;margin:0 10px;" alt="Total hours gauge" />
        ${nightGaugePng ? '<img src="cid:gaugenight" width="180" style="display:inline-block;margin:0 10px;" alt="Night hours gauge" />' : ''}
      </div>`;

    // Resend attachments take base64-encoded content (not a raw Buffer) and
    // a contentId for each cid: reference in the HTML above — camelCase,
    // per the Resend Node SDK's Attachment type (node_modules/resend/dist/
    // index.d.mts), unlike the snake_case content_id/content_type most
    // other providers' REST APIs use. This file has no compile-time type
    // checking, so a wrong field name here fails silently: the SDK just
    // drops the unrecognized key and Resend ships the image as a normal
    // (non-inline) attachment instead of erroring — exactly what happened
    // the first time this used content_id.
    const toInlineAttachment = (filename, buffer, contentId) => ({
      filename,
      content: buffer.toString('base64'),
      contentType: 'image/png',
      contentId,
    });
    const attachments = [toInlineAttachment('gauge-total.png', totalGaugePng, 'gaugetotal')];
    if (nightGaugePng) attachments.push(toInlineAttachment('gauge-night.png', nightGaugePng, 'gaugenight'));

    for (const to of recipients) {
      const unsubUrl = unsubscribeUrl(to);
      sends.push(
        (async () => {
          const { error } = await resend.emails.send({
            to,
            from: `Student Drive Log <${FROM_EMAIL}>`,
            replyTo: FROM_EMAIL,
            subject: sanitizeHeader(`🚗 ${student.firstName}'s Weekly Driving Progress`),
            text: `${student.firstName}'s Weekly Driving Progress

Total supervised hours: ${fmt(total)}
Night hours: ${fmt(night)}
${progressLine}

Drives since your last update:
${driveTextBlock}

Keep up the great work!

---
Unsubscribe from weekly progress emails: ${unsubUrl}`,
            html: `
              <h2>${escapeHtml(student.firstName)}'s Weekly Driving Progress</h2>
              ${gaugesHtmlBlock}
              <p>${escapeHtml(progressLine)}</p>
              <h3 style="margin-top:24px;">Drives since your last update</h3>
              ${driveHtmlBlock}
              <p>Keep up the great work! 🏁</p>
              <hr style="border:none;border-top:1px solid #DBE0EA;margin:24px 0 12px;" />
              <p style="color:#7C86A0;font-size:12px;">
                <a href="${escapeHtml(unsubUrl)}" style="color:#7C86A0;">Unsubscribe from weekly progress emails</a>
              </p>`,
            attachments,
          });
          if (error) throw new Error(error.message || 'Resend send failed');
        })()
      );
    }

    await doc.ref.update({ lastProgressEmailAt: new Date().toISOString() });
  }

  const results = await Promise.allSettled(sends);
  const failed = results.filter((r) => r.status === 'rejected');
  console.log(`Sent ${results.length - failed.length}/${results.length} emails.`);
  if (failed.length) {
    failed.forEach((f) => console.error(f.reason));
    process.exitCode = 1;
  }
}

main();
