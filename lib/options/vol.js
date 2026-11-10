// Volatility measurement for premium selling.
//
// The central question for a call seller is not "is volatility high" but "is
// the volatility being SOLD higher than the volatility the asset actually
// delivers". That spread - the variance risk premium - is the edge. Everything
// here exists to measure it.
import { fetchDailyCloses, fetchSeries } from '../data/yahoo.js';
import { percentileRank } from '../ta/indicators.js';
import { cached } from '../cache.js';

const TRADING_DAYS = 252;

// Calendar days to trading days. Lives here rather than in expectancy.js
// because volatilityProfile needs it and expectancy.js already imports from
// this module - putting it the other way round would make the two circular.
// expectancy.js re-exports it, so existing callers are unaffected.
export const tradingDaysFor = (calendarDays) =>
  Math.max(1, Math.round((calendarDays * TRADING_DAYS) / 365));

// Close-to-close annualised volatility, in percent.
export function realizedVol(bars, window = 30) {
  if (bars.length < window + 2) return null;
  const slice = bars.slice(-(window + 1));
  const rets = [];
  for (let i = 1; i < slice.length; i++) {
    if (!slice[i - 1].close || !slice[i].close) continue;
    rets.push(Math.log(slice[i].close / slice[i - 1].close));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * TRADING_DAYS) * 100;
}

// Parkinson estimator - uses the high-low range, so it extracts far more
// information per bar than close-to-close and is less fooled by an asset that
// swings intraday but closes flat.
export function parkinsonVol(bars, window = 30) {
  if (bars.length < window + 1) return null;
  const slice = bars.slice(-window);
  let acc = 0;
  let n = 0;
  for (const b of slice) {
    if (!b.high || !b.low || b.low <= 0) continue;
    acc += Math.log(b.high / b.low) ** 2;
    n++;
  }
  if (n < 5) return null;
  return Math.sqrt((acc / (4 * n * Math.LN2)) * TRADING_DAYS) * 100;
}

// Forward volatility forecast for an option tenor.
//
// MEASURED, NOT ASSUMED. Using current realised vol as the forecast - which is
// what the panels above do, and what every realised-versus-implied screener
// does - is biased low. Over 10,914 decision points across the core universe
// at a 24-day horizon, forward realised vol came in at 1.195x the current-vol
// blend, and the bias was concentrated exactly where premium sellers operate:
//
//     current-vol quintile    current    forward    ratio
//     Q1 (quietest)              9.7%      13.3%    1.39
//     Q3                        20.8%      25.4%    1.22
//     Q5 (wildest)              53.0%      50.5%    0.99
//
// That is volatility mean reversion, and it matters because a distribution
// scaled to a vol forecast 20% too low prices every option too cheap and tells
// a seller that every contract is rich.
//
// THREE ATTEMPTS, TWO REJECTED. The full record is in
// tools/fit-volforecast.mjs; all three were fitted on the first half of each
// symbol's history and scored on the second.
//
//   REJECTED - blend plus a flat multiplier. Out-of-sample MAE 6.67, but a
//   constant cannot express mean reversion: the residual still sloped from a
//   variance ratio of 1.16 in the quietest quintile to 0.85 in the wildest. In
//   practice it pushed SPY's forecast 18% above reality, which deleted SPY's
//   variance risk premium - and index premium is the most reliable there is.
//   A forecast that hides the best trade in the universe is not a forecast.
//
//   REJECTED - a full two-parameter regression per symbol. Worse on both
//   counts: MAE 7.32 and a WIDER bias spread. The fitted slopes gave the game
//   away by collapsing to 0.36 on BTC, which is noise, not mean reversion.
//
//   ADOPTED - one shared slope in log space plus one multiplicative bias
//   constant per symbol. MAE 6.17, the best of the three, and the
//   cross-sectional bias spread halves from 0.341 to 0.170. SPY's bias goes
//   from 0.845 to 0.997.
//
// The shared part is a regression of log(forward vol) on log(blended vol).
// Log space because vol is strictly positive and roughly lognormal, and a
// slope below one IS mean reversion: extreme readings get pulled toward the
// middle in proportion to how extreme they are. Exponentiating a log fit
// returns a median, so the usual half-residual-variance smearing factor is
// applied to recover the mean, which is what option valuation needs.
//
// The per-symbol constant is the one parameter that matters for a scanner.
// MAE is about accuracy; the bias SPREAD is about whether symbols can be
// compared to each other at all. A forecast biased the same way everywhere
// still ranks correctly. One biased differently per symbol does not - it
// invents premium on the names it runs cold on and hides it on the names it
// runs hot on, which is the single worst failure mode for a cross-sectional
// scanner.
const VOL_BLEND_CURRENT = 0.6;
const VOL_FIT = { a: 0.4433, b: 0.8641, smear: 1.0819 };

