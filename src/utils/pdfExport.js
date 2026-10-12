import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { localOffsetMinutes, toZonedTimeInput } from './driveTime';
import { downloadFileName } from './fileName';
import { saveOrShareBlob } from './saveFile';
import { affidavitRulesFor } from '../data/stateAffidavits';

/**
 * Generates a notarization-ready affidavit of supervised driving.
 *
 * Page 1 stands alone: a summary of the hours, the attestation, signature
 * blocks, and a blank notary block. A notary or DMV clerk verifying a number
 * should not have to read a table to do it, and the page a notary signs
 * should be the page the figures are on.
 *
 * The itemized log follows as an attachment, so the affidavit is still backed
 * by the underlying record — the CSV export covers the case where the data is
 * wanted in a spreadsheet instead.
 *
 * LAYOUT CONSTRAINTS, all deliberate:
 *  - US Letter, 1in margins. These get photocopied and scanned.
 *  - Black text on white throughout, no fills or shaded table rows: colour
 *    fills reproduce badly and can render text unreadable on a fax or a
 *    monochrome copier.
 *  - Nothing below 9pt, body at 11pt.
 *  - A 2in blank bordered square for the notary's seal. Embossed and ink
 *    stamps need clear space and cannot overlap text.
 *
 * ON STATE VARIATION: the document adapts to the state (see
 * data/stateAffidavits.js) but is never presented as that state's official
 * form. Where a state mandates a numbered form, page one names it, links the
 * state's own copy, and says plainly that this does not replace it; the
 * notary guidance and the disclaimer likewise carry what is known about that
 * state, including where the underlying research was unsure.
 *
 * It deliberately stops short of reproducing official forms. A replica built
 * from anything but the current official PDF risks a wrong field, a stale
 * revision, or altered certification language — on a document someone swears
 * to and a clerk may reject. Naming the real form and pointing at it serves
 * the parent better than a convincing forgery of it.
 */

const PAGE = { width: 612, height: 792 };
const MARGIN = 72; // 1 inch
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const SEAL_BOX = 144; // 2 inches

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 hours 15 minutes", "1 hour", "45 minutes" — this appears in sworn text. */
const fmtHoursMinutes = (mins) => {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return plural(m, 'minute');
  if (m === 0) return plural(h, 'hour');
  return `${plural(h, 'hour')} ${plural(m, 'minute')}`;
};

