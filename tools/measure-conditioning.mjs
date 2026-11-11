// Which conditions actually move the forward distribution?
//
//   node tools/measure-conditioning.mjs [universe] [stepBars]
//
// This decides what a projection can honestly claim. There are two completely
// different questions hiding inside "predict the next candles", and conflating
// them is how forecasting tools become dishonest:
//
//   LOCATION - does the condition tell you which WAY price goes? This is the
//   one everybody wants and the one this app has already failed once: the
//   setup-score backtest ran 3,725 independent trades and found a rank
//   correlation of -0.14 on the short side and roughly zero overall.
//
//   SCALE - does the condition tell you HOW FAR price travels, in either
//   direction? This one the app has already proved it can do: the volatility
//   forecast in vol.js was calibrated out of sample and beat its baselines.
//
// A projection cone built on scale is honest. A cone whose centre is tilted by
// a condition that does not actually predict direction is a lie with a chart
// attached. So every condition below is scored on both axes, separately, and
// only what survives gets to influence anything.
//
// Method: indicator series are computed ONCE per symbol and read at each bar,
// which is both far faster than re-running the engine per bar and
// lookahead-free by construction - every indicator here is causal.
import { fetchSeries } from '../lib/data/yahoo.js';
import { sma, rsi, atr, adx, bollinger, stdev, pctChange } from '../lib/ta/indicators.js';
import { UNIVERSES } from '../lib/scan.js';

const universe = process.argv[2] || 'core';
const STEP = Number(process.argv[3]) || 1;
const HORIZONS = [1, 5, 10, 20];
const WARMUP = 260;

const spec = UNIVERSES[universe];
if (!spec) { console.error(`Unknown universe "${universe}"`); process.exit(1); }

// --- condition definitions ------------------------------------------------
//
// Each returns a label or null. Grouped so each group partitions the sample
// and the groups can be compared against their own baseline.
const CONDITIONS = [
  {
    group: 'Candlestick signal',
    fn: (s, i) => {
      const cur = s.bars[i];
      const prev = s.bars[i - 1];
      if (!prev) return null;
      const body = Math.abs(cur.close - cur.open);
      const range = cur.high - cur.low;
      if (!(range > 0)) return null;
      const upper = cur.high - Math.max(cur.close, cur.open);
      const lower = Math.min(cur.close, cur.open) - cur.low;
      const prevBody = Math.abs(prev.close - prev.open);
      if (body > prevBody && cur.close > cur.open && prev.close < prev.open &&
          cur.close > prev.open && cur.open < prev.close) return 'bullish engulfing';
      if (body > prevBody && cur.close < cur.open && prev.close > prev.open &&
          cur.close < prev.open && cur.open > prev.close) return 'bearish engulfing';
      if (lower > body * 2 && upper < body * 0.6) return 'hammer';
      if (upper > body * 2 && lower < body * 0.6) return 'shooting star';
      if (body / range < 0.1) return 'doji';
      return null;
    },
  },
  {
    group: 'RSI band',
    fn: (s, i) => {
      const r = s.rsi[i];
      if (r == null) return null;
      if (r < 30) return 'RSI < 30';
      if (r < 45) return 'RSI 30-45';
      if (r < 55) return 'RSI 45-55';
      if (r < 70) return 'RSI 55-70';
      return 'RSI > 70';
    },
  },
  {
    group: 'Trend strength',
    fn: (s, i) => {
      const a = s.adx[i];
      if (a == null) return null;
      if (a < 20) return 'ADX < 20 (ranging)';
      if (a < 25) return 'ADX 20-25';
      if (a < 35) return 'ADX 25-35 (trending)';
      return 'ADX > 35 (strong)';
    },
  },
  {
    group: 'Bollinger width percentile',
    fn: (s, i) => {
      const p = s.bbPct[i];
      if (p == null) return null;
      if (p < 20) return 'squeeze (<20th)';
      if (p < 50) return '20-50th';
      if (p < 80) return '50-80th';
      return 'expanded (>80th)';
    },
  },
  {
    group: 'Moving-average stack',
    fn: (s, i) => {
      const c = s.bars[i].close;
      const [a, b, d] = [s.sma20[i], s.sma50[i], s.sma200[i]];
      if (a == null || b == null || d == null) return null;
      if (c > a && a > b && b > d) return 'full bull stack';
      if (c < a && a < b && b < d) return 'full bear stack';
      return 'mixed';
    },
  },
  {
    group: 'Recent 5-bar move',
    fn: (s, i) => {
      const ch = s.chg5[i];
      const a = s.atrPct[i];
      if (ch == null || a == null || !(a > 0)) return null;
      const z = ch / (a * Math.sqrt(5));
      if (z < -1.5) return 'fell >1.5 ATR';
      if (z < -0.5) return 'fell 0.5-1.5 ATR';
      if (z < 0.5) return 'flat';
      if (z < 1.5) return 'rose 0.5-1.5 ATR';
      return 'rose >1.5 ATR';
    },
  },
];