// Calibrated at a 24-day horizon. Longer tenors are served by refitting the
// per-symbol constant at the actual horizon, which absorbs most of the
// mismatch; the shared slope is held fixed.
const K_FIT_STEP = 5;
const K_FIT_MIN_POINTS = 40;
const K_CLAMP = [0.6, 1.6];

const sharedForecast = (blendedVol) =>
  Math.exp(VOL_FIT.a + VOL_FIT.b * Math.log(blendedVol)) * VOL_FIT.smear;

// The blended input: current vol at the option's tenor, pulled toward the
// one-year level. Short histories have nothing to revert to and use current
// alone.
function blendedVol(bars, horizonTradingDays) {
  const window = Math.max(10, Math.min(90, horizonTradingDays));
  const rvClose = realizedVol(bars, window);
  const rvPark = parkinsonVol(bars, window);
  const current =
    rvClose != null && rvPark != null ? (rvClose + rvPark) / 2 : (rvClose ?? rvPark);
  if (!(current > 0)) return null;
  const longRun = realizedVol(bars, 252);
  return {
    current,
    longRun: longRun > 0 ? longRun : null,
    blend: longRun > 0 ? current * VOL_BLEND_CURRENT + longRun * (1 - VOL_BLEND_CURRENT) : current,
  };
}

// Fit this symbol's own bias constant by walking its history and comparing the
// shared forecast against what actually arrived. Subsampled every fifth bar:
// overlapping windows carry almost no extra information per bar, and this runs
// on every scanned symbol.
function fitSymbolBias(bars, horizon) {
  const logs = [];
  for (let t = 600; t + horizon < bars.length; t += K_FIT_STEP) {
    const visible = bars.slice(0, t + 1);
    const b = blendedVol(visible, horizon);
    if (!b) continue;
    const forward = realizedVol(bars.slice(t, t + horizon + 1), horizon - 1);
    if (!(forward > 0)) continue;
    logs.push(Math.log(forward / sharedForecast(b.blend)));
  }
  if (logs.length < K_FIT_MIN_POINTS) return { k: 1, points: logs.length, fitted: false };
  const k = Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length);
  return {
    k: Math.min(K_CLAMP[1], Math.max(K_CLAMP[0], k)),
    points: logs.length,
    fitted: true,
  };
}

export function forwardVolForecast(bars, horizonTradingDays, { symbolBias = null } = {}) {
  const b = blendedVol(bars, horizonTradingDays);
  if (!b) return null;

  // Callers that scan many symbols pass a precomputed bias so the history walk
  // happens once per symbol rather than once per call.
  const bias = symbolBias ?? fitSymbolBias(bars, horizonTradingDays);
  const forecast = sharedForecast(b.blend) * bias.k;

  return {
    forecast: Number(forecast.toFixed(3)),
    current: Number(b.current.toFixed(3)),
    longRun: b.longRun == null ? null : Number(b.longRun.toFixed(3)),
    blend: Number(b.blend.toFixed(3)),
    // Below 1 means this asset's vol runs cooler than the shared fit expects,
    // so the shared forecast would have over-stated it.
    symbolBias: Number(bias.k.toFixed(4)),
    symbolBiasFitted: bias.fitted,
    symbolBiasPoints: bias.points,
    blendWeight: VOL_BLEND_CURRENT,
    anchored: b.longRun != null,
  };
}

// Exposed so a scanner can fit the per-symbol constant once and reuse it
// across strategies and expiries.
export { fitSymbolBias };

// Fitting the constant walks the symbol's whole history, and the three option
// panels plus the scanner all want the same answer for the same symbol. Cached
// on the bar count so it refits when new data arrives and not before.
export async function symbolVolBias(symbol, bars, horizon) {
  return cached(`volbias:${symbol}:${horizon}:${bars.length}`, 3600_000, async () =>
    fitSymbolBias(bars, horizon)
  );
}

