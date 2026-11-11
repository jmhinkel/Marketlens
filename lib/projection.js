// Forward projection: where price could be, drawn as candles.
//
// WHAT THIS IS NOT
//
// It is not a forecast of the next candles. This app has now measured the
// direction question twice and got the same answer both times:
//
//   * The setup-score backtest ran 3,725 independent trades and found a rank
//     correlation between score and outcome of -0.14 on the short side and
//     roughly zero overall.
//   * tools/measure-conditioning.mjs tested every condition a projection might
//     plausibly tilt on - candlestick signals, RSI bands, ADX, Bollinger
//     squeeze, moving-average stack, recent momentum - across ~65,000 decision
//     bars. After deflating the t-statistics for overlapping windows, NOT ONE
//     reaches |t| = 2 on location. Candlestick signals top out at 0.32.
//
// So the centre of this projection is flat. It carries the risk-free drift
// and nothing else, and no indicator moves it. Tilting a cone on a signal that
// does not predict direction would be a lie with a chart attached, and the
// chart is exactly what makes it convincing.
//
// WHAT IT IS
//
// The same conditions that say nothing about direction say a great deal about
// SHAPE. In that measurement the scale ratio between conditions ran to 1.37x
// and the skew range to over 2 full units - a sharp fall is followed by a
// distribution that is both wider and markedly more left-skewed, even though
// its mean is unmoved. Width and skew are what this projects.
//
// The distribution is the one from lib/options/expectancy.js, unchanged: the
// asset's own overlapping returns, rescaled to the fitted forward-vol forecast
// and drifted at the risk-free rate. That object has been calibrated out of
// sample - 2.95 points of mean absolute error on the probability of finishing
// beyond a strike - so the cone inherits a real validation rather than an
// assertion. Each projected candle is a quantile summary of where price could
// be on that date: body 25th-75th, wicks 10th-90th. It is not a predicted bar.
import { returnDistribution, fairValue } from './options/expectancy.js';
import { forwardVolForecast, symbolVolBias } from './options/vol.js';
import { riskFreeRate } from './data/rates.js';

const TRADING_DAYS = 252;

// How far forward to draw, by timeframe. Long enough to be useful, short
// enough that the cone has not widened into a statement that price will be
// somewhere between half and double.
// Keys must match TIMEFRAMES in data/yahoo.js exactly - they are '1w' and
// '1M', not '1wk' and '1mo'.
const DEFAULT_HORIZON = { '5m': 24, '15m': 24, '1h': 30, '4h': 30, '1d': 21, '1w': 13, '1M': 9 };

const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// --- the cone -------------------------------------------------------------

function buildCone({ bars, spot, horizon, volAnnualPct, driftAnnualPct }) {
  const steps = [];
  for (let h = 1; h <= horizon; h++) {
    // One distribution per step. Passing the annualised vol explicitly means
    // every step is scaled from the SAME forecast, so the cone widens as the
    // square root of time by construction rather than by assumption - and the
    // per-symbol bias fit runs once, not once per step.
    const dist = returnDistribution(bars, h, { volAnnualPct, driftAnnualPct, minWindows: 100 });
    if (!dist) break;
    const sorted = Float64Array.from(dist.multipliers).sort();
    const at = (q) => Number((spot * quantile(sorted, q)).toFixed(4));
    steps.push({
      step: h,
      p05: at(0.05), p10: at(0.10), p25: at(0.25), p50: at(0.50),
      p75: at(0.75), p90: at(0.90), p95: at(0.95),
      // Both are reported because they differ, and the difference is a trap.
      // The MEAN is pinned to the risk-free drift by construction. The MEDIAN
      // sits above it whenever the distribution is left-skewed - more small
      // gains than large ones, paid for by rarer large falls - which is the
      // normal shape for equities. On SPY that puts the median about 0.9%
      // above spot at 21 bars, and on a chart that looks exactly like a
      // bullish call. It is not one, and the UI has to say so.
      medianPct: Number(((quantile(sorted, 0.5) - 1) * 100).toFixed(3)),
      meanPct: Number(
        ((dist.multipliers.reduce((a, b) => a + b, 0) / dist.multipliers.length - 1) * 100).toFixed(3)
      ),
    });
  }
  return steps;
}

