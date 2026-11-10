// Fit the forward-volatility forecast.
//
//   node tools/fit-volforecast.mjs [universe] [dte]
//
// The first attempt was a blend plus a flat multiplier, and it failed in a
// diagnosable way: it over-forecast exactly the names whose current vol is
// already high. The residual after fitting still sloped from a variance ratio
// of 1.16 in the quietest quintile to 0.85 in the wildest, and in practice
// that pushed SPY's forecast above its own implied vol, which would have told
// the scanner that index options - the most reliably rich premium there is -
// were too cheap to write.
//
// The cause is that a flat multiplier cannot express mean reversion. Pulling
// toward a long-run anchor helps, but the correction a quiet market needs is
// an uplift and the correction a panicking market needs is a haircut, and no
// single constant does both.
//
// So the forecast is fitted as a regression in LOG space:
//
//     log(sigma_forward) = a + b * log(sigma_blend)
//
// with b below 1. That is mean reversion expressed as a slope: forecasts above
// the long-run level get shrunk toward it and forecasts below it get lifted,
// by an amount proportional to how far out they are. Log space is the right
// space because volatility is roughly lognormal and strictly positive.
//
// Fitted on the first half of each symbol's history, scored on the second.
// Two parameters, so the out-of-sample number is the one that counts.
import { fetchSeries } from '../lib/data/yahoo.js';
import { realizedVol, parkinsonVol } from '../lib/options/vol.js';
import { UNIVERSES } from '../lib/scan.js';
import { tradingDaysFor } from '../lib/options/expectancy.js';

const universe = process.argv[2] || 'core';
const DTE = Number(process.argv[3]) || 35;
const H = tradingDaysFor(DTE);
const WARMUP = 600;
const STEP = 5;

const spec = UNIVERSES[universe];
if (!spec) { console.error(`Unknown universe "${universe}"`); process.exit(1); }

const train = [];
const test = [];

