import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { STATE_REQUIREMENTS } from '../data/stateRequirements';
import { FREE_STUDENT_LIMIT } from '../utils/entitlements';

// Whole hours, rounded to one decimal — enough to see progress at a glance
// without the card turning into a second dashboard.
const fmtHours = (minutes) => (minutes / 60).toFixed(1);

function StudentCard({ student, totals, shared }) {
  const navigate = useNavigate();
  const req = STATE_REQUIREMENTS[student.state];
  const goalHours = req?.totalHours ?? 0;
  const doneHours = fmtHours(totals.totalMinutes);
  const open = () => navigate(`/dashboard/${student.id}`);

  // Locked students (set by functions/src/entitlementFanout.js when an
  // over-the-free-limit account's Family Pack refund is approved) still
  // navigate to their dashboard — existing history is still readable, only
  // new logs are blocked (firestore.rules) — so this is purely the same
  // "can't act on this without Family Pack" visual the + Add button below
  // already uses, not a disabled card.
  const grayedOut = shared ? { opacity: 0.8 } : student.locked ? { opacity: 0.5 } : null;

  return (
    <div
      className="plate-card"
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      style={{ cursor: 'pointer', ...grayedOut }}
    >
      <div>
        <div className="name">{student.firstName} {student.lastName}</div>
        <div className="sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{req?.name}</span>
          {shared && (
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
              • Shared{student.ownerName ? ` by ${student.ownerName}` : ''}
            </span>
          )}
          {student.locked && (
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
              • Locked — buy Family Pack to log new drives
            </span>
          )}
        </div>
        <div className="sub mono" style={{ marginTop: 6, color: 'var(--navy)' }}>
          {goalHours > 0 ? (
            <>
              {doneHours} <span style={{ color: 'var(--muted)' }}>of {goalHours} hrs</span>
            </>
          ) : (
            // Some states set no minimum, so there's no total to count toward.
            <>
              {doneHours} <span style={{ color: 'var(--muted)' }}>hrs · no state minimum</span>
            </>
          )}
        </div>
      </div>
      <div className="plate-badge">{student.state}</div>
    </div>
  );
}

export default function Students() {
  const { students, isOwner, getTotals, hasFamilyPack } = useApp();
  const navigate = useNavigate();

  const owned = students.filter((s) => isOwner(s.id));
  const shared = students.filter((s) => !isOwner(s.id));
  // Same rule AddStudent.jsx enforces on submit — surfaced here too so a
  // free account sees why the button won't do anything before they click
  // it, rather than clicking through to a form that just rejects them.
  const atFreeStudentLimit = !hasFamilyPack && owned.length >= FREE_STUDENT_LIMIT;

  return (
    <div className="page">
      <h2 style={{ fontSize: 22, marginBottom: 18 }}>Your student drivers</h2>

      {students.length === 0 ? (
        <div className="empty-state">No student drivers yet. Add one to start logging hours.</div>
      ) : (
        <div>
          {owned.map((s) => (
            <StudentCard key={s.id} student={s} totals={getTotals(s.id)} />
          ))}

          {shared.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, color: 'var(--muted)', marginTop: 24, marginBottom: 12 }}>Shared with you</h3>
              {shared.map((s) => (
                <StudentCard key={s.id} student={s} totals={getTotals(s.id)} shared />
              ))}
            </>
          )}
        </div>
      )}

      <button
        className="btn btn-primary"
        style={{ marginTop: 12 }}
        onClick={() => navigate('/add-student')}
        disabled={atFreeStudentLimit}
      >
        + Add a student driver
      </button>
      {atFreeStudentLimit && (
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
          Free accounts are limited to one student driver.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); navigate('/account'); }}>
            Buy Family Pack
          </a>{' '}
          to add more.
        </p>
      )}
    </div>
  );
}
