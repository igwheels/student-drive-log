/**
 * Renders the progress gauge embedded in the weekly progress email, matching
 * the dashboard's speedometer-style dial. A plain PNG (email clients can't run
 * the app's SVG code), attached to the email as an inline cid image. There is
 * intentionally no route-map renderer — see send-weekly-emails.js.
 */
import { createCanvas } from '@napi-rs/canvas';

export async function renderGaugePng({ label, value, goal, color = '#2F6FDE', size = 220 }) {
  const height = size + 34;
  const canvas = createCanvas(size, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#141C2E';
  ctx.fillRect(0, 0, size, height);

  const pct = goal > 0 ? Math.min(value / goal, 1) : 0;
  const center = size / 2;
  const outerR = size / 2 - 14;
  const tickCount = 28;
  const sweep = 270;
  const startAngle = -225;

  const toXY = (angleDeg, r) => {
    const rad = (angleDeg * Math.PI) / 180;
    return [center + r * Math.cos(rad), center + r * Math.sin(rad)];
  };

  for (let i = 0; i <= tickCount; i++) {
    const t = i / tickCount;
    const angle = startAngle + t * sweep;
    const isMajor = i % 7 === 0;
    const [x1, y1] = toXY(angle, outerR);
    const [x2, y2] = toXY(angle, outerR - (isMajor ? 16 : 10));
    ctx.strokeStyle = t <= pct + 0.001 ? color : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = isMajor ? 3.5 : 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  const [nx, ny] = toXY(startAngle + pct * sweep, outerR - 30);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(center, center);
  ctx.lineTo(nx, ny);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(center, center, 6, 0, Math.PI * 2);
  ctx.fill();

  const fmt = (mins) => `${Math.floor(mins / 60)}h${String(Math.round(mins % 60)).padStart(2, '0')}m`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText(fmt(value), center, center + 34);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '14px sans-serif';
  ctx.fillText(`of ${Math.round(goal / 60)}h goal`, center, center + 56);
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(label.toUpperCase(), center, size + 24);

  return canvas.toBuffer('image/png');
}