// Event risk priced into the chain, detected from the IV term structure.
//
// THE PROBLEM THIS SOLVES. The volatility forecast is built from realised
// price history, so it cannot know that a company reports earnings in nine
// days. When it does not know, implied volatility sits far above the forecast
// and the expectancy model reports that gap as edge. The failure is not
// hypothetical: the first run of the options scanner put NVDA at the top of
// the cash-secured put table at a claimed 46% edge, with earnings inside the
// tenor. That is not mispricing, it is the model being blind to a scheduled
// event - and it surfaces WORST cases FIRST, because the bigger the event the
// bigger the phantom edge.
//
// WHY NOT AN EARNINGS FEED. Yahoo's calendar endpoint now requires a session
// crumb and returns 401 to a plain request, and a hard-coded earnings calendar
// goes stale silently. More importantly, a date is the wrong primitive: it
// misses FOMC meetings, OPEC decisions, index rebalances and trial results,
// and it says nothing about how much the move is worth. What matters is not
// whether an event is scheduled but whether the market has PRICED one, and the
// chain already says so.
//
// HOW. Forward implied variance between consecutive expiries isolates the
// volatility the market is pricing for just that interval:
//
//     fwdVar(T1->T2) = (iv2^2 * T2 - iv1^2 * T1) / (T2 - T1)
//
// An interval whose forward vol spikes above the rest of the term is the
// market pointing at a date. Measured on 2026-11-09 against the expiries
// inside a 38-day tenor:
//
//     NVDA   2.52x   118.6% forward IV over 11-16 -> 11-18   (reports 11-18)
//     AVGO   1.63x    78.5% forward IV over 12-04 -> 12-11   (reports ~12-10)
//     XLE    1.52x    52.1% forward IV over 11-18 -> 11-20
//     ...
//     SPY    1.21x
//     TLT    1.06x
//
// It flagged 2 of 11 single names, which is the correct count rather than a
// miss: the other nine had already reported, so their next earnings falls
// outside the tenor. The two it caught are exactly the two that do not, and
// the windows match their reporting dates.
//
// LIMITS, STATED PLAINLY. This detects event premium LARGE ENOUGH to stand out
// of the term structure, not every scheduled event. Singles run a median kink
// of 1.27x and broad ETFs 1.16x, so the two populations overlap heavily and no
// threshold separates them cleanly. A small earnings premium will pass
// through. The threshold is set where the measured populations separate
// without false positives rather than where it would catch everything,
// because a detector that fires on SPY every month would simply be switched
// off.
const EVENT_KINK_THRESHOLD = 1.5;
const EVENT_MIN_GAP_DAYS = 2;

export function termStructureEvent(chain, targetDte, { threshold = EVENT_KINK_THRESHOLD } = {}) {
  const rows = chain.expiries
    .filter((e) => e.dte >= 1 && e.dte <= targetDte + 2 && (e.calls?.length ?? 0) >= 6)
    .map((e) => ({ expiry: e.expiry, dte: e.dte, iv: atmImpliedVol(e.calls, chain.spot) }))
    .filter((e) => e.iv != null)
    .sort((a, b) => a.dte - b.dte);
  if (rows.length < 4) return null;

  const intervals = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    const gap = b.dte - a.dte;
    // A one-day forward vol is not a tradeable observation and the variance
    // difference over a single day is numerically unstable.
    if (gap < EVENT_MIN_GAP_DAYS) continue;
    const t1 = a.dte / 365;
    const t2 = b.dte / 365;
    const v = ((b.iv / 100) ** 2 * t2 - (a.iv / 100) ** 2 * t1) / (t2 - t1);
    // Negative forward variance means a downward-sloping term structure
    // steeper than arbitrage allows, which is a quote artefact, not a signal.
    if (!(v > 0)) continue;
    intervals.push({ from: a.expiry, to: b.expiry, gapDays: gap, forwardIv: Number((Math.sqrt(v) * 100).toFixed(2)) });
  }
  if (intervals.length < 3) return null;

  // Median rather than mean: one enormous interval would drag a mean upward
  // and hide itself.
  const sorted = intervals.map((i) => i.forwardIv).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return null;
  const worst = intervals.reduce((m, i) => (i.forwardIv > m.forwardIv ? i : m));
  const ratio = worst.forwardIv / median;

  return {
    detected: ratio >= threshold,
    ratio: Number(ratio.toFixed(2)),
    threshold,
    medianForwardIv: Number(median.toFixed(2)),
    window: { from: worst.from, to: worst.to, forwardIv: worst.forwardIv, gapDays: worst.gapDays },
    intervals: intervals.length,
    note:
      ratio >= threshold
        ? `The market is pricing ${worst.forwardIv.toFixed(0)}% volatility for ${worst.from} to ${worst.to} ` +
          `against ${median.toFixed(0)}% across the rest of the term - ${ratio.toFixed(2)}x. Something is ` +
          `scheduled in that window. The volatility forecast here is built from price history and cannot see ` +
          `it, so any edge it reports on this chain is contaminated by event premium rather than earned.`
        : `No event-sized kink in the term structure up to this expiry (worst interval ${ratio.toFixed(2)}x the ` +
          `median, threshold ${threshold}x). A small earnings premium can still hide below this.`,
  };
}

