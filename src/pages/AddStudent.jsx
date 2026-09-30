import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { STATE_LIST, STATE_REQUIREMENTS } from '../data/stateRequirements';
import { FREE_STUDENT_LIMIT } from '../utils/entitlements';

export default function AddStudent() {
  const { addStudent, students, findExistingStudentByEmail, requestStudentAccess, isOwner, hasFamilyPack } = useApp();
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [duplicate, setDuplicate] = useState(null); // { entry, alreadyMine } | null
  const [requesting, setRequesting] = useState(false);
  const [requestSent, setRequestSent] = useState(false);

  const req = state ? STATE_REQUIREMENTS[state] : null;

  // Free-tier cap: one OWNED student. `students` mixes owned and
  // shared-with-me dashboards, so this counts only the former — a free
  // account that already has a dashboard shared with them by a Family Pack
  // household isn't blocked from adding their own single student by that.
  // Checked here rather than earlier in handleSave so both entry points
  // (normal submit, and "Create new" from the duplicate-dashboard modal)
  // go through the same gate.
  const ownedCount = students.filter((s) => isOwner(s.id)).length;
  const atFreeStudentLimit = !hasFamilyPack && ownedCount >= FREE_STUDENT_LIMIT;

  const createStudent = async () => {
    if (atFreeStudentLimit) {
      setError(
        'Free accounts are limited to one student driver. Buy Family Pack on your Account page to remove that limit.'
      );
      return;
    }
    const id = await addStudent({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), state });
    navigate(`/dashboard/${id}`);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    if (!firstName.trim() || !lastName.trim()) return setError("Please enter the student's first and last name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Please enter a valid email address.');
    if (!state) return setError("Please select the student's state of residence.");

    setChecking(true);
    try {
      const entry = await findExistingStudentByEmail(email.trim());
      if (entry) {
        const alreadyMine = students.some((s) => s.id === entry.studentId);
        setDuplicate({ entry, alreadyMine });
        return;
      }
    } catch (err) {
      console.error('Duplicate student check failed:', err);
      // Don't block adding a student just because the lookup failed.
    } finally {
      setChecking(false);
    }

    await createStudent();
  };

  const handleRequestAccess = async () => {
    setRequesting(true);
    try {
      await requestStudentAccess(duplicate.entry);
      setDuplicate(null);
      setRequestSent(true);
    } catch (err) {
      setError(err.message || 'Could not send the request.');
      setDuplicate(null);
    } finally {
      setRequesting(false);
    }
  };

  const handleCreateAnyway = async () => {
    setDuplicate(null);
    await createStudent();
  };

  if (requestSent) {
    return (
      <div className="page">
        <h2 style={{ fontSize: 20, marginBottom: 6 }}>Request sent</h2>
        <p style={{ color: 'var(--muted)' }}>
          {duplicate?.entry?.ownerName || "The dashboard's owner"} will see your request and can approve it from{' '}
          {firstName || "the student's"} dashboard. You'll get access as soon as they do.
        </p>
        <button className="btn btn-primary" style={{ marginTop: 24 }} onClick={() => navigate('/students')}>
          Back to students
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <h2 style={{ fontSize: 20, marginBottom: 6 }}>Add a student driver</h2>
      <form onSubmit={handleSave}>
        <div className="field">
          <label>First name</label>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="John" />
        </div>
        <div className="field">
          <label>Last name</label>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" />
        </div>
        <div className="field">
          <label>Student email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="student@example.com" />
        </div>
        <div className="field">
          <label>State of residence</label>
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Select a state…</option>
            {STATE_LIST.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </div>

        {req && (
          <div className="req-note">
            {req.totalHours > 0 ? (
              <>
                <div className="req-title">
                  {req.name} requires {req.totalHours} supervised hours
                  {req.nightHours > 0 ? `, ${req.nightHours} at night` : ''}.*
                </div>
                {req.note && <div className="req-sub">{req.note}</div>}
              </>
            ) : (
              <div className="req-title">
                {req.name} does not require a minimum number of supervised driving hours.*
              </div>
            )}
          </div>
        )}

        {error && <p style={{ color: '#D8503F', fontSize: 13, marginTop: 14 }}>{error}</p>}

        <button type="submit" className="btn btn-primary" style={{ marginTop: 24 }} disabled={checking}>
          {checking ? 'Checking…' : 'Add student'}
        </button>
      </form>

      {req && (
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 20 }}>
          * Requirements sourced from the{' '}
          <a
            href="https://www.iihs.org/research-areas/teenagers/graduated-licensing-laws-table"
            target="_blank"
            rel="noopener noreferrer"
          >
            IIHS Graduated Licensing Laws table
          </a>
          . Laws change — verify with your state DMV.
        </p>
      )}

      {duplicate && (
        <div className="modal-backdrop" onClick={() => !requesting && setDuplicate(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            {duplicate.alreadyMine ? (
              <>
                <div className="modal-text">You already have access to {duplicate.entry.firstName}'s dashboard.</div>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 20 }}
                  onClick={() => navigate(`/dashboard/${duplicate.entry.studentId}`)}
                >
                  Go to dashboard
                </button>
              </>
            ) : (
              <>
                <div className="modal-text">
                  A dashboard for {duplicate.entry.firstName} already exists, owned by {duplicate.entry.ownerName || 'another parent'}.
                  Would you like to request access instead of creating a new one?
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
                  <button className="btn btn-outline" style={{ flex: 1 }} onClick={handleCreateAnyway} disabled={requesting}>
                    Create new
                  </button>
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleRequestAccess} disabled={requesting}>
                    {requesting ? 'Sending…' : 'Request access'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
