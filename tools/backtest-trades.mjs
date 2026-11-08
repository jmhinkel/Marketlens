// Trigger / stop / target simulation - the fair test of the setup score.
//
//   node tools/backtest-trades.mjs [universe] [maxHoldBars] [maxWaitBars]
//
// The previous backtest held blindly for N days, which ignores the two levels
// the score is actually built around. This one trades the setup as specified:
// wait for the trigger, enter there, exit at the stop or the target, and
// measure the result in R - multiples of the risk taken - which is the only
// unit that makes a tight stop and a wide one comparable.
//
// Realism choices, all of them pessimistic where there is doubt:
//
//   * Lookahead is structurally impossible: the analysis is handed a slice
//     ending at the decision bar.
//   * If a bar's range contains BOTH the stop and the target, the stop is
//     assumed to have come first. Intrabar order is unknowable from daily
//     bars and assuming the good outcome is how backtests lie.
//   * Entry fills at the trigger, or at the open if price gapped straight
//     through it - never at the better of the two.
//   * One position per symbol at a time. The previous test sampled every 10
//     bars and counted the same formation repeatedly; here a new trade cannot
//     start until the last one closed, so the trades are independent.
import { fetchSeries } from '../lib/data/yahoo.js';
import { analyzeTechnicals } from '../lib/ta/technical.js';
import { scoreSetup, UNIVERSES } from '../lib/scan.js';

const universe = process.argv[2] || 'core';
const MAX_HOLD = Number(process.argv[3]) || 60;
const MAX_WAIT = Number(process.argv[4]) || 15;
const WARMUP = 420;
const STEP = 3;

const spec = UNIVERSES[universe];
if (!spec) {
  console.error(`Unknown universe "${universe}". Options: ${Object.keys(UNIVERSES).join(', ')}`);
  process.exit(1);
}

// Walk a trade forward from the bar after entry and return its R multiple.
function simulate(bars, startIdx, dir, entry, stop, target) {
  const long = dir === 'long';
  const risk = Math.abs(entry - stop);
  if (!risk) return null;

  for (let i = startIdx; i < Math.min(bars.length, startIdx + MAX_HOLD); i++) {
    const b = bars[i];
    const hitStop = long ? b.low <= stop : b.high >= stop;
    const hitTarget = long ? b.high >= target : b.low <= target;

    // Pessimistic tie-break: when both are inside the same bar, take the loss.
    if (hitStop) return { r: -1, bars: i - startIdx + 1, exit: 'stop' };
    if (hitTarget) return { r: Math.abs(target - entry) / risk, bars: i - startIdx + 1, exit: 'target' };
  }

  const last = bars[Math.min(bars.length - 1, startIdx + MAX_HOLD - 1)];
  const move = long ? last.close - entry : entry - last.close;
  return { r: move / risk, bars: MAX_HOLD, exit: 'timeout' };
}

const trades = [];

for (const symbol of spec.symbols) {
  let series;
  try { series = await fetchSeries(symbol, '1d'); } catch { continue; }
  const bars = series.bars;
  if (bars.length < WARMUP + 120) continue;

  // Separate occupancy per direction so a long and a short are not forced to
  // compete for the same slot.
  const busyUntil = { long: 0, short: 0 };

  for (let t = WARMUP; t < bars.length - MAX_HOLD - MAX_WAIT; t += STEP) {
    let tech;
    try {
      tech = analyzeTechnicals({ bars: bars.slice(0, t + 1), timeframe: '1d', timeframeLabel: 'daily' });
    } catch { continue; }
    if (tech.volatility?.atrPct == null || tech.volatility.atrPct < 0.7) continue;

    for (const dir of ['long', 'short']) {
      if (t < busyUntil[dir]) continue;
      const setup = scoreSetup({ technical: tech }, dir);
      const p = setup?.pattern;
      if (!p || p.trigger == null || p.invalidation == null || p.target == null) continue;

      const long = dir === 'long';
      // Target and stop must sit on the correct sides, or the geometry is
      // nonsense and the trade is unplaceable.
      if (long && !(p.target > p.trigger && p.invalidation < p.trigger)) continue;
      if (!long && !(p.target < p.trigger && p.invalidation > p.trigger)) continue;

      let entryIdx = null;
      let entry = null;

      if (p.stage === 'confirmed') {
        entryIdx = t + 1;
        if (entryIdx >= bars.length) continue;
        entry = bars[entryIdx].open; // next bar's open, not this bar's close
      } else {
        // Wait for the trigger. Fill at the trigger, or at the open on a gap.
        for (let w = t + 1; w <= Math.min(t + MAX_WAIT, bars.length - 1); w++) {
          const b = bars[w];
          const crossed = long ? b.high >= p.trigger : b.low <= p.trigger;
          if (!crossed) continue;
          entryIdx = w;
          entry = long ? Math.max(p.trigger, b.open) : Math.min(p.trigger, b.open);
          break;
        }
        if (entryIdx == null) continue; // never triggered - no trade
      }

      const res = simulate(bars, entryIdx + 1, dir, entry, p.invalidation, p.target);
      if (!res) continue;

      trades.push({ symbol, dir, score: setup.score, stage: p.stage, ...res });
      busyUntil[dir] = entryIdx + res.bars;
    }
  }
  process.stderr.write(`  ${symbol} done (${trades.length} trades)\n`);
}

