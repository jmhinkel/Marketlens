// Empirical option valuation: what is this contract worth, given what this
// asset has actually done?
//
// WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER SCORE
//
// The covered-call, put and long-call panels each rank strikes with a sum of
// hand-chosen component weights. Those weights were never fitted to outcomes,
// and a sensitivity run showed what that costs: jitter every weight by 15% and
// the put panel's top pick survives only 69% of trials. The setup-score
// backtest was blunter still - 3,725 independent trades, rank correlation
// between score and result of -0.14 on the short side. A number assembled from
// unvalidated weights does not become trustworthy by being computed carefully.
//
// So this module does not score anything. It answers one question with
// arithmetic instead of judgement:
//
//     Is the market paying more for this option than the asset's own
//     behaviour says it is worth?
//
// Everything follows from that. The expected value of writing a contract is
// the premium received minus the option's fair value; for buying it, fair
// value minus the price paid. Expressed per unit of capital committed and
// annualised, that number is directly comparable across strikes, expiries,
// symbols and strategies - which no score ever was.
//
// HOW FAIR VALUE IS BUILT
//
// Not Black-Scholes. Black-Scholes fed with implied volatility returns the
// market price by construction and so can never say the market is wrong, and
// fed with realised volatility it still imposes a lognormal shape that no real
// asset has. Instead the terminal distribution comes from the asset's own
// overlapping N-day returns, with two corrections:
//
//   1. VOLATILITY RESCALED to a FORECAST of the vol over the option's life -
//      not to current realised vol. Scaling to current vol was the first
//      version of this module and it failed its own calibration test: current
//      vol under-forecasts forward vol by 19.5%, so the distribution came out
//      too narrow and under-predicted the probability of finishing in the
//      money in every single band. forwardVolForecast in vol.js carries the
//      measurement and the correction. Rescaling preserves the skew and the
//      fat tails, which are the whole reason to use real history rather than
//      a formula.
//
//   2. DRIFT SET EXPLICITLY. The calibration test found this to be the
//      DOMINANT error term - worth roughly twice what the distribution's
//      shape is worth - so it is a parameter, not a buried constant:
//
//          zero                           4.00 pts of calibration error
//          risk-free (contemporaneous)    2.95 pts
//          8%/yr                          2.00 pts
//          the sample's own drift         1.51 pts  (unattainable)
//
//      Callers pass the risk-free rate, which is what the option market
//      itself discounts at. The better-scoring 8%/yr is refused because it
//      only wins on a sample that rose 16%/yr; adopting it would repeat the
//      exact error the setup-score backtest already caught. The multipliers
//      are centred and divided by their own mean so E[S_T] = S exactly, and
//      the drift is then applied on top as one visible number.
//
//      The honest cost of risk-free drift: in a market that rises, it
//      UNDER-states the chance a short call is breached by around 3 points.
//      That is the optimistic direction for a call writer, and callers are
//      expected to surface it rather than let it pass silently.
//
// WHAT IT STILL CANNOT SEE
//
//   * Overlapping windows share N-1 of their days, so the honest sample size
//     is windows/N, not windows. That is reported as effectiveN and it is
//     small - roughly 100 for a 10-year history at a 35-day tenor.
//   * The vol forecast is unconditional on events. It corrects the average
//     mean-reversion bias, but an earnings date inside the tenor breaks it
//     outright, and nothing here knows about earnings dates. That is the
//     single largest remaining gap.
//   * Early assignment on American options is ignored; this values the
//     contract at expiry.
//   * The distribution is unconditional. It is a base rate, not a forecast.
//   * The empirical SHAPE turned out to be worth very little. Per strike it
//     calibrates at 4.00 pts against 4.20 for a plain lognormal at the same
//     width - inside the noise. Ten years of pooled returns mixes calm and
//     crisis regimes, and the resulting fat tails are largely that mixing
//     rather than a property of any single forward month. The real
//     distribution is kept because it is marginally ahead and because it
//     yields a CVaR measured from actual drawdowns instead of implied by a
//     formula that is known to understate them - not because it prices
//     better. Anyone tempted to add shape sophistication here should read
//     tools/validate-expectancy.mjs first and spend the effort on the drift
//     or the vol forecast instead, which is where the error actually lives.
import { forwardVolForecast, tradingDaysFor } from './vol.js';

const TRADING_DAYS = 252;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Re-exported so callers can keep importing it from here.
export { tradingDaysFor };

