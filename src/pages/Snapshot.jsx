import React from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import Gauge from '../components/Gauge';
import { decodeSnapshotParam } from '../utils/snapshot';

const DRIVE_TYPE_LABELS = { local: 'Local', rural: 'Rural', highway: 'Highway' };

function fmtDuration(mins) {
  return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
}

function DashboardSnapshot({ d }) {
  return (
    <>
      <h2 style={{ fontSize: 22, marginBottom: 4 }}>{d.name}'s Progress</h2>
      <p style={{ color: 'var(--muted)', marginBottom: 22 }}>{d.req}</p>
      <div className="dash-panel">
        <Gauge label="Total hours" value={d.tm} goal={d.tg} color="#2F6FDE" />
        {d.ng > 0 && <Gauge label="Night hours" value={d.nm} goal={d.ng} color="#6C5CE7" />}
      </div>
    </>
  );
}

// Renders only non-location fields. Links shared before snapshots stopped
// carrying coordinates still have s/e/r sitting in the URL — those can't be
// recalled, but this page will no longer draw a map from them, so an old
// link stops displaying where the drive went.
function LogSnapshot({ d }) {
  return (
    <>
      <h2 style={{ fontSize: 22, marginBottom: 4 }}>{d.name}'s Drive</h2>
      <p style={{ color: 'var(--muted)', marginBottom: 22 }}>{d.date}</p>

      <div className="ledger-row" style={{ cursor: 'default', width: '100%' }}>
        <div>
          <div className="date">{DRIVE_TYPE_LABELS[d.type] ?? d.type} · {d.tod === 'night' ? 'Night' : 'Day'}</div>
          <div className="meta">{d.dist != null ? `${d.dist} mi` : 'Distance not recorded'}</div>
        </div>
        <div className="duration mono">{fmtDuration(d.dur)}</div>
      </div>
    </>
  );
}

export default function Snapshot() {
  const [searchParams] = useSearchParams();
  const snapshot = decodeSnapshotParam(searchParams.get('d'));

  return (
    <div className="page snapshot-page">
      <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Student Drive Log" className="snapshot-logo" />

      {!snapshot ? (
        <p style={{ color: 'var(--muted)' }}>This shared link is invalid or has expired.</p>
      ) : snapshot.t === 'dashboard' ? (
        <DashboardSnapshot d={snapshot.d} />
      ) : snapshot.t === 'log' ? (
        <LogSnapshot d={snapshot.d} />
      ) : (
        <p style={{ color: 'var(--muted)' }}>This shared link is invalid or has expired.</p>
      )}

      <p className="snapshot-badge">Shared snapshot · view only</p>
      <Link to="/" className="btn btn-outline" style={{ marginTop: 24, textDecoration: 'none' }}>
        Track your own learner's drives
      </Link>
    </div>
  );
}
