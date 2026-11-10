// The short risk-free rate, used as the drift assumption when valuing options.
//
// This is not a decoration. The calibration test showed the drift assumption
// is the dominant error term in option valuation - worth twice as much as the
// distribution's shape - so it has to be a real number rather than a constant
// somebody typed once:
//
//     drift assumption              per-strike calibration error
//     zero                              4.00 pts
//     risk-free (contemporaneous)       2.95 pts
//     8%/yr                             2.00 pts
//     sample's own realised drift       1.51 pts   (unattainable: backward-looking)
//
// Risk-free is chosen over the better-scoring 8%/yr because 8% only wins on a
// sample that happened to rise 16%/yr. Using it would be the same error the
// setup-score backtest already caught: fitting a forecast to one lucky decade.
// The risk-free rate is what the option market itself discounts at, which
// makes "is this contract mispriced" a question about the contract rather than
// a bet on equities.
import { fetchSeries } from './yahoo.js';
import { treasuryCurve } from './fred.js';
import { cached } from '../cache.js';

// Last-resort value if both sources fail. Deliberately not zero: zero is the
// worst-calibrated assumption of the lot, so a stale-but-plausible short rate
// beats a precise wrong one.
const FALLBACK_PCT = 4.0;

export async function riskFreeRate() {
  return cached('rates:riskfree', 6 * 3600_000, async () => {
    // ^IRX is the 13-week bill discount rate, quoted directly in percent -
    // the same convention as ^TNX, so no division by ten.
    try {
      const series = await fetchSeries('^IRX', '1d');
      const last = [...series.bars].reverse().find((b) => Number.isFinite(b.close));
      if (last && last.close >= 0 && last.close < 25) {
        return {
          annualPct: Number(last.close.toFixed(2)),
          source: 'Yahoo ^IRX (13-week T-bill)',
          asOf: String(last.date).slice(0, 10),
          estimated: false,
        };
      }
    } catch {
      // fall through
    }

    try {
      const curve = await treasuryCurve();
      const latest = curve?.latest ?? (Array.isArray(curve) ? curve.at(-1) : null);
      const y3m = latest?.y3m;
      if (Number.isFinite(y3m) && y3m >= 0 && y3m < 25) {
        return {
          annualPct: Number(y3m.toFixed(2)),
          source: 'US Treasury daily par yield curve (3-month)',
          asOf: latest.date,
          estimated: false,
        };
      }
    } catch {
      // fall through
    }

    return {
      annualPct: FALLBACK_PCT,
      source: 'fallback constant - both rate feeds unavailable',
      asOf: null,
      estimated: true,
    };
  });
}