// Implied vol at the money, interpolated between the two strikes straddling
// spot. Deep in- and out-of-the-money contracts carry unreliable IV, so the
// ATM pair is the honest read on the expiry's overall level.
export function atmImpliedVol(calls, spot) {
  const usable = calls.filter((c) => c.iv != null && c.iv > 0.01 && c.iv < 5);
  if (usable.length < 2) return null;
  const below = usable.filter((c) => c.strike <= spot).at(-1);
  const above = usable.find((c) => c.strike > spot);
  if (!below && !above) return null;
  if (!below) return above.iv * 100;
  if (!above) return below.iv * 100;
  const span = above.strike - below.strike;
  if (span <= 0) return below.iv * 100;
  const w = (spot - below.strike) / span;
  return (below.iv * (1 - w) + above.iv * w) * 100;
}

// Volatility indices with free history, mapped to the asset classes they
// actually describe. There is no free per-symbol IV history, so this gives
// asset-class context instead of pretending to be an IV rank.
const VOL_INDEX = {
  equity_index: { symbol: '^VIX', label: 'VIX' },
  equity_single: { symbol: '^VIX', label: 'VIX' },
  precious_metal: { symbol: '^GVZ', label: 'Gold VIX (GVZ)' },
  energy: { symbol: '^OVX', label: 'Oil VIX (OVX)' },
  bond: { symbol: '^VIX', label: 'VIX' },
};

export async function volIndexContext(profileKey) {
  const spec = VOL_INDEX[profileKey];
  if (!spec) return null;
  try {
    const closes = await fetchDailyCloses(spec.symbol, 2);
    const values = Object.keys(closes).sort().map((k) => closes[k]);
    if (values.length < 60) return null;
    const now = values.at(-1);
    return {
      label: spec.label,
      value: Number(now.toFixed(2)),
      percentile: Math.round(percentileRank(values, now)),
      lookback: `${values.length} sessions`,
    };
  } catch {
    return null;
  }
}

// How often, historically, has this asset risen by `thresholdPct` within
// `horizonDays`? Two versions, because they answer different questions:
//   finishAbove - assignment risk at expiry
//   everTouched - management risk before expiry (an American call can be
//                 assigned early, and a strike that gets touched forces a
//                 decision even when it settles back)
//
// This is UNCONDITIONAL: it pools every regime in the history, so it is a base
// rate rather than a forecast. It is still more honest than a lognormal
// assumption, because it carries the asset's real fat tails.
// `direction` is 'up' for a call seller (how often does it rally past the
// strike) and 'down' for a put seller (how often does it fall through).
// thresholdPct is signed to match: +12 for a call 12% out, -12 for a put.
export function historicalBreach(bars, thresholdPct, horizonDays, direction = 'up') {
  if (bars.length < horizonDays + 120) return null;
  const up = direction === 'up';
  let windows = 0;
  let finished = 0;
  let touched = 0;

  for (let i = 0; i + horizonDays < bars.length; i++) {
    const start = bars[i].close;
    if (!start) continue;
    const target = start * (1 + thresholdPct / 100);
    windows++;
    const end = bars[i + horizonDays].close;
    if (up ? end >= target : end <= target) finished++;
    for (let j = i + 1; j <= i + horizonDays; j++) {
      // The extreme that matters differs by side: a call is threatened by the
      // high, a put by the low.
      if (up ? bars[j].high >= target : bars[j].low <= target) { touched++; break; }
    }
  }

  if (windows < 100) return null;
  const beyond = Number(((100 * finished) / windows).toFixed(1));
  return {
    windows,
    direction,
    finishBeyond: beyond,
    // Kept for the call-side callers that read it by name.
    finishAbove: beyond,
    everTouched: Number(((100 * touched) / windows).toFixed(1)),
  };
}