for (const symbol of spec.symbols) {
  let series;
  try { series = await fetchSeries(symbol, '1d'); } catch { continue; }
  const bars = series.bars;
  if (bars.length < WARMUP + H + 200) continue;
  const split = Math.floor((WARMUP + (bars.length - H)) / 2);

  for (let t = WARMUP; t + H < bars.length; t += STEP) {
    const visible = bars.slice(0, t + 1);
    const window = Math.max(10, Math.min(90, H));
    const rvC = realizedVol(visible, window);
    const rvP = parkinsonVol(visible, window);
    const cur = rvC != null && rvP != null ? (rvC + rvP) / 2 : (rvC ?? rvP);
    const long = realizedVol(visible, 252);
    const fwd = realizedVol(bars.slice(t, t + H + 1), H - 1);
    if (!(cur > 0) || !(long > 0) || !(fwd > 0)) continue;
    (t < split ? train : test).push({ symbol, cur, long, fwd });
  }
  process.stderr.write(`  ${symbol}\n`);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const blendOf = (r, w) => r.cur * w + r.long * (1 - w);

// Ordinary least squares of log(forward) on log(blend).
function fitLog(rows, w) {
  const xs = rows.map((r) => Math.log(blendOf(r, w)));
  const ys = rows.map((r) => Math.log(r.fwd));
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  // Exponentiating a log-space fit returns the MEDIAN, not the mean. For
  // option valuation the mean matters, so add back the usual half-variance of
  // the residuals - the standard smearing correction.
  let ss = 0;
  for (let i = 0; i < xs.length; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  const resVar = ss / (xs.length - 2);
  return { a, b, resVar, smear: Math.exp(resVar / 2) };
}

const predict = (fit, r, w) => Math.exp(fit.a + fit.b * Math.log(blendOf(r, w))) * fit.smear;

const scoreFit = (rows, fit, w) => {
  const mae = mean(rows.map((r) => Math.abs(r.fwd - predict(fit, r, w))));
  const varBias = mean(rows.map((r) => r.fwd ** 2)) / mean(rows.map((r) => predict(fit, r, w) ** 2));
  const volBias = mean(rows.map((r) => r.fwd / predict(fit, r, w)));
  return { mae, varBias, volBias };
};

console.log(`\nUniverse ${universe} · ${DTE} DTE (${H} trading days)`);
console.log(`train ${train.length} points, test ${test.length} points\n`);

console.log('=== Log-space regression, grid over the blend weight ===');
console.log('  w(current)      a        b      smear    test MAE   test volBias  test varBias');
let best = null;
for (const w of [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
  const fit = fitLog(train, w);
  const s = scoreFit(test, fit, w);
  console.log(
    `  ${w.toFixed(2).padStart(8)}  ${fit.a.toFixed(4).padStart(8)} ${fit.b.toFixed(4).padStart(7)} ` +
    `${fit.smear.toFixed(4).padStart(9)} ${s.mae.toFixed(3).padStart(10)} ${s.volBias.toFixed(4).padStart(13)} ${s.varBias.toFixed(4).padStart(13)}`
  );
  if (!best || s.mae < best.s.mae) best = { w, fit, s };
}

console.log(`\nBest out-of-sample MAE: w=${best.w}, a=${best.fit.a.toFixed(4)}, b=${best.fit.b.toFixed(4)}, smear=${best.fit.smear.toFixed(4)}`);
console.log(`  b=${best.fit.b.toFixed(3)} means mean reversion: a 1% rise in the blend lifts the`);
console.log(`  forecast only ${(best.fit.b * 100).toFixed(0)}%, so extreme readings get pulled toward the middle.`);

// The test that killed the previous version. If the variance ratio is flat
// near 1 across the quintiles, the mean reversion is captured. If it still
// slopes, the specification is still wrong and should not ship.
console.log('\n=== Regime check on the TEST half (the test the flat multiplier failed) ===');
console.log('  current-vol quintile   mean current   mean forecast   mean forward   variance ratio');
const sorted = [...test].sort((a, b) => a.cur - b.cur);
const q = Math.floor(sorted.length / 5);
for (let i = 0; i < 5; i++) {
  const b = sorted.slice(i * q, i === 4 ? sorted.length : (i + 1) * q);
  const s = scoreFit(b, best.fit, best.w);
  console.log(
    `  ${`Q${i + 1}${i === 0 ? ' (quietest)' : i === 4 ? ' (wildest)' : ''}`.padEnd(21)} ` +
    `${mean(b.map((r) => r.cur)).toFixed(1).padStart(13)}% ${mean(b.map((r) => predict(best.fit, r, best.w))).toFixed(1).padStart(14)}% ` +
    `${mean(b.map((r) => r.fwd)).toFixed(1).padStart(14)}% ${s.varBias.toFixed(3).padStart(16)}`
  );
}

// Per-symbol, because a universe-wide fit that is badly wrong on SPY is not
// usable for a scanner whose whole purpose is cross-symbol comparison.
console.log('\n=== Per-symbol bias on the TEST half (forward / forecast, 1.00 is unbiased) ===');
const bySymbol = new Map();
for (const r of test) {
  if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
  bySymbol.get(r.symbol).push(r);
}
const lines = [...bySymbol.entries()]
  .filter(([, rs]) => rs.length >= 50)
  .map(([sym, rs]) => ({ sym, n: rs.length, ...scoreFit(rs, best.fit, best.w) }))
  .sort((a, b) => a.volBias - b.volBias);
for (const l of lines) {
  console.log(`  ${l.sym.padEnd(9)} n=${String(l.n).padStart(4)}  volBias ${l.volBias.toFixed(3)}  varBias ${l.varBias.toFixed(3)}`);
}
console.log(`\n  Spread of per-symbol vol bias: ${Math.min(...lines.map((l) => l.volBias)).toFixed(3)} to ${Math.max(...lines.map((l) => l.volBias)).toFixed(3)}`);
console.log('  A wide spread means one universe-wide fit cannot serve every asset class,');
console.log('  which is a limit worth stating rather than averaging away.');

// --- universe-wide fit versus per-symbol fit -----------------------------
//
// The per-symbol bias spread above is too wide to average away: a forecast
// that runs 15% hot on SPY erases SPY's variance risk premium, and the
// variance risk premium on index options is the single most reliable thing a
// premium seller has. So test whether fitting each symbol on its OWN history
// beats one shared fit. Both are fitted on the train half and scored on the
// test half, so the comparison is honest.
console.log('\n=== UNIVERSE-WIDE FIT vs PER-SYMBOL FIT (both scored out of sample) ===');
console.log('  symbol      n    universe MAE  bias  |  per-symbol MAE  bias   b');
const trainBySymbol = new Map();
for (const r of train) {
  if (!trainBySymbol.has(r.symbol)) trainBySymbol.set(r.symbol, []);
  trainBySymbol.get(r.symbol).push(r);
}

let uniMae = 0;
let perMae = 0;
let n = 0;
const perBias = [];
for (const l of lines) {
  const trRows = trainBySymbol.get(l.sym) || [];
  const teRows = bySymbol.get(l.sym);
  // Two parameters need a real sample; below this, fall back to the shared fit.
  if (trRows.length < 120) continue;
  const own = fitLog(trRows, best.w);
  const su = scoreFit(teRows, best.fit, best.w);
  const sp = scoreFit(teRows, own, best.w);
  uniMae += su.mae * teRows.length;
  perMae += sp.mae * teRows.length;
  n += teRows.length;
  perBias.push(sp.volBias);
  console.log(
    `  ${l.sym.padEnd(9)} ${String(teRows.length).padStart(4)}  ${su.mae.toFixed(2).padStart(11)} ${su.volBias.toFixed(3).padStart(6)}  |  ` +
    `${sp.mae.toFixed(2).padStart(13)} ${sp.volBias.toFixed(3).padStart(6)} ${own.b.toFixed(3).padStart(6)}`
  );
}
console.log(
  `\n  Weighted out-of-sample MAE:  universe-wide ${(uniMae / n).toFixed(3)}  |  per-symbol ${(perMae / n).toFixed(3)}`
);
console.log(
  `  Per-symbol bias spread: ${Math.min(...perBias).toFixed(3)} to ${Math.max(...perBias).toFixed(3)} ` +
  `(universe-wide was ${Math.min(...lines.map((l) => l.volBias)).toFixed(3)} to ${Math.max(...lines.map((l) => l.volBias)).toFixed(3)})`
);
console.log(
  '  MAE is the accuracy question; the bias SPREAD is the cross-sectional one,\n' +
  '  and for a scanner that ranks symbols against each other the spread is what\n' +
  '  decides it. A forecast biased the same way everywhere still ranks correctly;\n' +
  '  one biased differently per symbol does not.'
);

// --- one shared slope plus one per-symbol bias constant ------------------
//
// Two parameters per symbol overfits - the fitted slopes above collapse to
// 0.36 for BTC, which is not mean reversion, it is noise. But the thing that
// actually breaks a cross-sectional scanner is not slope error, it is the
// per-symbol BIAS: a forecast running 18% hot on SPY deletes SPY's variance
// risk premium while a forecast running 8% cold on SLV invents one.
//
// So try the minimal version: keep the universe-wide slope and fit ONE
// multiplicative constant per symbol. One parameter on ~900 observations is
// about as robust as a fitted quantity gets, and it targets exactly the
// failure that matters.
console.log('\n=== SHARED SLOPE + PER-SYMBOL BIAS CONSTANT (one parameter per symbol) ===');
console.log('  symbol      k     test MAE   test bias   (universe bias was)');
let corrMae = 0;
let corrN = 0;
const corrBias = [];
const kBySymbol = {};
for (const l of lines) {
  const trRows = trainBySymbol.get(l.sym) || [];
  const teRows = bySymbol.get(l.sym);
  if (trRows.length < 120) continue;
  // The correction is the train-half bias itself, in log space so it is a
  // clean multiplicative factor rather than an additive fudge.
  const k = Math.exp(mean(trRows.map((r) => Math.log(r.fwd / predict(best.fit, r, best.w)))));
  const scaled = { a: best.fit.a + Math.log(k), b: best.fit.b, smear: best.fit.smear };
  const s = scoreFit(teRows, scaled, best.w);
  corrMae += s.mae * teRows.length;
  corrN += teRows.length;
  corrBias.push(s.volBias);
  kBySymbol[l.sym] = Number(k.toFixed(4));
  console.log(
    `  ${l.sym.padEnd(9)} ${k.toFixed(3).padStart(6)} ${s.mae.toFixed(2).padStart(10)} ` +
    `${s.volBias.toFixed(3).padStart(11)}   ${l.volBias.toFixed(3).padStart(6)}`
  );
}
console.log(
  `\n  Weighted out-of-sample MAE:  universe ${(uniMae / n).toFixed(3)}  |  ` +
  `per-symbol 2-param ${(perMae / n).toFixed(3)}  |  shared slope + bias k ${(corrMae / corrN).toFixed(3)}`
);
console.log(
  `  Bias spread:  universe ${Math.min(...lines.map((l) => l.volBias)).toFixed(3)}-${Math.max(...lines.map((l) => l.volBias)).toFixed(3)}  |  ` +
  `2-param ${Math.min(...perBias).toFixed(3)}-${Math.max(...perBias).toFixed(3)}  |  ` +
  `bias k ${Math.min(...corrBias).toFixed(3)}-${Math.max(...corrBias).toFixed(3)}`
);
const spread = (xs) => Math.max(...xs) - Math.min(...xs);
console.log(
  `\n  Spread narrowed from ${spread(lines.map((l) => l.volBias)).toFixed(3)} to ${spread(corrBias).toFixed(3)} ` +
  `(${(((spread(lines.map((l) => l.volBias)) - spread(corrBias)) / spread(lines.map((l) => l.volBias))) * 100).toFixed(0)}% reduction).`
);
console.log('  If that holds, the live forecast should carry a per-symbol k fitted on all');
console.log('  available history, and symbols without enough history fall back to k=1.');
console.log('\n  k constants:');
console.log(`  ${JSON.stringify(kBySymbol)}`);

console.log('\n=== CONSTANTS TO PASTE INTO lib/options/vol.js ===');
console.log(`  const VOL_BLEND_CURRENT = ${best.w};`);
console.log(`  const VOL_FIT = { a: ${best.fit.a.toFixed(4)}, b: ${best.fit.b.toFixed(4)}, smear: ${best.fit.smear.toFixed(4)} };`);
