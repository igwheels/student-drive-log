import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { studentHasFamilyPack } from '../utils/entitlements';

export default function ShareModal({ studentId, student, onClose, onShare }) {
  const { shareStudent, isOwner, hasFamilyPack } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Keys off the owning household's entitlement, not the acting viewer's
  // own — a free co-parent shared onto a Family Pack owner's student can
  // still add another supervisor to that student; a free owner's own
  // student can't gain a new share until the owner buys Family Pack. See
  // DEV-36 for why this split matters.
  //
  // ShareModal is only ever opened by the owner today (Dashboard.jsx gates
  // the Share button on isOwner()), so when that's true the LIVE
  // hasFamilyPack from AppContext is used in preference to
  // student.familyPackActive — the denormalized flag on the student doc is
  // only refreshed by a full student-list reload (AppContext's one-time
  // getDocs(), not a live subscription), so it can lag the real,
  // live-subscribed entitlement by as long as the session has been open.
  // Reported 2026-10-01: that lag let a just-refunded owner still see (and
  // briefly use) the share form. The firestore.rules write rule is the
  // actual enforcement regardless of what this shows; this is purely about
  // not showing a form that the server would then reject. The
  // studentHasFamilyPack(student) fallback stays for a hypothetical future
  // where a non-owner co-parent can also share.
  const canShare = isOwner(studentId) ? hasFamilyPack : studentHasFamilyPack(student);

  const handleShare = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    // Defense in depth — the form below isn't rendered when !canShare, so
    // this shouldn't be reachable, but never send a share write for a
    // student that isn't entitled to one.
    if (!canShare) return;

    if (!email.trim()) {
      setError('Please enter an email address');
      return;
    }

    if (!email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setLoading(true);
    try {
      await shareStudent(studentId, email.trim());
      setSuccess(
        `Shared with ${email}. They'll see it immediately if they already have an account, or get an email invitation to create one.`
      );
      setEmail('');
      setTimeout(() => {
        onShare?.();
        onClose();
      }, 2500);
    } catch (err) {
      setError(err.message || 'Failed to share student');
      console.error('Share error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Free-tier student: don't present a form that's guaranteed to fail on
  // submit. Point at the Account page's Family Pack section instead.
  if (!canShare) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
          <h3 style={{ fontSize: 18, marginBottom: 16 }}>Share {student.firstName}'s Profile</h3>
          <p style={{ fontSize: 14, color: 'var(--navy)' }}>
            Sharing a dashboard with another parent or supervisor is a Family Pack feature.
          </p>
          <button
            className="btn btn-primary"
            style={{ marginTop: 16, width: '100%' }}
            onClick={() => {
              onClose();
              navigate('/account');
            }}
          >
            Buy Family Pack
          </button>
          <button className="btn btn-outline" style={{ marginTop: 10, width: '100%' }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <h3 style={{ fontSize: 18, marginBottom: 16 }}>Share {student.firstName}'s Profile</h3>

        <form onSubmit={handleShare} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--navy)' }}>
              Recipient Email
            </label>
            <input
              type="email"
              placeholder="parent@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--line)',
                fontSize: 14,
                fontFamily: 'inherit',
                backgroundColor: 'var(--white)',
                color: 'var(--navy)',
              }}
            />
          </div>

          {error && <p style={{ color: '#EF4444', fontSize: 13, margin: '0' }}>{error}</p>}
          {success && <p style={{ color: '#10B981', fontSize: 13, margin: '0' }}>{success}</p>}

          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={onClose}
              disabled={loading}
              style={{ flex: 1 }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !email.trim()}
              style={{ flex: 1 }}
            >
              {loading ? 'Sharing...' : 'Share'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