// --- path outcomes: touching a level, not just finishing beyond it --------
//
// The cone answers "where might price be on that date". It does not answer
// "will it get there at some point", which is the question that actually
// matters for a stop, a target or a short strike. That needs paths, not
// terminal values, so the historical windows are replayed bar by bar with the
// same rescaling the cone uses.
//
// The high and low of each bar are used rather than the close: a level that
// was traded through intraday was touched, and pretending otherwise
// understates every stop-out.
function pathOutcomes(bars, horizon, { volScale, driftAnnualPct }) {
  const n = bars.length;
  const out = [];
  // Per-bar mean log return of the sample, removed so the replayed paths carry
  // no historical drift - the same refusal the terminal distribution makes.
  let total = 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    if (bars[i - 1]?.close > 0 && bars[i]?.close > 0) {
      total += Math.log(bars[i].close / bars[i - 1].close);
      count++;
    }
  }
  const muBar = count ? total / count : 0;
  const driftBar = driftAnnualPct / 100 / TRADING_DAYS;

  for (let i = 0; i + horizon < n; i++) {
    const base = bars[i].close;
    if (!(base > 0)) continue;
    let maxUp = -Infinity;
    let maxDown = Infinity;
    let ok = true;
    for (let t = 1; t <= horizon; t++) {
      const b = bars[i + t];
      if (!(b?.high > 0) || !(b?.low > 0)) { ok = false; break; }
      // Demean per bar, rescale, then re-apply the chosen drift.
      const adj = (v) => (Math.log(v / base) - muBar * t) * volScale + driftBar * t;
      maxUp = Math.max(maxUp, adj(b.high));
      maxDown = Math.min(maxDown, adj(b.low));
    }
    if (!ok) continue;
    const end = bars[i + horizon].close;
    if (!(end > 0)) continue;
    out.push({
      maxUp,
      maxDown,
      terminal: (Math.log(end / base) - muBar * horizon) * volScale + driftBar * horizon,
    });
  }
  return out;
}

