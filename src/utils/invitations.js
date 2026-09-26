/**
 * Invitation email template for student sharing.
 *
 * Sharing itself takes effect instantly (see shareStudent in AppContext.jsx) —
 * this template is only for the courtesy email that lets the recipient know.
 * Emails are actually sent by scripts/send-invitation-emails.js, run on a
 * schedule via .github/workflows/send-invitations.yml (Gmail + Nodemailer,
 * same setup as the weekly progress emails — no extra service required).
 *
 * ownerName and studentName are attacker-controllable (a display name and a
 * free-text student name), and the recipient address is whatever the sharer
 * typed — so every value interpolated into the HTML below is escaped, and
 * the subject is stripped of newlines. See src/utils/escapeHtml.js.
 */
import { escapeHtml, sanitizeHeader } from './escapeHtml.js';

export const generateSignupLink = (email, appUrl) => {
  // HashRouter + GitHub Pages base path: the query string must live inside
  // the hash fragment (…#/?email=…) or it gets dropped/404s on a direct load.
  const base = appUrl.endsWith('/') ? appUrl : `${appUrl}/`;
  return `${base}#/?email=${encodeURIComponent(email)}`;
};

export const generateInvitationEmailContent = (invitation, appUrl) => {
  const signupUrl = generateSignupLink(invitation.email, appUrl);

  const text = `${invitation.ownerName} (${invitation.ownerEmail}) shared ${invitation.studentName}'s Student Drive Log with you.

Sign in with this email address (${invitation.email}) to view driving hours, progress toward state requirements, and log drives yourself. If you don't have an account yet, just enter this email and a password to create one — access is granted automatically.

Open Student Drive Log: ${signupUrl}

This is an automatic message from Student Drive Log. If you didn't expect this, you can safely ignore it.`;

  return {
    subject: sanitizeHeader(
      `${invitation.ownerName} shared ${invitation.studentName}'s driving log with you`
    ),
    text,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #0A2A5E; margin-bottom: 16px;">You've got access to a Student Drive Log!</h2>

        <p style="color: #4B5563; line-height: 1.6; margin-bottom: 16px;">
          <strong>${escapeHtml(invitation.ownerName)}</strong> (${escapeHtml(invitation.ownerEmail)}) shared
          <strong> ${escapeHtml(invitation.studentName)}</strong>'s Student Drive Log with you.
        </p>

        <p style="color: #4B5563; line-height: 1.6; margin-bottom: 24px;">
          Sign in with this email address (${escapeHtml(invitation.email)}) to view driving hours, progress toward
          state requirements, and log drives yourself. If you don't have an account yet, just enter
          this email and a password to create one — access is granted automatically.
        </p>

        <p style="text-align: center; margin-bottom: 24px;">
          <a href="${escapeHtml(signupUrl)}" style="
            display: inline-block;
            padding: 12px 32px;
            background-color: #2F6FDE;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 16px;
          ">Open Student Drive Log</a>
        </p>

        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />

        <p style="color: #9CA3AF; font-size: 12px; margin: 0;">
          This is an automatic message from Student Drive Log. If you didn't expect this, you can safely ignore it.
        </p>
      </div>
    `,
  };
};
