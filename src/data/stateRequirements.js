/**
 * Supervised driving requirements by state.
 * Source: IIHS Graduated Licensing Laws table (October 2026).
 * https://www.iihs.org/topics/teenagers/graduated-licensing-laws-table
 *
 * totalHours: minimum supervised behind-the-wheel hours in the learner stage.
 * nightHours: portion that must occur at night (0 = no night requirement).
 * note: caveats that should be surfaced to the parent where relevant.
 *
 * Laws change — verify with the state DMV before relying on these numbers,
 * and re-check this table periodically. scripts/check-iihs-requirements.js
 * (.github/workflows/check-iihs-requirements.yml, monthly) emails a diff
 * when IIHS's table no longer matches what's below, but does not edit this
 * file itself — a human reviews and edits it, same as the October 2026
 * update this was built for.
 *
 * STATE_REQUIREMENTS_SYNCED_AT (below) is shown to users (Terms of Use §4,
 * AddStudent) as "last synced," not "current as of" — it's a true claim
 * about when a human last checked this file against IIHS, not a claim that
 * today's data is current. UPDATE IT IN THE SAME COMMIT as any data change
 * above, or the displayed date becomes actively wrong rather than just
 * vague — worse than not showing a date at all.
 */
export const STATE_REQUIREMENTS_SYNCED_AT = 'October 2026';

export const STATE_REQUIREMENTS = {
  AL: { name: 'Alabama', totalHours: 50, nightHours: 0, note: 'Waived with driver education.' },
  AK: { name: 'Alaska', totalHours: 40, nightHours: 10, note: '10 hours must be at night or in inclement weather.' },
  AZ: { name: 'Arizona', totalHours: 30, nightHours: 10, note: 'Waived with driver education.' },
  AR: { name: 'Arkansas', totalHours: 0, nightHours: 0 },
  CA: { name: 'California', totalHours: 50, nightHours: 10 },
  CO: { name: 'Colorado', totalHours: 50, nightHours: 10 },
  CT: { name: 'Connecticut', totalHours: 40, nightHours: 0, note: 'Professional instruction hours count toward the 40.' },
  DE: { name: 'Delaware', totalHours: 50, nightHours: 10 },
  DC: { name: 'District of Columbia', totalHours: 40, nightHours: 10, note: '40 hours in learner stage; 10 night hours during intermediate stage.' },
  FL: { name: 'Florida', totalHours: 50, nightHours: 10 },
  GA: { name: 'Georgia', totalHours: 40, nightHours: 6 },
  HI: { name: 'Hawaii', totalHours: 50, nightHours: 10 },
  ID: { name: 'Idaho', totalHours: 50, nightHours: 10 },
  IL: { name: 'Illinois', totalHours: 50, nightHours: 10 },
  IN: { name: 'Indiana', totalHours: 50, nightHours: 10 },
  IA: { name: 'Iowa', totalHours: 20, nightHours: 2, note: 'An additional 10 hours (2 at night) are required during the intermediate stage.' },
  KS: { name: 'Kansas', totalHours: 50, nightHours: 10, note: '25 hours in learner phase, 25 more before age 16.' },
  KY: { name: 'Kentucky', totalHours: 60, nightHours: 10 },
  LA: { name: 'Louisiana', totalHours: 50, nightHours: 15 },
  ME: { name: 'Maine', totalHours: 70, nightHours: 10 },
  MD: { name: 'Maryland', totalHours: 60, nightHours: 10 },
  MA: { name: 'Massachusetts', totalHours: 40, nightHours: 0, note: '30 hours if a driver skills development program is completed.' },
  MI: { name: 'Michigan', totalHours: 50, nightHours: 10 },
  MN: { name: 'Minnesota', totalHours: 40, nightHours: 15 },
  MS: { name: 'Mississippi', totalHours: 0, nightHours: 0, note: 'No hours requirement, but the permit must be held at least 12 months (6 with an approved driver education course) before licensing.' },
  MO: { name: 'Missouri', totalHours: 40, nightHours: 10 },
  MT: { name: 'Montana', totalHours: 50, nightHours: 10, note: '75 hours (15 at night) if using the alternative online traffic education path.' },
  NE: { name: 'Nebraska', totalHours: 50, nightHours: 10, note: 'Waived with driver education.' },
  NV: { name: 'Nevada', totalHours: 50, nightHours: 10, note: 'Waived with a defensive driving course.' },
  NH: { name: 'New Hampshire', totalHours: 40, nightHours: 10 },
  NJ: { name: 'New Jersey', totalHours: 50, nightHours: 10 },
  NM: { name: 'New Mexico', totalHours: 50, nightHours: 10 },
  NY: { name: 'New York', totalHours: 50, nightHours: 15 },
  NC: { name: 'North Carolina', totalHours: 60, nightHours: 10, note: '+12 hours (6 at night) required for a full provisional license.' },
  ND: { name: 'North Dakota', totalHours: 50, nightHours: 0, note: 'Applies to permit holders under 16 (NDCC 39-06-05); no hour/log requirement at all if 16 or older.' },
  OH: { name: 'Ohio', totalHours: 50, nightHours: 10 },
  OK: { name: 'Oklahoma', totalHours: 50, nightHours: 10 },
  OR: { name: 'Oregon', totalHours: 50, nightHours: 0, note: '100 hours without driver education.' },
  PA: { name: 'Pennsylvania', totalHours: 65, nightHours: 10, note: '5 hours must be in inclement weather.' },
  RI: { name: 'Rhode Island', totalHours: 50, nightHours: 10 },
  SC: { name: 'South Carolina', totalHours: 40, nightHours: 10 },
  SD: { name: 'South Dakota', totalHours: 50, nightHours: 10, note: '10 hours must also be during inclement weather.' },
  TN: { name: 'Tennessee', totalHours: 50, nightHours: 10 },
  TX: { name: 'Texas', totalHours: 30, nightHours: 10 },
  UT: { name: 'Utah', totalHours: 40, nightHours: 10 },
  VT: { name: 'Vermont', totalHours: 40, nightHours: 10 },
  VA: { name: 'Virginia', totalHours: 45, nightHours: 15 },
  WA: { name: 'Washington', totalHours: 50, nightHours: 10 },
  WV: { name: 'West Virginia', totalHours: 50, nightHours: 10, note: 'Waived with driver education.' },
  WI: { name: 'Wisconsin', totalHours: 50, nightHours: 10 },
  WY: { name: 'Wyoming', totalHours: 50, nightHours: 10 },
};

export const STATE_LIST = Object.entries(STATE_REQUIREMENTS)
  .map(([code, s]) => ({ code, name: s.name }))
  .sort((a, b) => a.name.localeCompare(b.name));
