import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function TermsOfUse() {
  const navigate = useNavigate();

  return (
    <div className="page legal-page">
      <button className="back" style={{ marginBottom: 16, color: 'var(--blue)' }} onClick={() => navigate(-1)}>
        ‹ Back
      </button>

      <h2>Terms of Use</h2>
      <p className="legal-updated">Last updated: February 2026</p>

      <p>
        These Terms of Use ("Terms") govern your use of Student Drive Log (the "Service"), operated
        by{' '}
        <a href="https://www.devworksllc.com" target="_blank" rel="noopener noreferrer">
          DevWorks LLC
        </a>{' '}
        ("we," "us," or "our"). By creating an account or using the Service, you
        agree to these Terms. If you do not agree, do not use the Service.
      </p>

      <h3>1. Who may use the Service</h3>
      <p>
        You must be at least 18 years old and the parent, legal guardian, or an adult supervising
        driver authorized by the parent or guardian of the student driver whose hours you record.
        By adding a student driver, you represent that you have the authority and permission to
        record and store information about that person.
      </p>

      <h3>2. Your account</h3>
      <p>
        You are responsible for maintaining the confidentiality of your login credentials and for
        all activity that occurs under your account. Notify us promptly if you believe your account
        has been accessed without your authorization.
      </p>

      <h3>3. The Service is a record-keeping tool, not legal or official certification</h3>
      <p>
        The Service helps you record supervised driving practice. It does not verify that any drive
        actually occurred, that the times or distances entered are accurate, or that any recorded
        practice satisfies your state's licensing requirements. You alone are responsible for the
        accuracy and truthfulness of everything you enter.
      </p>
      <p>
        Any affidavit, log, or PDF the Service produces is generated solely from the information you
        entered. Submitting a false or inaccurate certification to a Department of Motor Vehicles or
        similar agency may carry legal consequences for you. Before submitting anything to a state
        agency, review it carefully and confirm it is complete and truthful.
      </p>

      <h3>4. State requirement information</h3>
      <p>
        The Service displays state supervised-driving requirements compiled from publicly available
        sources, including the Insurance Institute for Highway Safety's Graduated Licensing Laws
        table. These laws change, and our information may be incomplete or out of date. The
        requirements shown are for general reference only. Always confirm current requirements with
        your state's licensing agency.
      </p>

      <h3>5. Sharing dashboards with others</h3>
      <p>
        The Service allows you to share a student driver's dashboard with another person by email
        address. When you do so:
      </p>
      <ul>
        <li>
          You confirm you have that person's permission to send them an invitation at that address.
        </li>
        <li>
          That person will be able to view the student's information and logged drives, add and
          delete drives, and export the log.
        </li>
        <li>
          You remain responsible for who you grant access to. You may revoke access at any time, but
          revoking access does not delete drives that person already recorded, and does not undo any
          information they may already have seen or exported.
        </li>
      </ul>

      <h3>6. Snapshot links</h3>
      <p>
        The Service can generate a shareable "snapshot" link showing a student's progress or an
        individual drive. The information is encoded into the link itself and is viewable by anyone
        who has it — no sign-in is required, and a link cannot be revoked once shared. Snapshots
        contain no location data, but they do identify the student by first name along with their
        driving activity, so you remain responsible for deciding who to send them to.
      </p>

      <h3>7. Location data</h3>
      <p>
        If you grant location permission, the Service records GPS coordinates while a drive is being
        timed in order to calculate mileage and draw a route map. Granting permission is optional;
        you may decline and enter mileage manually. You are responsible for ensuring you have the
        student driver's and their parent or guardian's knowledge and agreement before recording
        their location.
      </p>

      <h3>8. Acceptable use</h3>
      <p>You agree not to:</p>
      <ul>
        <li>Enter information about a person without authority to do so</li>
        <li>Record driving practice that did not occur, or falsify times, dates, or distances</li>
        <li>Attempt to access another user's account or data</li>
        <li>Interfere with, disrupt, or attempt to circumvent the security of the Service</li>
        <li>Use the Service for any unlawful purpose</li>
      </ul>

      <h3>9. Your content</h3>
      <p>
        You retain ownership of the information you enter. You grant us a limited license to store,
        process, and display that information solely to operate and provide the Service to you and
        anyone you have shared a dashboard with.
      </p>

      <h3>10. Service availability</h3>
      <p>
        The Service is provided free of charge and on an "as is" and "as available" basis. We do not
        guarantee that it will be uninterrupted, error-free, or that data will never be lost. We may
        modify, suspend, or discontinue the Service at any time. We strongly encourage you to export
        and retain your own copy of any driving log you may need for official purposes.
      </p>

      <h3>11. Disclaimer of warranties</h3>
      <p>
        To the fullest extent permitted by law, we disclaim all warranties, express or implied,
        including any implied warranties of merchantability, fitness for a particular purpose, and
        non-infringement. We do not warrant that the Service will meet your requirements or that any
        information it provides is accurate or complete.
      </p>

      <h3>12. Limitation of liability</h3>
      <p>
        To the fullest extent permitted by law,{' '}
        <a href="https://www.devworksllc.com" target="_blank" rel="noopener noreferrer">
          DevWorks LLC
        </a>{' '}
        will not be liable for any indirect,
        incidental, consequential, or special damages, or for any loss of data, arising out of or
        relating to your use of the Service — including any rejection of a driving log by a licensing
        agency, any loss of recorded hours, or any consequence of relying on state requirement
        information shown in the Service.
      </p>

      <h3>13. Termination</h3>
      <p>
        You may delete your account at any time from the Account page. We may suspend or terminate
        access if we believe these Terms have been violated. Deleting your account permanently
        removes the dashboards you own and their recorded drives.
      </p>

      <h3>14. Changes to these Terms</h3>
      <p>
        We may update these Terms from time to time. Continued use of the Service after changes take
        effect constitutes acceptance of the revised Terms.
      </p>

      <h3>15. Contact</h3>
      <p>
        Questions about these Terms may be directed to{' '}
        <a href="https://www.devworksllc.com" target="_blank" rel="noopener noreferrer">
          DevWorks LLC
        </a>{' '}
        at <a href="mailto:ian@devworksllc.com">ian@devworksllc.com</a>.
      </p>
    </div>
  );
}