// Build the terminal-price multiplier distribution for a horizon of `horizon`
// trading days. Returns null when there is not enough history to be worth
// quoting, rather than a confident answer from thin data.
//
// `volAnnualPct` should be the `forecast` from forwardVolForecast. Callers
// supply it rather than letting this recompute, because the forecast now
// carries a per-symbol bias constant fitted by walking that symbol's history,
// and doing that once per strike instead of once per symbol turns a scan into
// an O(n^2) crawl. Omitting it falls back to fitting inline, which is correct
// but slow.
export function returnDistribution(
  bars,
  horizon,
  { volAnnualPct = null, driftAnnualPct = 0, minWindows = 150 } = {}
) {
  if (!Array.isArray(bars) || !(horizon >= 1)) return null;

  const closes = [];
  for (const b of bars) if (Number.isFinite(b?.close) && b.close > 0) closes.push(b.close);
  if (closes.length < horizon + minWindows) return null;

  const logs = [];
  for (let i = 0; i + horizon < closes.length; i++) {
    logs.push(Math.log(closes[i + horizon] / closes[i]));
  }
  const windows = logs.length;
  if (windows < minWindows) return null;

  const mean = logs.reduce((a, b) => a + b, 0) / windows;
  const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (windows - 1);
  const sampleSd = Math.sqrt(variance);
  if (!(sampleSd > 0)) return null;

  // Rescale the spread of the distribution to the FORECAST vol over the
  // option's life. Clamped: beyond roughly a 2.5x stretch the shape is being
  // asked to describe something it never contained, and a quiet-period sample
  // stretched onto a crisis is not evidence.
  const vf = Number.isFinite(volAnnualPct) && volAnnualPct > 0
    ? { forecast: volAnnualPct, supplied: true }
    : forwardVolForecast(bars, horizon);
  let scale = 1;
  let targetSd = null;
  if (vf && vf.forecast > 0) {
    targetSd = (vf.forecast / 100) * Math.sqrt(horizon / TRADING_DAYS);
    scale = clamp(targetSd / sampleSd, 0.4, 2.5);
  }

  const multipliers = new Float64Array(windows);
  for (let i = 0; i < windows; i++) multipliers[i] = Math.exp((logs[i] - mean) * scale);

  // Force E[S_T] = S. Centring the LOGS leaves the arithmetic mean above one
  // by the usual convexity term; dividing through by the realised mean removes
  // it without touching the shape, so the zero-drift assumption is exact
  // rather than approximate.
  let sum = 0;
  for (const m of multipliers) sum += m;
  const avg = sum / windows;

  // Apply the caller's drift on top of the exactly-neutral distribution, so
  // E[S_T] = S * exp(drift * T) by construction and the assumption is one
  // number rather than an artefact of the sample.
  const driftFactor = Math.exp((driftAnnualPct / 100) * (horizon / TRADING_DAYS));
  const norm = avg / driftFactor;
  for (let i = 0; i < windows; i++) multipliers[i] /= norm;

  const annualise = (sd) => sd * Math.sqrt(TRADING_DAYS / horizon) * 100;
  const rawScale = targetSd == null ? 1 : targetSd / sampleSd;

  return {
    multipliers,
    horizon,
    windows,
    driftAppliedAnnualPct: driftAnnualPct,
    volForecast: vf && !vf.supplied ? vf : null,
    // The number that governs how much to trust any of this.
    effectiveN: Math.max(1, Math.round(windows / horizon)),
    historyYears: Number((closes.length / TRADING_DAYS).toFixed(1)),
    sampleVolAnnualPct: Number(annualise(sampleSd).toFixed(2)),
    targetVolAnnualPct: targetSd == null ? null : Number(annualise(targetSd).toFixed(2)),
    volScale: Number(scale.toFixed(3)),
    volScaleClamped: Math.abs(scale - rawScale) > 1e-9,
    // What the sample itself drifted at, annualised. Reported and NOT used:
    // it is the size of the assumption being refused, so it is visible rather
    // than taken on trust.
    sampleDriftAnnualPct: Number(((Math.exp((mean * TRADING_DAYS) / horizon) - 1) * 100).toFixed(2)),
  };
}

// Expected intrinsic value at expiry under the distribution - the fair value
// of the contract - and the probability it finishes in the money.
export function fairValue(dist, spot, strike, kind) {
  const m = dist.multipliers;
  const n = m.length;
  const call = kind === 'call';
  let sum = 0;
  let itm = 0;
  for (let i = 0; i < n; i++) {
    const intrinsic = call ? spot * m[i] - strike : strike - spot * m[i];
    if (intrinsic > 0) {
      sum += intrinsic;
      itm++;
    }
  }
  return { fair: sum / n, probITM: itm / n };
}