// --- gather ---------------------------------------------------------------

const samples = [];

for (const symbol of spec.symbols) {
  let series;
  try { series = await fetchSeries(symbol, '1d'); } catch { continue; }
  const bars = series.bars;
  if (bars.length < WARMUP + 60) continue;

  const closes = bars.map((b) => b.close);
  const s = {
    bars,
    rsi: rsi(closes, 14),
    adx: adx(bars, 14).adx,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    atrPct: atr(bars, 14).map((a, i) => (a == null || !closes[i] ? null : (a / closes[i]) * 100)),
    chg5: closes.map((_, i) => (i >= 5 ? ((closes[i] - closes[i - 5]) / closes[i - 5]) * 100 : null)),
  };

  // Bollinger width percentile, rolling so it is causal.
  const bb = bollinger(closes, 20, 2);
  const width = closes.map((c, i) =>
    bb.upper[i] == null || !c ? null : ((bb.upper[i] - bb.lower[i]) / c) * 100
  );
  s.bbPct = width.map((w, i) => {
    if (w == null || i < 250) return null;
    const hist = width.slice(i - 250, i + 1).filter((x) => x != null);
    if (hist.length < 100) return null;
    let below = 0;
    for (const x of hist) if (x < w) below++;
    return (100 * below) / hist.length;
  });

  const maxH = Math.max(...HORIZONS);
  for (let i = WARMUP; i + maxH < bars.length; i += STEP) {
    const close = closes[i];
    const a = s.atrPct[i];
    if (!close || !(a > 0)) continue;

    const labels = {};
    for (const c of CONDITIONS) labels[c.group] = c.fn(s, i);

    const fwd = {};
    for (const h of HORIZONS) {
      const r = ((closes[i + h] - close) / close) * 100;
      // Normalised by the volatility available at decision time, so a 2% move
      // in a quiet name and a 2% move in a wild one are not pooled as equals.
      fwd[h] = { raw: r, norm: r / (a * Math.sqrt(h)) };
    }
    samples.push({ symbol, labels, fwd });
  }
  process.stderr.write(`  ${symbol} (${samples.length})\n`);
}

if (!samples.length) { console.error('No samples - upstream probably throttled.'); process.exit(1); }

// --- report ---------------------------------------------------------------

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
// Third moment, standardised. The leverage effect lives here: a sharp fall is
// followed by a more left-skewed distribution even when the MEAN is unmoved,
// and skew is a property of shape rather than of direction, so it can be used
// without claiming to know which way price goes.
const skew = (xs) => {
  const m = mean(xs);
  const s = sd(xs);
  if (!(s > 0)) return 0;
  return xs.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / xs.length;
};

// Overlapping windows share all but one of their forward bars, so n badly
// overstates the independent sample. Deflating by the horizon is the standard
// correction and it is the difference between "significant" and "noise" for
// every location effect in this file - at a 20-bar horizon it divides t by
// about 4.5.
const effectiveT = (t, n, horizon) => t / Math.sqrt(horizon);

console.log(`\nUniverse ${universe} · ${samples.length} decision bars · every ${STEP} bar(s)`);
console.log('\nLOCATION is the direction question: does the mean forward move shift?');
console.log('SCALE is the size question: does the spread of outcomes change?');
console.log('Both are in units of the volatility available at decision time, so they');
console.log('are comparable across symbols. t is the location shift in standard errors:');
console.log('|t| under about 2 is noise, and with this many overlapping samples even');
console.log('t = 3 is a small effect.\n');

