import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { STATE_REQUIREMENTS } from '../data/stateRequirements';
import Gauge from '../components/Gauge';
import ShareModal from '../components/ShareModal';
import DriveMap from '../components/DriveMap';
import { exportAffidavitPdf } from '../utils/pdfExport';
import { exportDrivesCsv } from '../utils/csvExport';
import { hasStateForm, stateFormLabel, exportFilledStateForm } from '../utils/stateFormFill';
import { readActiveDrive, clearActiveDrive } from '../utils/activeDrive';
import { savePendingDrive } from '../utils/pendingDrive';

export default function Dashboard() {
  const { studentId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { students, getLogs, getTotals, user, isOwner, unshareStudent, getPendingRequests, approveRequest, denyRequest } = useApp();
  const student = students.find((s) => s.id === studentId);
  const [celebration, setCelebration] = useState(location.state?.celebrate ?? null);
  const [showAllDrives, setShowAllDrives] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [sharedUsers, setSharedUsers] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [pendingActionId, setPendingActionId] = useState(null);
  const [formStatus, setFormStatus] = useState('');

  // A drive whose app was killed mid-timing left a checkpoint (see
  // utils/activeDrive.js). Offer to resume it, save what was recorded, or
  // discard it.
  const [activeDrive, setActiveDrive] = useState(null);
  useEffect(() => {
    const cp = readActiveDrive();
    setActiveDrive(cp && cp.studentId === studentId ? cp : null);
  }, [studentId]);

  const resumeActiveDrive = () => navigate(`/drive-timer/${studentId}?resume=1`);

  const discardActiveDrive = () => {
    clearActiveDrive();
    setActiveDrive(null);
  };

  const saveActiveDrivePartial = () => {
    const cp = activeDrive;
    if (!cp) return;
    const prefill = {
      startTime: cp.startTime,
      // The last checkpoint is the closest we have to when tracking stopped.
      endTime: new Date(cp.savedAt).toISOString(),
      startOffsetMinutes: cp.startOffsetMinutes,
      distanceMiles: cp.miles > 0 ? Number(cp.miles.toFixed(1)) : null,
      maxSpeedMph: cp.maxSpeedMph != null ? Math.round(cp.maxSpeedMph) : null,
      safetyEventCounts:
        cp.safetyEventCounts && (cp.safetyEventCounts.hardBrake || cp.safetyEventCounts.harshTurn)
          ? cp.safetyEventCounts
          : null,
      startLocation: cp.start ?? null,
      endLocation: cp.end ?? null,
      route: cp.route && cp.route.length > 1 ? cp.route : null,
    };
    savePendingDrive(studentId, prefill);
    clearActiveDrive();
    setActiveDrive(null);
    navigate(`/log-drive/${studentId}?pending=1`, { state: { prefill } });
  };

  // Update shared users when student changes
  useEffect(() => {
    if (student) {
      setSharedUsers(student.sharedWith || []);
    }
  }, [student?.id]);


  const refreshPendingRequests = () => {
    if (!isOwner(studentId)) return;
    getPendingRequests(studentId)
      .then(setPendingRequests)
      .catch((e) => console.error('Failed to load pending access requests:', e));
  };

  useEffect(() => {
    refreshPendingRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, student?.ownerId]);

  const handleUnshare = async (email) => {
    try {
      await unshareStudent(studentId, email);
      setSharedUsers((prev) => prev.filter((u) => u.email !== email));
    } catch (e) {
      console.error('Failed to unshare:', e);
    }
  };

  const handleApproveRequest = async (request) => {
    setPendingActionId(request.id);
    try {
      await approveRequest(request);
      setPendingRequests((prev) => prev.filter((r) => r.id !== request.id));
      setSharedUsers((prev) => [...prev, { email: request.requesterEmail, addedAt: new Date().toISOString() }]);
    } catch (e) {
      console.error('Failed to approve request:', e);
    } finally {
      setPendingActionId(null);
    }
  };

  const handleDenyRequest = async (request) => {
    setPendingActionId(request.id);
    try {
      await denyRequest(request.id);
      setPendingRequests((prev) => prev.filter((r) => r.id !== request.id));
    } catch (e) {
      console.error('Failed to deny request:', e);
    } finally {
      setPendingActionId(null);
    }
  };

  if (!student) return <div className="page">Student not found.</div>;

  const req = STATE_REQUIREMENTS[student.state];
  const { totalMinutes, nightMinutes } = getTotals(studentId);
  const logs = getLogs(studentId);
  const hasRequirement = req.totalHours > 0;

  const fmtDuration = (mins) => `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;

  // One button, whichever document this state actually needs. Where the app
  // carries the state's own official form, that is what the parent wants —
  // the generic affidavit would only be a second-best copy of it. Everywhere
  // else the generic affidavit is the document.
  const buildGenericAffidavit = () =>
    exportAffidavitPdf({
      student,
      req,
      logs,
      totals: { totalMinutes, nightMinutes },
      parentName: user?.name ?? '',
    });

  const handleDmvForm = async () => {
    setFormStatus('');
    if (!hasStateForm(student.state)) {
      buildGenericAffidavit();
      return;
    }
    try {
      const { omittedCount } = await exportFilledStateForm({
        student,
        parentName: user?.name ?? '',
        logs,
        totals: { totalMinutes, nightMinutes },
      });
      setFormStatus(
        `${stateFormLabel(student.state)} downloaded. Add anything the app can't know, then sign it by hand.` +
          (omittedCount > 0
            ? ` The form only has room for its most recent drives, so ${omittedCount} earlier ` +
              `${omittedCount === 1 ? 'drive was' : 'drives were'} left off — download driving logs (CSV) for the complete record.`
            : '')
      );
    } catch (e) {
      // The official form is the right document, so failing to produce it is
      // worth saying out loud rather than quietly handing over a different
      // one — but a general affidavit still beats nothing.
      buildGenericAffidavit();
      setFormStatus(
        `Could not load ${stateFormLabel(student.state)} (${e.message}). ` +
          'Downloaded the general affidavit instead — check it against your state’s own form.'
      );
    }
  };

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <h2 style={{ fontSize: 24, margin: 0 }}>{student.firstName}'s Dashboard</h2>
        {!isOwner(studentId) && (
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--navy)',
            backgroundColor: 'var(--line)',
            padding: '4px 8px',
            borderRadius: 4,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}>
            Shared{student.ownerName ? ` by ${student.ownerName}` : ''}
          </span>
        )}
      </div>
      <p style={{ color: 'var(--muted)', marginTop: 2, marginBottom: 22 }}>{req.name}</p>

      {hasRequirement ? (
        <div className="dash-panel">
          <Gauge label="Total hours" value={totalMinutes} goal={req.totalHours * 60} color="#2F6FDE" />
          {req.nightHours > 0 && (
            <Gauge label="Night hours" value={nightMinutes} goal={req.nightHours * 60} color="#6C5CE7" />
          )}
        </div>
      ) : (
        <div className="no-req-card">
          Your state of residence does not require a minimum number of supervised driving hours.
          Way to go above and beyond!
        </div>
      )}

      {activeDrive && (
        <div
          style={{
            marginTop: 24,
            padding: '14px 16px',
            backgroundColor: '#FFF7E6',
            border: '1px solid var(--line)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            Unfinished drive from{' '}
            {new Date(activeDrive.startTime).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' }}>
            {activeDrive.miles > 0 ? `${activeDrive.miles.toFixed(1)} mi recorded before ` : 'Recorded before '}
            the app closed. Pick up where it left off, save what was recorded, or discard it.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn-primary" style={{ flex: '1 1 auto' }} onClick={resumeActiveDrive}>
              Resume timing
            </button>
            <button className="btn btn-dark" style={{ flex: '1 1 auto' }} onClick={saveActiveDrivePartial}>
              Save what we recorded
            </button>
            <button className="btn btn-outline" style={{ flex: '1 1 auto' }} onClick={discardActiveDrive}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button
          className="btn btn-primary"
          disabled={student.locked}
          onClick={() => navigate(`/drive-timer/${studentId}`)}
        >
          Start a Drive
        </button>
        <button
          className="btn btn-dark"
          disabled={student.locked}
          onClick={() => navigate(`/log-drive/${studentId}`)}
        >
          Log a Drive
        </button>
        {student.locked && (
          <p style={{ color: 'var(--muted)', fontSize: 12, margin: '-4px 0 0' }}>
            This student is locked — buy Family Pack on your{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); navigate('/account'); }}>
              Account page
            </a>{' '}
            to log new drives. Existing history below is still visible.
          </p>
        )}
        <button
          className="btn btn-outline"
          disabled={logs.length === 0}
          onClick={() => exportDrivesCsv({ student, logs })}
        >
          Download Driving Logs
        </button>
        <button className="btn btn-outline" disabled={logs.length === 0} onClick={handleDmvForm}>
          Form for DMV
        </button>
        {formStatus && (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{formStatus}</p>
        )}
        {isOwner(studentId) && (
          <button className="btn btn-ghost" onClick={() => setShowShareModal(true)}>
            Share
          </button>
        )}
      </div>

      {isOwner(studentId) && pendingRequests.length > 0 && (
        <div style={{ marginTop: 24, padding: 16, backgroundColor: 'var(--white)', border: '1px solid var(--line)', borderRadius: 8 }}>
          <h4 style={{ fontSize: 14, fontWeight: 600, marginTop: 0, marginBottom: 12 }}>Pending access requests</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingRequests.map((request) => (
              <div
                key={request.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  backgroundColor: '#FFF7E6',
                  borderRadius: 6,
                  fontSize: 14,
                  gap: 12,
                }}
              >
                <div>
                  <div>{request.requesterName || request.requesterEmail}</div>
                  {request.requesterName && (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{request.requesterEmail}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button
                    onClick={() => handleDenyRequest(request)}
                    disabled={pendingActionId === request.id}
                    style={{
                      background: 'none',
                      border: '1px solid var(--line)',
                      borderRadius: 6,
                      padding: '6px 10px',
                      color: 'var(--muted)',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    Deny
                  </button>
                  <button
                    onClick={() => handleApproveRequest(request)}
                    disabled={pendingActionId === request.id}
                    style={{
                      background: 'var(--success)',
                      border: 'none',
                      borderRadius: 6,
                      padding: '6px 10px',
                      color: 'var(--white)',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    Approve
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOwner(studentId) && sharedUsers.length > 0 && (
        <div style={{ marginTop: 24, padding: 16, backgroundColor: 'var(--white)', border: '1px solid var(--line)', borderRadius: 8 }}>
          <h4 style={{ fontSize: 14, fontWeight: 600, marginTop: 0, marginBottom: 12 }}>Shared with</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sharedUsers.map((share) => (
              <div
                key={share.email}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  backgroundColor: 'var(--off-white)',
                  borderRadius: 6,
                  fontSize: 14,
                }}
              >
                <span>{share.email}</span>
                <button
                  onClick={() => handleUnshare(share.email)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontSize: 13,
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 17, marginTop: 30, marginBottom: 10 }}>Recent drives</h3>
      {logs.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No drives logged yet. Start one above!</p>
      ) : (
        <>
          <div className="ledger">
            {logs.slice(0, showAllDrives ? logs.length : 5).map((l) => (
              <div
                key={l.id}
                className="ledger-row"
                onClick={() => navigate(`/log-drive/${studentId}/${l.id}`)}
                style={{ cursor: 'pointer' }}
              >
                <div className="ledger-row-main">
                  <div>
                    <div className="date">{l.date}</div>
                    <div className="meta">{l.type} · {l.timeOfDay}{l.distanceMiles != null ? ` · ${l.distanceMiles} mi` : ''}{l.maxSpeedMph != null ? ` · top ${l.maxSpeedMph} mph` : ''}</div>
                  </div>
                  <div className="duration mono">{fmtDuration(l.durationMinutes)}</div>
                </div>
                {l.startLocation && l.endLocation && (
                  <DriveMap start={l.startLocation} end={l.endLocation} route={l.route} />
                )}
              </div>
            ))}
          </div>
          {!showAllDrives && logs.length > 5 && (
            <button
              onClick={() => setShowAllDrives(true)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--muted)',
                fontSize: 14,
                marginTop: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                gap: 8,
              }}
            >
              Show all
              <span style={{ fontSize: 16 }}>↓</span>
            </button>
          )}
        </>
      )}

      {celebration && (
        <div className="modal-backdrop" onClick={() => setCelebration(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-emoji">🎉</div>
            <div className="modal-text">{celebration}</div>
            <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => setCelebration(null)}>
              Keep going!
            </button>
          </div>
        </div>
      )}

      {showShareModal && (
        <ShareModal
          studentId={studentId}
          student={student}
          onClose={() => setShowShareModal(false)}
          onShare={() => {
            // Refresh shared users
            const updatedStudent = students.find((s) => s.id === studentId);
            if (updatedStudent) {
              setSharedUsers(updatedStudent.sharedWith || []);
            }
          }}
        />
      )}
    </div>
  );
}
