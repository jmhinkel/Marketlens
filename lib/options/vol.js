// Volatility measurement for premium selling.
//
// The central question for a call seller is not "is volatility high" but "is
// the volatility being SOLD higher than the volatility the asset actually
// delivers". That spread - the variance risk premium - is the edge. Everything
// here exists to measure it.
import { fetchDailyCloses, fetchSeries } from '../data/yahoo.js';
import { percentileRank } from '../ta/indicators.js';

const TRADING_DAYS = 252;

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
  const ratio = iv != null && rvBlend ? iv / rvBlend : null;
  const premiumPoints = iv != null && rvBlend != null ? iv - rvBlend : null;

  let verdict = 'unknown';
  let verdictDetail = 'Implied volatility could not be read from this chain.';
  if (ratio != null) {
    if (ratio >= 1.25) {
      verdict = 'rich';
      verdictDetail =
        `Options are pricing ${iv.toFixed(1)}% volatility while the asset has actually delivered ` +
        `${rvBlend.toFixed(1)}% over the last ${window} sessions. You are being paid ` +
        `${premiumPoints.toFixed(1)} volatility points above realised - this is the condition premium selling exists for.`;
    } else if (ratio >= 1.05) {
      verdict = 'fair';
      verdictDetail =
        `Implied ${iv.toFixed(1)}% against realised ${rvBlend.toFixed(1)}% - a ${premiumPoints.toFixed(1)} point ` +
        `cushion. Positive but thin; strike placement matters more than usual here.`;
    } else {
      verdict = 'cheap';
      verdictDetail =
        `Implied ${iv.toFixed(1)}% is at or below realised ${rvBlend.toFixed(1)}%. You would be selling ` +
        `volatility for less than this asset has actually been delivering, which is a negative-expectancy ` +
        `starting point no matter which strike you choose.`;
    }
  }

  return {
    impliedVol: iv == null ? null : Number(iv.toFixed(2)),
    realizedVol: rvBlend == null ? null : Number(rvBlend.toFixed(2)),
    realizedCloseToClose: rvClose == null ? null : Number(rvClose.toFixed(2)),
    realizedParkinson: rvPark == null ? null : Number(rvPark.toFixed(2)),
    realized20: rv20 == null ? null : Number(rv20.toFixed(2)),
    realized60: rv60 == null ? null : Number(rv60.toFixed(2)),
    window,
    ratio: ratio == null ? null : Number(ratio.toFixed(2)),
    premiumPoints: premiumPoints == null ? null : Number(premiumPoints.toFixed(2)),
    verdict,
    verdictDetail,
    expectedMove: expectedMove(chain.spot, iv, dte),
    volIndex: await volIndexContext(profileKey),
    dailyBars: daily,
  };
}