// Mark strikes that are not meaningfully separated from the best one.
//
// The component weights in these panels are hand-chosen, not fitted to
// outcomes. A sensitivity run - re-scoring with each weight jittered at
// random - shows the consequence: at a 15% wobble the covered-call top pick
// survives 97% of trials, but the put top pick survives only 69%, because
// adjacent put strikes score within a point or two of each other. The region
// is robust; the single winner is not.
//
// Presenting one strike as "the pick" when four are statistically
// indistinguishable is false precision, so they are flagged as a tied band
// and the UI says so.
export function markTies(rows, window = 4) {
  if (!rows.length) return rows;
  const top = rows[0].score;
  let tied = 0;
  for (const r of rows) {
    r.tiedWithBest = r.score >= top - window;
    if (r.tiedWithBest) tied++;
  }
  for (const r of rows) r.tiedCount = tied;
  return rows;
}

// Equity puts almost always carry richer implied volatility than equidistant
// calls - people pay up for crash protection. Measuring that skew tells a put
// seller whether they are being paid extra for the same distance, which is the
// whole reason put selling can out-earn call selling on the same underlying.
export function putSkew(expiry, spot) {
  const pick = (list, side) => {
    const target = side === 'put' ? spot * 0.93 : spot * 1.07;
    const usable = list.filter((c) => c.iv != null && c.iv > 0.01 && c.iv < 5);
    if (!usable.length) return null;
    return usable.reduce((best, c) =>
      Math.abs(c.strike - target) < Math.abs(best.strike - target) ? c : best
    );
  };
  const p = pick(expiry.puts || [], 'put');
  const c = pick(expiry.calls || [], 'call');
  if (!p || !c) return null;

  const putIv = p.iv * 100;
  const callIv = c.iv * 100;
  return {
    putIv: Number(putIv.toFixed(1)),
    callIv: Number(callIv.toFixed(1)),
    putStrike: p.strike,
    callStrike: c.strike,
    skewPoints: Number((putIv - callIv).toFixed(1)),
    note:
      putIv - callIv > 4
        ? 'Puts are priced materially richer than equidistant calls - the downside is where the fear premium sits, and selling it is paid better than selling upside.'
        : putIv - callIv < -2
          ? 'Unusually, calls are richer than puts here. That inverted skew normally shows up in a squeeze or a takeover bid, and it argues for selling upside rather than downside.'
          : 'Skew is close to flat, so puts carry no meaningful premium advantage over calls on this name.',
  };
}

// The one-standard-deviation move the option market is pricing for this tenor.
export function expectedMove(spot, ivPct, dte) {
  if (!spot || !ivPct || !dte) return null;
  const sigma = spot * (ivPct / 100) * Math.sqrt(dte / 365);
  return { oneSigma: sigma, oneSigmaPct: (sigma / spot) * 100 };
}