// Tail statistics a score never showed: how bad the bad case is, and how often
// it happens.
function tailStats(payoffs, q = 0.05) {
  const sorted = Float64Array.from(payoffs).sort();
  const n = sorted.length;
  const k = Math.max(1, Math.round(n * q));
  let tail = 0;
  for (let i = 0; i < k; i++) tail += sorted[i];
  let losses = 0;
  for (const p of payoffs) if (p < 0) losses++;
  return { cvar: tail / k, worst: sorted[0], probLoss: losses / n };
}

// --- Writing a contract ---------------------------------------------------
//
// `capital` is what the trade actually ties up: the strike less the premium
// for a cash-secured put, the share price for a covered call. Expressing the
// edge against that is what makes a 4-dollar put on a 40-dollar name
// comparable to a 2-dollar call on a 200-dollar one.
export function shortExpectancy({ dist, spot, strike, premium, kind, capital, dte }) {
  if (!(premium > 0) || !(capital > 0)) return null;
  const { fair, probITM } = fairValue(dist, spot, strike, kind);
  const m = dist.multipliers;
  const n = m.length;
  const call = kind === 'call';

  const payoffs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const intrinsic = call ? Math.max(0, spot * m[i] - strike) : Math.max(0, strike - spot * m[i]);
    payoffs[i] = premium - intrinsic;
  }
  const { cvar, worst, probLoss } = tailStats(payoffs);

  const ev = premium - fair;
  const evPctCapital = (ev / capital) * 100;
  const days = Math.max(dte ?? 1, 1);

  return {
    fairValue: Number(fair.toFixed(4)),
    ev: Number(ev.toFixed(4)),
    // The headline: how much of the premium is genuine edge rather than
    // payment for risk actually borne. Negative means the contract is cheap
    // for what it carries and writing it is a losing proposition.
    edgePctOfPremium: Number(((ev / premium) * 100).toFixed(1)),
    evPctCapital: Number(evPctCapital.toFixed(3)),
    evAnnualPct: Number((evPctCapital * (365 / days)).toFixed(2)),
    probITM: Number(probITM.toFixed(4)),
    probLoss: Number(probLoss.toFixed(4)),
    cvar5PctCapital: Number(((cvar / capital) * 100).toFixed(2)),
    worstPctCapital: Number(((worst / capital) * 100).toFixed(2)),
    // Edge per unit of tail risk accepted. Two writes with the same expected
    // value are not the same trade when one of them can lose 30% of the
    // collateral in the 5% tail.
    evPerTailUnit: cvar < 0 ? Number((ev / Math.abs(cvar)).toFixed(4)) : null,
  };
}

// --- Buying a contract ----------------------------------------------------
export function longExpectancy({ dist, spot, strike, cost, kind, dte }) {
  if (!(cost > 0)) return null;
  const { fair, probITM } = fairValue(dist, spot, strike, kind);
  const m = dist.multipliers;
  const n = m.length;
  const call = kind === 'call';

  const payoffs = new Float64Array(n);
  let profitable = 0;
  for (let i = 0; i < n; i++) {
    const intrinsic = call ? Math.max(0, spot * m[i] - strike) : Math.max(0, strike - spot * m[i]);
    payoffs[i] = intrinsic - cost;
    if (payoffs[i] > 0) profitable++;
  }

  const ev = fair - cost;
  const days = Math.max(dte ?? 1, 1);
  // Upper tail, because for a buyer the interesting asymmetry is the right
  // side: a long call is bought for the 5% of outcomes that pay for the rest.
  const sorted = Float64Array.from(payoffs).sort();
  const k = Math.max(1, Math.round(n * 0.05));
  let best = 0;
  for (let i = n - k; i < n; i++) best += sorted[i];

  return {
    fairValue: Number(fair.toFixed(4)),
    ev: Number(ev.toFixed(4)),
    // Return on the premium risked: +18 means the contract is worth 18% more
    // than it costs under this distribution.
    edgePctOfCost: Number(((ev / cost) * 100).toFixed(1)),
    evAnnualPct: Number((((ev / cost) * 100) * (365 / days)).toFixed(1)),
    probITM: Number(probITM.toFixed(4)),
    probProfit: Number((profitable / n).toFixed(4)),
    upside5PctOfCost: Number(((best / k / cost) * 100).toFixed(1)),
    maxLossPct: 100,
  };
}