for (const cond of CONDITIONS) {
  console.log(`${'='.repeat(78)}\n${cond.group}`);
  for (const h of HORIZONS) {
    const all = samples.filter((s) => s.labels[cond.group] != null);
    if (all.length < 200) continue;
    const baseNorm = all.map((s) => s.fwd[h].norm);
    const baseMean = mean(baseNorm);
    const baseSd = sd(baseNorm);

    const groups = [...new Set(all.map((s) => s.labels[cond.group]))].sort();
    const baseSkew = skew(baseNorm);
    console.log(
      `\n  ${h}-bar horizon   (baseline mean ${baseMean.toFixed(3)}, spread ${baseSd.toFixed(3)}, skew ${baseSkew.toFixed(2)})`
    );
    console.log('    condition               eff n     LOCATION (t_eff)       SCALE      SKEW');
    for (const g of groups) {
      const rows = all.filter((s) => s.labels[cond.group] === g);
      if (rows.length < 60) continue;
      const xs = rows.map((s) => s.fwd[h].norm);
      const m = mean(xs);
      const spread = sd(xs);
      const tRaw = (m - baseMean) / (spread / Math.sqrt(rows.length));
      const t = effectiveT(tRaw, rows.length, h);
      const sk = skew(xs);
      // Flag only what survives the overlap correction.
      const flag = Math.abs(t) >= 2 ? ' *' : '';
      console.log(
        `    ${g.padEnd(22)} ${String(Math.round(rows.length / h)).padStart(6)}  ` +
        `${m.toFixed(3).padStart(7)} (t=${t.toFixed(1).padStart(5)})${flag.padEnd(2)}  ` +
        `${spread.toFixed(3).padStart(6)} (${(spread / baseSd).toFixed(2)}x)  ${sk.toFixed(2).padStart(6)}`
      );
    }
  }
}

// --- the summary that decides the design ---------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log('SUMMARY: biggest LOCATION effect vs biggest SCALE effect, per condition');
console.log('(20-bar horizon, the one a projection would actually be drawn over)\n');
console.log('  condition group          best |t_eff|   scale ratio   skew range   verdict');
const H = 20;
for (const cond of CONDITIONS) {
  const all = samples.filter((s) => s.labels[cond.group] != null);
  if (all.length < 200) continue;
  const baseNorm = all.map((s) => s.fwd[H].norm);
  const baseMean = mean(baseNorm);
  const baseSd = sd(baseNorm);
  let bestT = 0;
  let loScale = Infinity;
  let hiScale = 0;
  let loSkew = Infinity;
  let hiSkew = -Infinity;
  for (const g of [...new Set(all.map((s) => s.labels[cond.group]))]) {
    const rows = all.filter((s) => s.labels[cond.group] === g);
    if (rows.length < 60) continue;
    const xs = rows.map((s) => s.fwd[H].norm);
    const spread = sd(xs);
    const t = effectiveT((mean(xs) - baseMean) / (spread / Math.sqrt(rows.length)), rows.length, H);
    if (Math.abs(t) > Math.abs(bestT)) bestT = t;
    loScale = Math.min(loScale, spread / baseSd);
    hiScale = Math.max(hiScale, spread / baseSd);
    const sk = skew(xs);
    loSkew = Math.min(loSkew, sk);
    hiSkew = Math.max(hiSkew, sk);
  }
  const ratio = hiScale / loScale;
  const skewRange = hiSkew - loSkew;
  const usable = ratio >= 1.2 || skewRange >= 0.5;
  const verdict =
    usable && Math.abs(bestT) < 2 ? 'SHAPE only - width/skew, never tilt'
      : usable && Math.abs(bestT) >= 2 ? 'shape + a tilt worth a second look'
        : Math.abs(bestT) >= 2 ? 'tilt only - verify hard before using'
          : 'nothing survives - drop it';
  console.log(
    `  ${cond.group.padEnd(26)} ${Math.abs(bestT).toFixed(2).padStart(6)}   ` +
    `${ratio.toFixed(2).padStart(10)}x   ${skewRange.toFixed(2).padStart(9)}   ${verdict}`
  );
}

console.log(
  '\n  t_eff is the location shift after deflating for overlapping windows.\n' +
  '  Any condition whose |t_eff| is under 2 cannot be used to tilt a projection,\n' +
  '  however large its raw t looked. That is the whole point of this file: the\n' +
  '  raw numbers make several of these look like signal, and they are not.'
);