function levelOdds(paths, spot, targets) {
  if (!paths.length) return [];
  return targets
    .map((t) => {
      if (!(t.price > 0) || !(spot > 0)) return null;
      const lr = Math.log(t.price / spot);
      const up = t.price > spot;
      let touched = 0;
      let beyond = 0;
      for (const p of paths) {
        if (up ? p.maxUp >= lr : p.maxDown <= lr) touched++;
        if (up ? p.terminal >= lr : p.terminal <= lr) beyond++;
      }
      return {
        ...t,
        direction: up ? 'above' : 'below',
        distancePct: Number((((t.price - spot) / spot) * 100).toFixed(2)),
        touchPct: Number(((100 * touched) / paths.length).toFixed(1)),
        closeBeyondPct: Number(((100 * beyond) / paths.length).toFixed(1)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.touchPct - a.touchPct);
}

// --- what this asset's own history says about the signal firing today -----
//
// The universe-wide measurement found no directional edge in any candlestick
// signal. This asks the narrower question the user is actually looking at:
// when THIS signal fired on THIS asset before, what happened next? The answer
// is almost always "nothing distinguishable", and the effective sample is
// reported so that the reader can see it is usually too small to have told
// them anything either way.
function signalHistory(bars, horizon, detector) {
  const n = bars.length;
  const hits = [];
  const all = [];
  for (let i = 1; i + horizon < n; i++) {
    const close = bars[i].close;
    const fwd = bars[i + horizon].close;
    if (!(close > 0) || !(fwd > 0)) continue;
    const r = ((fwd - close) / close) * 100;
    all.push(r);
    if (detector(bars, i)) hits.push(r);
  }
  if (hits.length < 8 || all.length < 100) {
    return { instances: hits.length, effectiveN: Math.round(hits.length / horizon), tooThin: true };
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  };
  const m = mean(hits);
  const base = mean(all);
  const s = sd(hits);
  // Deflated for overlapping windows, exactly as in the universe measurement.
  const tEff = s > 0 ? ((m - base) / (s / Math.sqrt(hits.length))) / Math.sqrt(horizon) : 0;
  return {
    instances: hits.length,
    effectiveN: Math.max(1, Math.round(hits.length / horizon)),
    meanForwardPct: Number(m.toFixed(2)),
    baselinePct: Number(base.toFixed(2)),
    edgePct: Number((m - base).toFixed(2)),
    tEff: Number(tEff.toFixed(2)),
    upRate: Number(((100 * hits.filter((r) => r > 0).length) / hits.length).toFixed(1)),
    significant: Math.abs(tEff) >= 2,
    tooThin: false,
  };
}

// Detectors mirroring candleSignals in ta/patterns.js, but indexable so they
// can be replayed over history rather than only evaluated on the last bar.
const DETECTORS = {
  'Bullish engulfing': (b, i) => {
    const c = b[i];
    const p = b[i - 1];
    if (!p) return false;
    return Math.abs(c.close - c.open) > Math.abs(p.close - p.open) &&
      c.close > c.open && p.close < p.open && c.close > p.open && c.open < p.close;
  },
  'Bearish engulfing': (b, i) => {
    const c = b[i];
    const p = b[i - 1];
    if (!p) return false;
    return Math.abs(c.close - c.open) > Math.abs(p.close - p.open) &&
      c.close < c.open && p.close > p.open && c.close < p.open && c.open > p.close;
  },
  'Hammer / long lower wick': (b, i) => {
    const c = b[i];
    const body = Math.abs(c.close - c.open);
    return c.high - c.low > 0 &&
      Math.min(c.close, c.open) - c.low > body * 2 &&
      c.high - Math.max(c.close, c.open) < body * 0.6;
  },
  'Shooting star / long upper wick': (b, i) => {
    const c = b[i];
    const body = Math.abs(c.close - c.open);
    return c.high - c.low > 0 &&
      c.high - Math.max(c.close, c.open) > body * 2 &&
      Math.min(c.close, c.open) - c.low < body * 0.6;
  },
  'Doji (indecision)': (b, i) => {
    const c = b[i];
    const range = c.high - c.low;
    return range > 0 && Math.abs(c.close - c.open) / range < 0.1;
  },
};

// --- entry point ----------------------------------------------------------

export async function buildProjection({ symbol, bars, timeframe = '1d', technical, horizonBars }) {
  if (!bars?.length) return null;
  const spot = technical?.price?.last ?? bars.at(-1).close;
  const horizon = horizonBars || DEFAULT_HORIZON[timeframe] || 21;
  if (bars.length < horizon + 150) {
    return { available: false, reason: 'Not enough history to project from.' };
  }

  // Daily bars are the only ones the vol forecast was fitted on. On other
  // timeframes the machinery still runs, but the per-symbol bias constant is
  // extrapolated rather than measured, and the UI should say so.
  const daily = timeframe === '1d';
  const bias = daily ? await symbolVolBias(symbol, bars, horizon) : null;
  const vf = forwardVolForecast(bars, horizon, bias ? { symbolBias: bias } : {});
  if (!vf) return { available: false, reason: 'Not enough history for a volatility forecast.' };

  const rf = await riskFreeRate();
  // Only daily bars carry a meaningful annualised carry assumption; on an
  // intraday chart the risk-free rate over 24 bars rounds to nothing anyway.
  const driftAnnualPct = daily ? rf.annualPct : 0;

  const steps = buildCone({ bars, spot, horizon, volAnnualPct: vf.forecast, driftAnnualPct });
  if (!steps.length) return { available: false, reason: 'Could not build a distribution at this horizon.' };

  const probe = returnDistribution(bars, horizon, {
    volAnnualPct: vf.forecast, driftAnnualPct, minWindows: 100,
  });
  const paths = pathOutcomes(bars, horizon, { volScale: probe?.volScale ?? 1, driftAnnualPct });

  // Levels worth quoting odds on: the engine's own clustered support and
  // resistance, plus any live pattern's trigger and target.
  const targets = [];
  for (const l of (technical?.levels || []).slice(0, 6)) {
    targets.push({ label: l.price > spot ? 'Resistance' : 'Support', price: l.price, kind: 'level', touches: l.touches });
  }
  for (const p of technical?.patterns || []) {
    if (p.target != null) targets.push({ label: `${p.name} target`, price: p.target, kind: 'target' });
    if (p.trigger != null) targets.push({ label: `${p.name} trigger`, price: p.trigger, kind: 'trigger' });
  }

  // The candlestick signals showing on the last bar, each with what this
  // asset's own history says about them.
  const signals = (technical?.candles || []).map((c) => ({
    ...c,
    history: DETECTORS[c.name] ? signalHistory(bars, horizon, DETECTORS[c.name]) : null,
  }));

  const last = steps.at(-1);
  const bandPct = {
    p10: Number((((last.p10 - spot) / spot) * 100).toFixed(1)),
    p25: Number((((last.p25 - spot) / spot) * 100).toFixed(1)),
    p75: Number((((last.p75 - spot) / spot) * 100).toFixed(1)),
    p90: Number((((last.p90 - spot) / spot) * 100).toFixed(1)),
  };

  return {
    available: true,
    symbol,
    timeframe,
    horizonBars: steps.length,
    spot,
    generatedAt: new Date().toISOString(),
    steps,
    bandPct,
    // Skew of the terminal distribution, which is the one thing besides width
    // that the conditioning study found to be real and large.
    skew: (() => {
      const m = probe ? Array.from(probe.multipliers) : [];
      if (m.length < 50) return null;
      const mu = m.reduce((a, b) => a + b, 0) / m.length;
      const sd = Math.sqrt(m.reduce((a, b) => a + (b - mu) ** 2, 0) / (m.length - 1));
      if (!(sd > 0)) return null;
      return Number((m.reduce((a, b) => a + ((b - mu) / sd) ** 3, 0) / m.length).toFixed(2));
    })(),
    volForecast: vf,
    riskFree: rf,
    driftAnnualPct,
    calibratedTimeframe: daily,
    distribution: probe
      ? {
          effectiveN: probe.effectiveN,
          windows: probe.windows,
          historyYears: probe.historyYears,
          volScale: probe.volScale,
          volScaleClamped: probe.volScaleClamped,
          sampleDriftAnnualPct: probe.sampleDriftAnnualPct,
        }
      : null,
    pathSamples: paths.length,
    levelOdds: levelOdds(paths, spot, targets).slice(0, 8),
    signals,
    // Stated in the payload rather than only in the UI, so an API consumer
    // cannot read the cone as a direction call.
    direction: {
      tilt: 'none',
      driftAnnualPct,
      note:
        `The centre of this cone is flat. Every condition tested - candlestick signals, RSI, ADX, ` +
        `Bollinger squeeze, moving-average stack and recent momentum - was measured across roughly ` +
        `65,000 decision bars and none shifted the mean forward return by 2 standard errors once ` +
        `overlapping windows were accounted for. The same conditions move the WIDTH and the SKEW ` +
        `substantially, and that is what is drawn.`,
    },
  };
}
