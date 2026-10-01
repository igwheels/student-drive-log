#!/usr/bin/env node
// Replays a captured telematics CSV through the real detector so hard-brake /
// harsh-turn thresholds can be tuned offline instead of by repeated driving.
//
// Capture a drive first: set localStorage 'sdl_telematics' = 'capture', drive,
// end the drive — the app downloads / console-dumps a CSV. Then:
//
//   node scripts/replay-telematics.mjs drive.csv
//   node scripts/replay-telematics.mjs drive.csv --brake 0.55 --turn 35 --hold 300
//   node scripts/replay-telematics.mjs drive.csv --trace
//   node scripts/replay-telematics.mjs drive.csv --sweep
//
// --brake is in g, --turn in deg/s, --hold / --cooldown in ms, --minspeed in
// mph. --trace prints the smoothed signals per sample. --sweep prints an
// event-count grid across a range of brake/turn thresholds.

import { readFileSync } from 'node:fs';
import {
  G,
  THRESHOLDS,
  createTelematicsState,
  processSample,
} from '../src/utils/telematicsCore.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error(
    'usage: node scripts/replay-telematics.mjs <capture.csv> ' +
      '[--brake g] [--turn deg/s] [--hold ms] [--cooldown ms] [--minspeed mph] [--trace] [--sweep]'
  );
  process.exit(1);
}
const num = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : def;
};
const trace = args.includes('--trace');
const sweep = args.includes('--sweep');

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const at = (k) => header.indexOf(k);
  const [iT, iX, iY, iZ, iR, iS] = ['t', 'x', 'y', 'z', 'rAlpha', 'speedMph'].map(at);
  if ([iT, iX, iY, iZ, iR].some((i) => i < 0)) {
    console.error(`bad header: ${lines[0]}`);
    process.exit(1);
  }
  return lines.slice(1).filter(Boolean).map((ln) => {
    const c = ln.split(',');
    return {
      t: Number(c[iT]),
      x: Number(c[iX]),
      y: Number(c[iY]),
      z: Number(c[iZ]),
      rAlpha: Number(c[iR]),
      speedMph: iS < 0 || c[iS] === '' || c[iS] == null ? null : Number(c[iS]),
    };
  });
}

function run(samples, thresholds) {
  const state = createTelematicsState();
  const events = [];
  for (const s of samples) {
    const { events: evs, debug } = processSample(state, s, { thresholds });
    for (const e of evs) events.push(e);
    if (trace && !sweep) {
      console.log(
        `+${((s.t - state.startedAt) / 1000).toFixed(1).padStart(6)}s ` +
          `spd=${String(debug.speedMph ?? '–').padStart(4)} ` +
          `brake=${debug.smBrake.toFixed(2).padStart(6)} ` +
          `yaw=${debug.smYaw.toFixed(0).padStart(4)}` +
          (debug.disturbed ? '  [DISTURBED]' : '') +
          (evs.length ? `   <<< ${evs.map((e) => e.type).join(', ')}` : '')
      );
    }
  }
  return events;
}

const samples = parseCsv(readFileSync(file, 'utf8'));
if (!samples.length) {
  console.error('no samples parsed');
  process.exit(1);
}
const durS = (samples[samples.length - 1].t - samples[0].t) / 1000 || 1;
console.log(
  `${samples.length} samples over ${durS.toFixed(0)}s (~${(samples.length / durS).toFixed(0)} Hz)\n`
);

if (sweep) {
  const brakes = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
  const turns = [30, 35, 40, 45, 50];
  console.log('cells = hardBrake / harshTurn event counts\n');
  console.log('brake(g) \\ turn(deg/s)  ' + turns.map((t) => String(t).padStart(8)).join(''));
  for (const b of brakes) {
    const cells = turns.map((t) => {
      const evs = run(samples, { ...THRESHOLDS, hardBrakeMs2: b * G, harshTurnDegS: t });
      const hb = evs.filter((e) => e.type === 'hard-brake').length;
      const ht = evs.filter((e) => e.type === 'harsh-turn').length;
      return `${hb}/${ht}`.padStart(8);
    });
    console.log(`   ${b.toFixed(2)}               ` + cells.join(''));
  }
} else {
  const thresholds = {
    ...THRESHOLDS,
    hardBrakeMs2: num('brake', THRESHOLDS.hardBrakeMs2 / G) * G,
    harshTurnDegS: num('turn', THRESHOLDS.harshTurnDegS),
    eventMinDurationMs: num('hold', THRESHOLDS.eventMinDurationMs),
    eventCooldownMs: num('cooldown', THRESHOLDS.eventCooldownMs),
    minSpeedMph: num('minspeed', THRESHOLDS.minSpeedMph),
  };
  console.log(
    `thresholds: brake=${(thresholds.hardBrakeMs2 / G).toFixed(2)}g ` +
      `turn=${thresholds.harshTurnDegS}deg/s hold=${thresholds.eventMinDurationMs}ms ` +
      `cooldown=${thresholds.eventCooldownMs}ms minSpeed=${thresholds.minSpeedMph}mph\n`
  );
  const events = run(samples, thresholds);
  if (!events.length) console.log('no events');
  for (const e of events) {
    console.log(
      `+${((e.at - samples[0].t) / 1000).toFixed(1).padStart(6)}s  ` +
        `${e.type.padEnd(10)} mag=${e.magnitude.toFixed(2)}`
    );
  }
  const hb = events.filter((e) => e.type === 'hard-brake').length;
  const ht = events.filter((e) => e.type === 'harsh-turn').length;
  console.log(`\ntotal: ${hb} hard-brake, ${ht} harsh-turn`);
}
