import React, { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { getWeeklyEmailOptOut, setWeeklyEmailOptOut } from '../utils/emailPreferences';

export default function Unsubscribe() {
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email')?.trim().toLowerCase() || '';
  const [status, setStatus] = useState('loading'); // loading | subscribed | unsubscribed | error
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!email) {
      setStatus('error');
      return;
    }
    getWeeklyEmailOptOut(email)
      .then((optedOut) => setStatus(optedOut ? 'unsubscribed' : 'subscribed'))
      .catch(() => setStatus('error'));
  }, [email]);

  const handleUnsubscribe = async () => {
    setWorking(true);
    try {
      await setWeeklyEmailOptOut(email, true);
      setStatus('unsubscribed');
    } catch {
      setStatus('error');
    } finally {
      setWorking(false);
    }
  };

  const handleResubscribe = async () => {
    setWorking(true);
    try {
      await setWeeklyEmailOptOut(email, false);
      setStatus('subscribed');
    } catch {
      setStatus('error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="page snapshot-page">
      <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Student Drive Log" className="snapshot-logo" />
      <h2 style={{ fontSize: 20, marginBottom: 12 }}>Weekly progress emails</h2>

      {status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}

      {status === 'error' && (
        <p style={{ color: 'var(--muted)' }}>This unsubscribe link is invalid.</p>
      )}

      {status === 'subscribed' && (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 20 }}>
            <strong>{email}</strong> is currently subscribed to weekly progress emails.
          </p>
          <button className="btn btn-primary" onClick={handleUnsubscribe} disabled={working}>
            {working ? 'Unsubscribing…' : 'Unsubscribe'}
          </button>
        </>
      )}

      {status === 'unsubscribed' && (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 20 }}>
            <strong>{email}</strong> has been unsubscribed from weekly progress emails.
          </p>
          <button className="btn btn-outline" onClick={handleResubscribe} disabled={working}>
            {working ? 'Resubscribing…' : 'Resubscribe'}
          </button>
        </>
      )}

      <Link to="/" className="btn btn-ghost" style={{ marginTop: 24, textDecoration: 'none' }}>
        Back to Student Drive Log
      </Link>
    </div>
  );
}
