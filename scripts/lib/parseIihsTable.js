// Parses IIHS's Graduated Licensing Laws table HTML into the same
// { totalHours, nightHours } shape as src/data/stateRequirements.js.
// Pure function, no network/Firestore/email — so it can run identically in
// the monthly check script (scripts/check-iihs-requirements.js) and in a
// test, against either a live fetch or a saved fixture.
//
// Dev-tooling only. Deliberately NOT under src/ — this pulls in cheerio
// (an HTML parser with no reason to ever ship in the app bundle) and never
// runs on a user's device; only scripts/check-iihs-requirements.js (run by
// .github/workflows/check-iihs-requirements.yml) imports it.
import * as cheerio from 'cheerio';

// The learner-stage "Minimum amount of supervised driving" column is free
// text, not structured data — IIHS writes it for a human reader, not a
// machine. Most states fit one of two patterns below; a handful don't and
// are hand-decoded instead (see SPECIAL_CASES). Confirmed against the
// October 2026 table — if IIHS rephrases a row in some future update in a
// way neither the patterns nor SPECIAL_CASES expect, parseIihsTable throws
// rather than silently guessing, and the caller treats that as "needs a
// human look," not "no changes."
const PATTERN_WITH_NIGHT =
  /^(\d+)\s*hours?,\s*(\d+)\s*of which must be at night(?:\s+or\s+in\s+inclement\s+weather)?(?:\s+and\s+(\d+)\s+of which must be (?:in|during) inclement weather)?(?:\s*\(none with ([^)]+)\))?$/i;
const PATTERN_SIMPLE = /^(\d+)\s*hours?(?:\s*\(none with ([^)]+)\))?$/i;

// States whose learner-stage text doesn't reduce to a single
// totalHours/nightHours pair without editorializing (a split by age, a
// cross-reference to a different stage, etc.) — same reasoning
// src/data/stateRequirements.js's hand-written notes already use for these
// exact states. Only the numbers matter for diffing; the prose notes stay
// hand-maintained in stateRequirements.js and are never generated here.
const SPECIAL_CASES = {
  DC: { totalHours: 40, nightHours: 10 }, // "40 hours in learner's stage; 10 hours at night in intermediate stage"
  KS: { totalHours: 50, nightHours: 10 }, // "25 hours in learner phase; 25 hours before age 16; 10 of the 50 hours must be at night"
  ND: { totalHours: 50, nightHours: 0 }, // "<16: 50 hours; >=16: none" — no night sub-requirement in this column at all
  OR: { totalHours: 50, nightHours: 0 }, // "50 hours (100 hours without driver education)"
  AR: { totalHours: 0, nightHours: 0 }, // "none"
  MS: { totalHours: 0, nightHours: 0 }, // "none" — permit-holding-period requirement instead, not an hours one
};

/**
 * @param {string} html - the raw HTML of
 *   https://www.iihs.org/topics/teenagers/graduated-licensing-laws-table
 * @returns {Record<string, {totalHours: number, nightHours: number}>} keyed
 *   by two-letter state code (plus DC)
 */
export function parseIihsTable(html) {
  const $ = cheerio.load(html);
  const table = $('table').first();
  if (!table.length) {
    throw new Error('parseIihsTable: no <table> found on the page — layout may have changed.');
  }

  const rows = table.find('tr').toArray();
  // Row 0: stage group headers ("Learner stage" / "Intermediate stage" / ...).
  // Row 1: column headers ("State", "Minimum entry age", ...).
  // Row 2+: one row per state/DC.
  const dataRows = rows.slice(2);
  if (dataRows.length < 50) {
    throw new Error(
      `parseIihsTable: expected ~51 state rows, found ${dataRows.length} — layout may have changed.`
    );
  }

  const result = {};
  for (const row of dataRows) {
    const cells = $(row)
      .find('th,td')
      .toArray()
      .map((c) => $(c).text().replace(/\s+/g, ' ').trim());
    const code = cells[0];
    const supervisedHoursRaw = cells[3];
    if (!code || supervisedHoursRaw == null) {
      throw new Error(`parseIihsTable: row missing expected cells: ${JSON.stringify(cells)}`);
    }

    if (SPECIAL_CASES[code]) {
      result[code] = SPECIAL_CASES[code];
      continue;
    }

    // Footnote markers ("Footnote 38") are inline superscript text in this
    // rendering — strip them before matching.
    const text = supervisedHoursRaw.replace(/\s*Footnote\s*\d+\s*,?/gi, '').trim();

    if (text.toLowerCase() === 'none') {
      result[code] = { totalHours: 0, nightHours: 0 };
      continue;
    }

    const withNight = PATTERN_WITH_NIGHT.exec(text);
    if (withNight) {
      result[code] = { totalHours: Number(withNight[1]), nightHours: Number(withNight[2]) };
      continue;
    }

    const simple = PATTERN_SIMPLE.exec(text);
    if (simple) {
      result[code] = { totalHours: Number(simple[1]), nightHours: 0 };
      continue;
    }

    throw new Error(
      `parseIihsTable: unrecognized supervised-hours format for ${code}: "${text}" — ` +
        'add it to SPECIAL_CASES once a human has read the actual table row.'
    );
  }

  const expectedCount = 51; // 50 states + DC
  if (Object.keys(result).length !== expectedCount) {
    throw new Error(
      `parseIihsTable: parsed ${Object.keys(result).length} rows, expected ${expectedCount}.`
    );
  }

  return result;
}