// --- reporting -----------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '—');

function report(label, rows) {
  if (!rows.length) return console.log(`\n${label}: no trades`);
  const buckets = [
    ['< 40', (s) => s < 40], ['40-49', (s) => s >= 40 && s < 50],
    ['50-59', (s) => s >= 50 && s < 60], ['60-69', (s) => s >= 60 && s < 70],
    ['70+', (s) => s >= 70],
  ];
  console.log(`\n${label}  (n=${rows.length} independent trades, result in R)`);
  console.log('  bucket     n     expectancy   win%   target%   stop%   timeout%');
  for (const [name, test] of buckets) {
    const b = rows.filter((r) => test(r.score));
    if (!b.length) { console.log(`  ${name.padEnd(9)}     0          —      —        —       —        —`); continue; }
    const rs = b.map((r) => r.r);
    console.log(
      `  ${name.padEnd(9)} ${String(b.length).padStart(5)}  ${mean(rs).toFixed(3).padStart(9)}R  ` +
      `${pct(b.filter((r) => r.r > 0).length, b.length).padStart(5)}%  ` +
      `${pct(b.filter((r) => r.exit === 'target').length, b.length).padStart(6)}%  ` +
      `${pct(b.filter((r) => r.exit === 'stop').length, b.length).padStart(5)}%  ` +
      `${pct(b.filter((r) => r.exit === 'timeout').length, b.length).padStart(7)}%`
    );
  }
  const rs = rows.map((r) => r.r);
  console.log(
    `  ALL       ${String(rows.length).padStart(5)}  ${mean(rs).toFixed(3).padStart(9)}R  ` +
    `${pct(rows.filter((r) => r.r > 0).length, rows.length).padStart(5)}%  ` +
    `${pct(rows.filter((r) => r.exit === 'target').length, rows.length).padStart(6)}%  ` +
    `${pct(rows.filter((r) => r.exit === 'stop').length, rows.length).padStart(5)}%  ` +
    `${pct(rows.filter((r) => r.exit === 'timeout').length, rows.length).padStart(7)}%   <- unselected`
  );

  const n = rows.length;
  const byS = [...rows].sort((a, b) => a.score - b.score);
  const byR = [...rows].sort((a, b) => a.r - b.r);
  const rS = new Map(); byS.forEach((r, i) => rS.set(r, i));
  const rR = new Map(); byR.forEach((r, i) => rR.set(r, i));
  let d2 = 0;
  for (const r of rows) d2 += (rS.get(r) - rR.get(r)) ** 2;
  console.log(`  Spearman rank correlation between score and R: ${(1 - (6 * d2) / (n * (n * n - 1))).toFixed(4)}`);
}

console.log(`\nUniverse ${universe} · max hold ${MAX_HOLD} bars · trigger window ${MAX_WAIT} bars · stop assumed first on ambiguous bars`);
report('LONG trades', trades.filter((t) => t.dir === 'long'));
report('SHORT trades', trades.filter((t) => t.dir === 'short'));

const conf = trades.filter((t) => t.stage === 'confirmed');
const form = trades.filter((t) => t.stage === 'forming');
console.log(
  `\nEntered on a confirmed break (n=${conf.length}): ${mean(conf.map((t) => t.r))?.toFixed(3)}R  |  ` +
  `entered on a trigger cross (n=${form.length}): ${mean(form.map((t) => t.r))?.toFixed(3)}R`
);
