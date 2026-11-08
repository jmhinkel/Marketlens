// Walk-forward backtest of the setup score.
//
//   node tools/backtest-setups.mjs [universe] [horizonDays] [stepBars]
//
// At each sampled historical bar the engine is run on ONLY the bars up to that
// point, the setup is scored exactly as the live scanner scores it, and the
// forward return over the next N trading days is recorded. Scores are then
// bucketed and compared.
//
// Lookahead is the thing that makes a backtest lie, so it is guarded
// structurally rather than by care: the analysis never receives a bar past the
// decision date, because the array is sliced before it is handed over.
//
// What this CAN settle: whether the setup score orders forward returns.
// What it cannot: anything about option pricing - the IV/RV gate, premium,
// theta, breakeven - which needs historical chains rather than OHLCV.
import { fetchSeries } from '../lib/data/yahoo.js';
import { analyzeTechnicals } from '../lib/ta/technical.js';
import { scoreSetup, UNIVERSES } from '../lib/scan.js';

const universe = process.argv[2] || 'core';
const HORIZON = Number(process.argv[3]) || 20;
const STEP = Number(process.argv[4]) || 5;
const WARMUP = 420; // bars needed before the engine has a full picture

const spec = UNIVERSES[universe];
if (!spec) {
  console.error(`Unknown universe "${universe}". Options: ${Object.keys(UNIVERSES).join(', ')}`);
  process.exit(1);
}

const samples = [];
let skipped = 0;

for (const symbol of spec.symbols) {
  let series;
  try {
    series = await fetchSeries(symbol, '1d');
  } catch {
    skipped++;
    continue;
  }
  const bars = series.bars;
  if (bars.length < WARMUP + HORIZON + 50) { skipped++; continue; }

  for (let t = WARMUP; t < bars.length - HORIZON; t += STEP) {
    // Only history up to and including the decision bar.
    const visible = bars.slice(0, t + 1);
    let tech;
    try {
      tech = analyzeTechnicals({
        bars: visible,
        timeframe: '1d',
        timeframeLabel: 'daily',
      });
    } catch {
      continue;
    }
    if (tech.volatility?.atrPct == null || tech.volatility.atrPct < 0.7) continue;

    const entry = bars[t].close;
    const exit = bars[t + HORIZON].close;
    if (!entry || !exit) continue;
    const fwd = ((exit - entry) / entry) * 100;

    const analysis = { technical: tech };
    for (const dir of ['long', 'short']) {
      const setup = scoreSetup(analysis, dir);
      if (!setup) continue;
      samples.push({
        symbol,
        dir,
        score: setup.score,
        hasPattern: Boolean(setup.pattern),
        // A short "wins" when price falls, so flip the sign for comparability.
        outcome: dir === 'long' ? fwd : -fwd,
      });
    }
  }
  process.stderr.write(`  ${symbol} done (${samples.length} samples)\n`);
}

// --- reporting -----------------------------------------------------------

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '—');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function report(label, rows) {
  if (!rows.length) return console.log(`\n${label}: no samples`);
  const buckets = [
    ['< 40', (s) => s < 40],
    ['40-49', (s) => s >= 40 && s < 50],
    ['50-59', (s) => s >= 50 && s < 60],
    ['60-69', (s) => s >= 60 && s < 70],
    ['70+', (s) => s >= 70],
  ];
  console.log(`\n${label}  (n=${rows.length}, ${HORIZON}-day forward return, sign-adjusted so positive = setup worked)`);
  console.log('  bucket     n      mean     median    win rate');
  for (const [name, test] of buckets) {
    const b = rows.filter((r) => test(r.score));
    if (!b.length) { console.log(`  ${name.padEnd(9)} ${String(0).padStart(5)}        —         —          —`); continue; }
    const outs = b.map((r) => r.outcome);
    const wins = outs.filter((o) => o > 0).length;
    console.log(
      `  ${name.padEnd(9)} ${String(b.length).padStart(5)}  ${mean(outs).toFixed(2).padStart(7)}%  ` +
      `${median(outs).toFixed(2).padStart(7)}%  ${pct(wins, b.length).padStart(7)}%`
    );
  }
  // The number that matters most: how the buckets compare to doing nothing
  // selective at all. A score that beats zero in a rising market has proved
  // nothing; it has to beat the unconditional average entry.
  const base = mean(rows.map((r) => r.outcome));
  const baseWin = rows.filter((r) => r.outcome > 0).length;
  console.log(`  BASELINE  ${String(rows.length).padStart(5)}  ${base.toFixed(2).padStart(7)}%  ${median(rows.map(r=>r.outcome)).toFixed(2).padStart(7)}%  ${pct(baseWin, rows.length).padStart(7)}%   <- every sample, unselected`);

  // Rank correlation between score and outcome - the headline number.
  const n = rows.length;
  const byScore = [...rows].sort((a, b) => a.score - b.score);
  const byOut = [...rows].sort((a, b) => a.outcome - b.outcome);
  const rankS = new Map(); byScore.forEach((r, i) => rankS.set(r, i));
  const rankO = new Map(); byOut.forEach((r, i) => rankO.set(r, i));
  let d2 = 0;
  for (const r of rows) d2 += (rankS.get(r) - rankO.get(r)) ** 2;
  const rho = 1 - (6 * d2) / (n * (n * n - 1));
  console.log(`  Spearman rank correlation between score and forward return: ${rho.toFixed(4)}`);
}

console.log(`\nUniverse ${universe} · horizon ${HORIZON} trading days · sampled every ${STEP} bars · ${skipped} symbols skipped`);
report('LONG setups', samples.filter((s) => s.dir === 'long'));
report('SHORT setups', samples.filter((s) => s.dir === 'short'));

const withP = samples.filter((s) => s.hasPattern);
const noP = samples.filter((s) => !s.hasPattern);
console.log(
  `\nWith a formation (n=${withP.length}): mean ${mean(withP.map((s) => s.outcome))?.toFixed(2)}%  |  ` +
  `without one (n=${noP.length}): mean ${mean(noP.map((s) => s.outcome))?.toFixed(2)}%`
);
