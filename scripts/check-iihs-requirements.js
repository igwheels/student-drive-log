/**
 * Monthly check that src/data/stateRequirements.js still matches IIHS's
 * published Graduated Licensing Laws table — run by
 * .github/workflows/check-iihs-requirements.yml on a monthly schedule via
 * GitHub Actions (same no-server pattern as send-invitation-emails.js /
 * send-weekly-emails.js).
 *
 * Deliberately does NOT auto-update stateRequirements.js. This data
 * carries real legal weight for a parent relying on it to meet a state
 * requirement — a silent, unreviewed auto-publish is exactly the kind of
 * mistake the app's own Terms of Use disclaimer exists to hedge against.
 * Instead: fetch, parse, diff against the committed file, and email a
 * human-readable diff for manual review. The actual edit to
 * stateRequirements.js stays a deliberate commit, same as the October 2026
 * update this script's existence was prompted by.
 *
 * Also treats "the page didn't parse the way we expect" as its own alert,
 * distinct from "no changes" — IIHS rephrasing a row in some future update
 * should surface as "needs a human look," not go silently unnoticed.
 *
 * Requires repo secret: RESEND_API_KEY. No Firebase/Firestore access needed
 * — this never touches user data, only the table bundled in this repo.
 */
import { Resend } from 'resend';
import { parseIihsTable } from './lib/parseIihsTable.js';
import { STATE_REQUIREMENTS } from '../src/data/stateRequirements.js';

const TABLE_URL = 'https://www.iihs.org/topics/teenagers/graduated-licensing-laws-table';
const FROM_EMAIL = 'ian@devworksllc.com';
const NOTIFY_EMAIL = process.env.IIHS_CHECK_NOTIFY_EMAIL || 'ian@devworksllc.com';

async function fetchTableHtml() {
  const res = await fetch(TABLE_URL, {
    headers: {
      // A plain Node fetch UA has been served non-HTML challenge pages by
      // some sites; a normal browser UA avoids that without doing anything
      // deceptive — this script identifies itself honestly in intent (it
      // fetches the one public page once a month), just not in this header.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`Fetching ${TABLE_URL} failed: HTTP ${res.status}`);
  }
  return res.text();
}

function diffAgainstCommitted(fetched) {
  const changes = [];
  const committedCodes = Object.keys(STATE_REQUIREMENTS);
  const fetchedCodes = Object.keys(fetched);

  for (const code of committedCodes) {
    if (!fetchedCodes.includes(code)) {
      changes.push(`${code}: present in stateRequirements.js but missing from the fetched table`);
      continue;
    }
    const committed = STATE_REQUIREMENTS[code];
    const current = fetched[code];
    if (committed.totalHours !== current.totalHours || committed.nightHours !== current.nightHours) {
      changes.push(
        `${code} (${committed.name}): totalHours ${committed.totalHours} -> ${current.totalHours}, ` +
          `nightHours ${committed.nightHours} -> ${current.nightHours}`
      );
    }
  }
  for (const code of fetchedCodes) {
    if (!committedCodes.includes(code)) {
      changes.push(`${code}: present in the fetched table but missing from stateRequirements.js`);
    }
  }
  return changes;
}

async function sendAlert(resend, subject, bodyLines) {
  const text = bodyLines.join('\n');
  const { error } = await resend.emails.send({
    to: NOTIFY_EMAIL,
    from: `Student Drive Log IIHS Check <${FROM_EMAIL}>`,
    replyTo: FROM_EMAIL,
    subject,
    text,
  });
  if (error) {
    // Surfacing this as a thrown error fails the Action run, which is the
    // fallback alert channel if Resend itself is down — still visible in
    // GitHub's own notification settings for failed workflow runs.
    throw new Error(`Resend failed to send the alert email: ${JSON.stringify(error)}`);
  }
}

async function main() {
  const resend = new Resend(process.env.RESEND_API_KEY);

  let fetched;
  try {
    const html = await fetchTableHtml();
    fetched = parseIihsTable(html);
  } catch (e) {
    console.error('IIHS table check failed to run:', e);
    await sendAlert(resend, 'Student Drive Log: IIHS table check FAILED to parse', [
      'The monthly IIHS Graduated Licensing Laws check could not parse the table this month.',
      '',
      `Error: ${e.message}`,
      '',
      `Check manually: ${TABLE_URL}`,
      'Compare against src/data/stateRequirements.js.',
      '',
      'This usually means IIHS changed the table\'s HTML structure or phrasing — ' +
        'scripts/lib/parseIihsTable.js will need updating before this check can run again.',
    ]);
    process.exitCode = 1;
    return;
  }

  const changes = diffAgainstCommitted(fetched);

  if (changes.length === 0) {
    console.log('IIHS table check: no changes since the last update to stateRequirements.js.');
    return;
  }

  console.log(`IIHS table check found ${changes.length} change(s):`);
  for (const line of changes) console.log(' -', line);

  await sendAlert(
    resend,
    `Student Drive Log: IIHS table changed (${changes.length} state${changes.length === 1 ? '' : 's'})`,
    [
      'IIHS updated their Graduated Licensing Laws table. The following no longer match ' +
        'src/data/stateRequirements.js:',
      '',
      ...changes.map((c) => `- ${c}`),
      '',
      `Source: ${TABLE_URL}`,
      '',
      'This is a notification only -- stateRequirements.js was NOT changed automatically. ' +
        'Review each change against the live table (phrasing/footnotes matter) before editing ' +
        'the file and shipping a new build.',
    ]
  );
}

main().catch((e) => {
  console.error('IIHS check script crashed:', e);
  process.exitCode = 1;
});
