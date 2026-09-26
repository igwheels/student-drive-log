/**
 * Sends "a student was shared with you" emails — run by
 * .github/workflows/send-invitations.yml on a short schedule via GitHub
 * Actions (same Resend setup as the weekly progress emails, no separately
 * running server required).
 *
 * Sharing itself already takes effect the moment the recipient signs in with
 * the shared email (see shareStudent in src/context/AppContext.jsx) — this
 * script just notifies them, whether they have an account yet or not.
 *
 * Requires repo secrets: FIREBASE_SERVICE_ACCOUNT (JSON), RESEND_API_KEY
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Resend } from 'resend';
import { generateInvitationEmailContent } from '../src/utils/invitations.js';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });

const resend = new Resend(process.env.RESEND_API_KEY);

// Resend requires the sender to be a domain-verified address — see the
// Resend dashboard's Domains section for devworksllc.com's setup.
const FROM_EMAIL = 'ian@devworksllc.com';

const APP_URL = process.env.APP_URL || 'https://sdl.devworksllc.com/';

async function main() {
  const db = getFirestore();
  const pending = await db.collection('invitations').where('emailSent', '==', false).get();

  if (pending.empty) {
    console.log('No pending invitation emails.');
    return;
  }

  const results = await Promise.allSettled(
    pending.docs.map(async (docSnap) => {
      const invitation = docSnap.data();
      const { subject, text, html } = generateInvitationEmailContent(invitation, APP_URL);
      const { error } = await resend.emails.send({
        to: invitation.email,
        from: `Student Drive Log <${FROM_EMAIL}>`,
        replyTo: FROM_EMAIL,
        subject,
        text,
        html,
      });
      if (error) throw new Error(error.message || 'Resend send failed');
      await docSnap.ref.update({ emailSent: true, emailSentAt: new Date().toISOString() });
    })
  );

  const failed = results.filter((r) => r.status === 'rejected');
  console.log(`Sent ${results.length - failed.length}/${results.length} invitation emails.`);
  if (failed.length) {
    failed.forEach((f) => console.error(f.reason));
    process.exitCode = 1;
  }
}

main();