export async function volatilityProfile({ symbol, chain, expiry, profileKey, bars }) {
  // Daily bars for the option's own underlying, independent of whatever
  // timeframe the chart is showing.
  let daily = bars;
  if (!daily) {
    const series = await fetchSeries(symbol, '1d');
    daily = series.bars;
  }

  const dte = expiry.dte;
  // Match the realised-vol window to the option's tenor so the comparison is
  // like for like.
  const window = Math.max(10, Math.min(90, dte));
  const rvClose = realizedVol(daily, window);
  const rvPark = parkinsonVol(daily, window);
  const rv20 = realizedVol(daily, 20);
  const rv60 = realizedVol(daily, 60);
  const iv = atmImpliedVol(expiry.calls, chain.spot);

  // Blend the two realised estimators; Parkinson is the more efficient of the
  // two but is biased low when moves happen overnight, so neither alone wins.
  const rvBlend = rvClose != null && rvPark != null ? (rvClose + rvPark) / 2 : rvClose ?? rvPark;

  // THE COMPARISON IS AGAINST A FORECAST, NOT THE TRAILING NUMBER.
  //
  // This panel used to divide implied by trailing realised vol, which is what
  // every IV-versus-RV screener does and what the calibration test showed to
  // be wrong: forward realised vol arrives at 1.195x the trailing blend on
  // average, and 1.39x when the trailing reading is in its quietest quintile.
  // Selling an option is a bet on the volatility that is COMING, so trailing
  // vol is the wrong denominator, and it is wrong in the dangerous direction -
  // it flatters premium exactly when markets are calm and about to stop being.
  //
  // forwardVolForecast corrects both the mean-reversion bias and the
  // per-symbol bias. See the block above it for the fit and what it replaced.
  const horizon = tradingDaysFor(dte);
  const vf = forwardVolForecast(daily, horizon, {
    symbolBias: await symbolVolBias(symbol, daily, horizon),
  });
  const forecast = vf?.forecast ?? null;

  const ratio = iv != null && forecast ? iv / forecast : null;
  const premiumPoints = iv != null && forecast != null ? iv - forecast : null;
  // How much the correction moved the answer, so the panel can say when it
  // disagrees with the trailing reading rather than silently overruling it.
  const trailingRatio = iv != null && rvBlend ? iv / rvBlend : null;

  let verdict = 'unknown';
  let verdictDetail = 'Implied volatility could not be read from this chain.';
  if (ratio != null) {
    const forecastNote =
      `Forecast rather than trailing: this asset has run ${rvBlend.toFixed(1)}% over the last ${window} ` +
      `sessions, and the model expects ${forecast.toFixed(1)}% over the option's life` +
      (vf.symbolBiasFitted && Math.abs(vf.symbolBias - 1) > 0.04
        ? ` - its volatility runs ${vf.symbolBias < 1 ? 'cooler' : 'hotter'} than the cross-market average, ` +
          `by a factor fitted on its own history.`
        : '.');

    if (ratio >= 1.25) {
      verdict = 'rich';
      verdictDetail =
        `Options are pricing ${iv.toFixed(1)}% volatility against a ${forecast.toFixed(1)}% forecast for the ` +
        `period they cover. You are being paid ${premiumPoints.toFixed(1)} volatility points above what the ` +
        `asset is expected to deliver - this is the condition premium selling exists for. ${forecastNote}`;
    } else if (ratio >= 1.05) {
      verdict = 'fair';
      verdictDetail =
        `Implied ${iv.toFixed(1)}% against a ${forecast.toFixed(1)}% forecast - a ${premiumPoints.toFixed(1)} point ` +
        `cushion. Positive but thin; strike placement matters more than usual here. ${forecastNote}`;
    } else {
      verdict = 'cheap';
      verdictDetail =
        `Implied ${iv.toFixed(1)}% is at or below the ${forecast.toFixed(1)}% forecast. You would be selling ` +
        `volatility for less than this asset is expected to deliver, which is a negative-expectancy ` +
        `starting point no matter which strike you choose. ${forecastNote}`;
    }

    // The case worth saying out loud: trailing vol and the forecast disagree
    // about whether the premium is worth having at all.
    if (trailingRatio != null && (trailingRatio >= 1.05) !== (ratio >= 1.05)) {
      verdictDetail +=
        ` Note that against the trailing number alone this would read ${trailingRatio.toFixed(2)}x rather than ` +
        `${ratio.toFixed(2)}x - the two disagree here, and the forecast is the one that was calibrated.`;
    }
  }

  return {
    impliedVol: iv == null ? null : Number(iv.toFixed(2)),
    // The forecast is what `ratio` is built on; realizedVol remains the
    // trailing reading, reported for context.
    forecastVol: forecast == null ? null : Number(forecast.toFixed(2)),
    forecastDetail: vf ?? null,
    realizedVol: rvBlend == null ? null : Number(rvBlend.toFixed(2)),
    realizedCloseToClose: rvClose == null ? null : Number(rvClose.toFixed(2)),
    realizedParkinson: rvPark == null ? null : Number(rvPark.toFixed(2)),
    realized20: rv20 == null ? null : Number(rv20.toFixed(2)),
    realized60: rv60 == null ? null : Number(rv60.toFixed(2)),
    window,
    horizon,
    ratio: ratio == null ? null : Number(ratio.toFixed(2)),
    trailingRatio: trailingRatio == null ? null : Number(trailingRatio.toFixed(2)),
    premiumPoints: premiumPoints == null ? null : Number(premiumPoints.toFixed(2)),
    verdict,
    verdictDetail,
    expectedMove: expectedMove(chain.spot, iv, dte),
    volIndex: await volIndexContext(profileKey),
    dailyBars: daily,
  };
}
