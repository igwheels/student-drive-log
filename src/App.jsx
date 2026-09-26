import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useApp } from './context/AppContext';
import Login from './pages/Login';
import Students from './pages/Students';
import AddStudent from './pages/AddStudent';
import Dashboard from './pages/Dashboard';
import DriveTimer from './pages/DriveTimer';
import LogDrive from './pages/LogDrive';
import Account from './pages/Account';
import ManageStudents from './pages/ManageStudents';
import Snapshot from './pages/Snapshot';
import Unsubscribe from './pages/Unsubscribe';
import TermsOfUse from './pages/TermsOfUse';
import PrivacyPolicy from './pages/PrivacyPolicy';
import ShareButton from './components/ShareButton';
import BiometricLockScreen from './components/BiometricLockScreen';
import BiometricEnrollPrompt from './components/BiometricEnrollPrompt';
import { STATE_REQUIREMENTS } from './data/stateRequirements';
import { buildDashboardSnapshotUrl } from './utils/snapshot';

// Copyright year: just the launch year during that year, a range afterwards
// ("2026", then "2026–2027", …). Computed once at module load rather than per
// render — the only cost is that a session left open across New Year's shows
// the old year until reload. The `>` guard means a device clock set before
// 2026 falls back to the launch year instead of printing a backwards range.
const COPYRIGHT_START_YEAR = 2026;
const currentYear = new Date().getFullYear();
const COPYRIGHT_YEARS =
  currentYear > COPYRIGHT_START_YEAR ? `${COPYRIGHT_START_YEAR}–${currentYear}` : `${COPYRIGHT_START_YEAR}`;

const TITLES = {
  '/students': 'Student Drivers',
  '/add-student': 'Add Student Driver',
  '/account': 'Account',
  '/manage-students': 'Manage Students',
};

function RequireAuth({ children }) {
  const { user, hydrated, authChecked } = useApp();
  if (!hydrated || !authChecked) return null;
  if (!user) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    logout, students, getTotals, user,
    biometricLocked, dismissBiometricLock,
    biometricEnrollLabel, dismissBiometricEnrollPrompt,
  } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);

  const isLogin = location.pathname === '/';
  const isTimer = location.pathname.startsWith('/drive-timer');
  const isSnapshot = location.pathname.startsWith('/snapshot');
  const isUnsubscribe = location.pathname.startsWith('/unsubscribe');
  const isLegalPage = location.pathname === '/terms' || location.pathname === '/privacy';
  const showTopbar = !isLogin && !isTimer && !isSnapshot && !isUnsubscribe && !isLegalPage;
  const isDashboard = location.pathname.startsWith('/dashboard');
  const title = TITLES[location.pathname] ||
    (isDashboard ? 'Dashboard'
    : location.pathname.startsWith('/log-drive') ? 'Log a Drive' : 'Student Drive Log');

  // On a student's dashboard, share a read-only snapshot of their progress
  // instead of the app's own link.
  const dashboardStudentId = isDashboard ? location.pathname.split('/')[2] : null;
  const dashboardStudent = dashboardStudentId ? students.find((s) => s.id === dashboardStudentId) : null;
  let shareProps = { title };
  if (dashboardStudent) {
    const req = STATE_REQUIREMENTS[dashboardStudent.state];
    const { totalMinutes, nightMinutes } = getTotals(dashboardStudentId);
    shareProps = {
      title: `${dashboardStudent.firstName}'s progress`,
      text: `Check out ${dashboardStudent.firstName}'s progress…`,
      url: buildDashboardSnapshotUrl({
        studentFirstName: dashboardStudent.firstName,
        requirementName: req.name,
        totalMinutes,
        totalGoalMinutes: req.totalHours * 60,
        nightMinutes,
        nightGoalMinutes: req.nightHours * 60,
      }),
    };
  }

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    navigate('/');
  };

  const handleAccount = () => {
    setMenuOpen(false);
    navigate('/account');
  };

  const handleManageStudents = () => {
    setMenuOpen(false);
    navigate('/manage-students');
  };

  return (
    <div className="app-shell">
      {showTopbar && (
        <div className="topbar">
          {location.pathname !== '/students' && (
            <button className="back" onClick={() => navigate(-1)}>‹ Back</button>
          )}
          <button
            className="logo-btn"
            onClick={() => navigate('/students')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            title="Go to home"
          >
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Student Drive Log" />
          </button>
          <span className="title">{title}</span>
          <div style={{ flex: 1 }} />
          <ShareButton {...shareProps} />
          <div className="menu-wrapper">
            <button className="menu-btn" onClick={() => setMenuOpen((v) => !v)} title="Menu">
              ☰
            </button>
            {menuOpen && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                  onClick={() => setMenuOpen(false)}
                />
                <div className="menu-dropdown">
                  <button onClick={handleAccount}>Account</button>
                  <button onClick={handleManageStudents}>Manage students</button>
                  <button onClick={handleLogout}>Log out</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/snapshot" element={<Snapshot />} />
        <Route path="/unsubscribe" element={<Unsubscribe />} />
        <Route path="/students" element={<RequireAuth><Students /></RequireAuth>} />
        <Route path="/add-student" element={<RequireAuth><AddStudent /></RequireAuth>} />
        <Route path="/dashboard/:studentId" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/drive-timer/:studentId" element={<RequireAuth><DriveTimer /></RequireAuth>} />
        <Route path="/log-drive/:studentId" element={<RequireAuth><LogDrive /></RequireAuth>} />
        <Route path="/log-drive/:studentId/:logId" element={<RequireAuth><LogDrive /></RequireAuth>} />
        <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
        <Route path="/manage-students" element={<RequireAuth><ManageStudents /></RequireAuth>} />
        <Route path="/terms" element={<TermsOfUse />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
      </Routes>

      <div className="app-footer">
        <span>
          © {COPYRIGHT_YEARS}{' '}
          <a href="https://www.devworksllc.com" target="_blank" rel="noopener noreferrer">
            DevWorks LLC
          </a>
          . All rights reserved.
        </span>
        <div className="footer-links">
          <button onClick={() => navigate('/terms')}>Terms of Use</button>
          <button onClick={() => navigate('/privacy')}>Privacy Policy</button>
        </div>
      </div>

      {/* Overlays, not routes — rendered on top of whatever page is
          current so neither one tears down in-progress state (a running
          drive timer, an open form) underneath it. See DEV-28. */}
      {biometricLocked && <BiometricLockScreen onUnlock={dismissBiometricLock} />}
      {biometricEnrollLabel && user?.id && (
        <BiometricEnrollPrompt uid={user.id} label={biometricEnrollLabel} onDone={dismissBiometricEnrollPrompt} />
      )}
    </div>
  );
}