const fmtDur = (mins) => `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

// jsPDF's standard fonts silently drop typographic punctuation — an em dash
// or a curly apostrophe vanishes rather than erroring, which turned "DMV's"
// into "DMVs" and swallowed a dash mid-heading. Names carry these too
// (D'Angelo typed with U+2019), so anything reaching the page goes through
// this rather than only the literals here being written carefully.
const SMART_PUNCTUATION = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-',
  '…': '...', ' ': ' ', '•': '*',
};
const ascii = (value) =>
  String(value ?? '').replace(/[‘’‚‛“”„–—−… •]/g,
    (c) => SMART_PUNCTUATION[c]);

const longDate = (d) =>
  d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/** Parses a stored 'YYYY-MM-DD' as a calendar date, without timezone shifting. */
function parseLogDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

function dateRange(logs) {
  const dates = logs.map((l) => parseLogDate(l.date)).filter(Boolean).sort((a, b) => a - b);
  if (dates.length === 0) return null;
  const opts = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
  return {
    first: dates[0].toLocaleDateString('en-US', opts),
    last: dates[dates.length - 1].toLocaleDateString('en-US', opts),
  };
}

/** A labelled rule to sign or print on, returning the y below it. */
function signatureLine(doc, { x, y, width, label }) {
  doc.setDrawColor(0);
  doc.setLineWidth(0.75);
  doc.line(x, y, x + width, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(label, x, y + 11);
  return y + 11;
}

export async function exportAffidavitPdf({ student, req, logs, totals, parentName }) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  // Every string reaching the page is normalised, rather than relying on each
  // call site remembering to do it.
  const drawText = doc.text.bind(doc);
  doc.text = (txt, x, y, opts) =>
    drawText(Array.isArray(txt) ? txt.map(ascii) : ascii(txt), x, y, opts);
  const wrap = (text, width) => doc.splitTextToSize(ascii(text), width);

  const rules = affidavitRulesFor(student.state);
  const exportedOn = longDate(new Date());
  const range = dateRange(logs);
  const nightMinutes = totals.nightMinutes ?? 0;
  const dayMinutes = Math.max(0, (totals.totalMinutes ?? 0) - nightMinutes);
  const studentName = `${student.firstName} ${student.lastName}`.trim();

  doc.setTextColor(0);
  let y = MARGIN;

  // ---- Title ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('AFFIDAVIT OF SUPERVISED DRIVING', PAGE.width / 2, y, { align: 'center' });
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`State of ${req.name}`, PAGE.width / 2, y, { align: 'center' });
  y += 30;

  // ---- Who this concerns ----
  doc.setFontSize(11);
  doc.text(`Student driver: ${studentName}`, MARGIN, y);
  y += 16;
  doc.text(`Record prepared: ${exportedOn}`, MARGIN, y);
  y += 26;

  // ---- What this state actually requires ----
  // Placed above the figures because it changes what the reader should do
  // with the page. Where a specific official form is mandated, this document
  // does not stand in for it and must not be presented as though it does.
  if (rules.kind === 'specific' && rules.formLabel) {
    const lines = wrap(
      `${req.name} requires ${rules.formLabel} to certify supervised driving hours. ` +
        'This document does not replace that form. Obtain the official form from the ' +
        `state${rules.url ? ` at ${rules.url}` : ''}, and use the record below to complete it.` +
        (rules.note ? ` ${rules.note}` : ''),
      CONTENT_WIDTH - 24
    );
    const boxHeight = lines.length * 12 + 30;
    doc.setLineWidth(1);
    doc.rect(MARGIN, y - 12, CONTENT_WIDTH, boxHeight);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('REQUIRED STATE FORM', MARGIN + 12, y + 2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(lines, MARGIN + 12, y + 16);
    y += boxHeight + 14;
  } else if (rules.kind === 'none') {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.text(
      wrap(
        `${req.name} does not require a minimum number of supervised driving hours. ` +
          'This record is provided for your own use.',
        CONTENT_WIDTH
      ),
      MARGIN,
      y
    );
    doc.setFont('helvetica', 'normal');
    y += 24;
  }

  // ---- Summary: the numbers someone is verifying ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('SUMMARY OF SUPERVISED DRIVING', MARGIN, y);
  y += 8;
  doc.setLineWidth(1);
  doc.line(MARGIN, y, MARGIN + CONTENT_WIDTH, y);
  y += 20;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const summaryRows = [
    ['Total supervised driving', fmtHoursMinutes(totals.totalMinutes ?? 0)],
    ['Daytime driving', fmtHoursMinutes(dayMinutes)],
    ['Night driving', fmtHoursMinutes(nightMinutes)],
    ['Number of drives recorded', String(logs.length)],
    ['Period covered', range ? `${range.first} through ${range.last}` : 'No drives recorded'],
  ];
  if (req.totalHours > 0) {
    summaryRows.push([
      `${req.name} requirement`,
      `${req.totalHours} hours${req.nightHours > 0 ? `, including ${req.nightHours} at night` : ''}`,
    ]);
  }

  for (const [label, value] of summaryRows) {
    doc.setFont('helvetica', 'normal');
    doc.text(`${label}:`, MARGIN, y);
    doc.setFont('helvetica', 'bold');
    doc.text(value, MARGIN + 200, y);
    y += 17;
  }
  y += 14;

  // ---- Attestation ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('ATTESTATION', MARGIN, y);
  y += 8;
  doc.setLineWidth(1);
  doc.line(MARGIN, y, MARGIN + CONTENT_WIDTH, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const attestation =
    `I certify that the above record accurately reflects ${fmtHoursMinutes(totals.totalMinutes ?? 0)} ` +
    `of supervised behind-the-wheel driving completed by ${studentName}` +
    (range ? ` between ${range.first} and ${range.last}` : '') +
    `, of which ${fmtHoursMinutes(nightMinutes)} occurred at night. I further certify that this driving ` +
    `was supervised by a parent, guardian, or other licensed adult as required by the State of ${req.name}, ` +
    `and that the statements made herein are true and correct to the best of my knowledge.`;
  const attestationLines = wrap(attestation, CONTENT_WIDTH);
  doc.text(attestationLines, MARGIN, y);
  y += attestationLines.length * 14 + 24;

  // ---- Signatures ----
  const half = (CONTENT_WIDTH - 30) / 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Parent, guardian, or supervising licensed driver', MARGIN, y);
  y += 28;
  signatureLine(doc, { x: MARGIN, y, width: half, label: 'Printed name' });
  signatureLine(doc, { x: MARGIN + half + 30, y, width: half, label: 'Signature' });
  y += 44;
  signatureLine(doc, { x: MARGIN, y, width: half, label: 'Date signed' });
  y += 34;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Student driver', MARGIN, y);
  y += 28;
  signatureLine(doc, { x: MARGIN, y, width: half, label: 'Printed name' });
  signatureLine(doc, { x: MARGIN + half + 30, y, width: half, label: 'Signature' });
  y += 44;
  signatureLine(doc, { x: MARGIN, y, width: half, label: 'Date signed' });

  // ---- Notary page ----
  // Given its own page so the seal box is never squeezed by whatever the
  // attestation paragraph happened to wrap to.
  doc.addPage();
  y = MARGIN;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('NOTARY ACKNOWLEDGEMENT', MARGIN, y);
  y += 8;
  doc.setLineWidth(1);
  doc.line(MARGIN, y, MARGIN + CONTENT_WIDTH, y);
  y += 16;

  // What this state actually asks for, rather than a blanket "if required".
  const notaryGuidance =
    rules.notaryNote ??
    (rules.notary === 'required'
      ? `${req.name} requires this certification to be sworn before a notary.`
      : 'Complete only if your state requires this affidavit to be notarized.');
  doc.setFont('helvetica', rules.notary === 'required' ? 'bold' : 'italic');
  doc.setFontSize(9);
  doc.text(wrap(notaryGuidance, CONTENT_WIDTH), MARGIN, y);
  y += wrap(notaryGuidance, CONTENT_WIDTH).length * 12 + 16;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('State of _______________________', MARGIN, y);
  y += 20;
  doc.text('County of ______________________', MARGIN, y);
  y += 30;

  const jurat = wrap(
    'Subscribed and sworn to (or affirmed) before me this ________ day of ' +
      '__________________, 20______, by ________________________________________, ' +
      'proved to me on the basis of satisfactory evidence to be the person who appeared before me.',
    CONTENT_WIDTH
  );
  doc.text(jurat, MARGIN, y);
  y += jurat.length * 14 + 34;

  signatureLine(doc, { x: MARGIN, y, width: 260, label: 'Signature of notary public' });
  y += 44;
  signatureLine(doc, { x: MARGIN, y, width: 260, label: 'Printed name of notary public' });
  y += 44;
  signatureLine(doc, { x: MARGIN, y, width: 260, label: 'My commission expires' });

  // Blank square for the seal — bordered so it can't be mistaken for
  // somewhere to write, and kept clear of every line above.
  const sealX = MARGIN + CONTENT_WIDTH - SEAL_BOX;
  const sealY = y - 132;
  doc.setLineWidth(0.75);
  doc.setDrawColor(0);
  doc.rect(sealX, sealY, SEAL_BOX, SEAL_BOX);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.text('Notary seal', sealX + SEAL_BOX / 2, sealY + SEAL_BOX + 12, { align: 'center' });

  // ---- Disclaimer ----
  let disclaimerY = PAGE.height - MARGIN - 52;
  doc.setLineWidth(0.5);
  doc.line(MARGIN, disclaimerY - 14, MARGIN + CONTENT_WIDTH, disclaimerY - 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const disclaimer = wrap(
    'This is a general-purpose affidavit, not an official form of any state. Requirements differ by ' +
      'state: some do not require notarization, and some require a specific DMV form or specific ' +
      "wording. Check this document against your state DMV's own requirements before submitting it, " +
      'and use their form instead where one is prescribed.' +
      (rules.verify
        ? ` The requirements recorded for ${req.name} are unconfirmed against a current official source ` +
          '- verify them directly before relying on this document.'
        : '') +
      (rules.effectiveFrom
        ? ` Note that this requirement applies only to permits issued on or after ${rules.effectiveFrom}.`
        : '') +
      (rules.conditional ? ` ${rules.conditional}` : ''),
    CONTENT_WIDTH
  );
  doc.text(disclaimer, MARGIN, disclaimerY);

  // ---- Attachment: the itemized log ----
  if (logs.length > 0) {
    doc.addPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('ATTACHMENT A - ITEMIZED DRIVING LOG', MARGIN, MARGIN);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`${studentName} - ${logs.length} drives, ${fmtDur(totals.totalMinutes ?? 0)} total`, MARGIN, MARGIN + 18);
    // Several states certify a dated per-session log rather than a total, so
    // say which shape this state wants rather than leaving it as an appendix
    // the reader might skip.
    if (rules.shape === 'per-drive') {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.text(
        `${req.name} certifies a dated record of each session, not only a total. This table is that record.`,
        MARGIN,
        MARGIN + 32
      );
      doc.setFont('helvetica', 'normal');
    }

    autoTable(doc, {
      startY: MARGIN + (rules.shape === 'per-drive' ? 48 : 34),
      margin: { left: MARGIN, right: MARGIN },
      head: [['Date', 'Start', 'End', 'Duration', 'Time of Day', 'Type', 'Distance']],
      body: [...logs]
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
        .map((e) => {
          // The drive's own zone, matching the app and the CSV export. Using
          // the exporting device's zone instead would put different times
          // against the same drive in two documents filed together.
          const offset = e.startOffsetMinutes ?? localOffsetMinutes();
          return [
            e.date ?? '',
            e.startTime ? toZonedTimeInput(new Date(e.startTime), offset) : '',
            e.endTime ? toZonedTimeInput(new Date(e.endTime), offset) : '',
            fmtDur(e.durationMinutes ?? 0),
            e.timeOfDay === 'night' ? 'Night' : 'Day',
            ascii(cap(e.type)),
            e.distanceMiles != null ? `${e.distanceMiles} mi` : '-',
          ];
        }),
      // Plain black-on-white with ruled borders. Shaded headers and striped
      // rows photocopy and fax badly, which is what happens to these.
      theme: 'grid',
      headStyles: { fillColor: false, textColor: 0, fontStyle: 'bold', lineColor: 0, lineWidth: 0.5 },
      bodyStyles: { textColor: 0, lineColor: 0, lineWidth: 0.5 },
      styles: { fontSize: 9, cellPadding: 5, font: 'helvetica' },
    });
  }

  // doc.save() triggers jsPDF's own <a download> — a dead end inside a
  // Capacitor native shell (see saveOrShareBlob's comment), which is exactly
  // why this button did nothing for a generic-form state: every OTHER export
  // in the app (CSV, a state's own filled form) already goes through
  // saveOrShareBlob; this was the one left calling jsPDF's save directly.
  const blob = doc.output('blob');
  await saveOrShareBlob(blob, downloadFileName([student.firstName, student.lastName, 'dmv-affidavit'], 'pdf'));
}
