// Black-Scholes pricing, implied-volatility inversion and greeks.
//
// WHY THIS EXISTS
//
// Until November 2026 the app never priced an option: CBOE's public feed
// shipped implied vol and greeks per contract and we took them. Then CBOE
// moved that feed behind Cloudflare and it stopped answering. The replacement,
// Nasdaq's public chain JSON, carries bid, ask, volume, open interest, strike
// and expiry - and no implied volatility and no greeks at all.
//
// Everything in this app's options work is built on implied vol. The variance
// risk premium gate compares it to a forecast, the expected move is derived
// from it, and the term-structure earnings detector reads forward variance
// between expiries. Without IV there is no options product. So it has to be
// recovered from the one thing Nasdaq does give: the price.
//
// That is a solved problem, not a workaround. An option price and an implied
// volatility are the same number in different units - the Black-Scholes
// formula is the dictionary, and inverting it is what "implied" means. CBOE
// was doing exactly this before handing us the result.
//
// WHAT IS DIFFERENT FROM THE CBOE NUMBERS
//
//   * These are European-style formulas applied to American-style equity
//     options. For calls on non-dividend-paying underlyings the two agree
//     exactly. For puts, and for anything paying a dividend, early exercise
//     carries real value this ignores, so deep in-the-money puts will be
//     slightly mispriced. The panels trade out-of-the-money contracts almost
//     exclusively, where the error is small.
//   * No dividend yield is modelled. On a high-yield name this biases call IV
//     down and put IV up a little.
//   * IV is inverted from the MID price. A wide market therefore produces a
//     vague IV, which is the honest result - and the liquidity gates already
//     reject contracts whose spread is wider than 15%.
//
// Every one of those is a known, bounded approximation rather than a guess,
// and tools/validate-greeks.mjs checks the inversion round-trips.
const SQRT_2PI = Math.sqrt(2 * Math.PI);

// Abramowitz & Stegun 26.2.17 - accurate to about 7.5e-8, far beyond what
// option quotes justify.
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = Math.exp((-x * x) / 2) / SQRT_2PI;
  const p =
    1 -
    d * t * (1.330274429 * t ** 4 - 1.821255978 * t ** 3 + 1.781477937 * t ** 2 - 0.356563782 * t + 0.319381530);
  return x >= 0 ? p : 1 - p;
}

const normPdf = (x) => Math.exp((-x * x) / 2) / SQRT_2PI;

// S spot, K strike, T years, r risk-free (decimal), v vol (decimal), q yield.
function d1d2(S, K, T, r, v, q = 0) {
  const sqrtT = Math.sqrt(T);
  const a = v * sqrtT;
  const d1 = (Math.log(S / K) + (r - q + (v * v) / 2) * T) / a;
  return [d1, d1 - a];
}

export function bsPrice(S, K, T, r, v, isCall, q = 0) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(v > 0)) {
    // At expiry, or with no volatility, the option is worth its intrinsic.
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    return intrinsic;
  }
  const [d1, d2] = d1d2(S, K, T, r, v, q);
  const dfR = Math.exp(-r * T);
  const dfQ = Math.exp(-q * T);
  return isCall
    ? S * dfQ * normCdf(d1) - K * dfR * normCdf(d2)
    : K * dfR * normCdf(-d2) - S * dfQ * normCdf(-d1);
}

export function bsGreeks(S, K, T, r, v, isCall, q = 0) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(v > 0)) {
    return { delta: null, gamma: null, theta: null, vega: null };
  }
  const [d1, d2] = d1d2(S, K, T, r, v, q);
  const dfR = Math.exp(-r * T);
  const dfQ = Math.exp(-q * T);
  const sqrtT = Math.sqrt(T);
  const pdf = normPdf(d1);

  const delta = isCall ? dfQ * normCdf(d1) : dfQ * (normCdf(d1) - 1);
  const gamma = (dfQ * pdf) / (S * v * sqrtT);
  // Per CALENDAR DAY, which is the convention the panels display and the one
  // CBOE used, so the numbers stay comparable to what was there before.
  const thetaYear = isCall
    ? -(S * dfQ * pdf * v) / (2 * sqrtT) - r * K * dfR * normCdf(d2) + q * S * dfQ * normCdf(d1)
    : -(S * dfQ * pdf * v) / (2 * sqrtT) + r * K * dfR * normCdf(-d2) - q * S * dfQ * normCdf(-d1);
  // Per 1 percentage point of vol, again matching the usual convention.
  const vega = (S * dfQ * pdf * sqrtT) / 100;

  return { delta, gamma, theta: thetaYear / 365, vega };
}

// Invert for implied volatility.
//
// Newton's method alone is not safe here: vega collapses toward zero far from
// the money, and a near-zero derivative sends the iteration anywhere. So this
// brackets first and uses bisection, which cannot diverge, and only then
// polishes with Newton where vega is healthy. Slower than pure Newton and
// immune to the failure that matters.
export function impliedVol(price, S, K, T, r, isCall, q = 0) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;

  // A price below intrinsic or above the underlying is not invertible - it is
  // a stale or crossed quote, and returning a number for it would be fiction.
  const dfR = Math.exp(-r * T);
  const dfQ = Math.exp(-q * T);
  const intrinsic = isCall
    ? Math.max(0, S * dfQ - K * dfR)
    : Math.max(0, K * dfR - S * dfQ);
  const upper = isCall ? S * dfQ : K * dfR;
  if (price < intrinsic - 1e-8 || price > upper) return null;

  let lo = 1e-4;
  let hi = 5; // 500% vol; anything beyond is a broken quote, not a signal
  const pLo = bsPrice(S, K, T, r, lo, isCall, q);
  const pHi = bsPrice(S, K, T, r, hi, isCall, q);
  // At or below the price implied by a near-zero volatility, the quote is all
  // intrinsic. There is no time value to invert, so there is no implied vol -
  // returning the bottom of the bracket here would hand back a confident
  // 0.01% that is purely an artefact of where the search started.
  if (price <= pLo) return null;
  if (price >= pHi) return null; // off the top of the bracket

  let v = 0;
  for (let i = 0; i < 100; i++) {
    v = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, v, isCall, q);
    if (Math.abs(p - price) < 1e-8 || hi - lo < 1e-7) break;
    if (p < price) lo = v;
    else hi = v;
  }

  // Polish, but only where vega is large enough for the step to be meaningful.
  for (let i = 0; i < 12; i++) {
    const p = bsPrice(S, K, T, r, v, isCall, q);
    const diff = p - price;
    if (Math.abs(diff) < 1e-10) break;
    const vega = bsGreeks(S, K, T, r, v, isCall, q).vega * 100;
    if (!(vega > 1e-6)) break;
    const next = v - diff / vega;
    if (!(next > 0) || next > 5) break;
    v = next;
  }

  if (!(v > 0) || v >= 5) return null;

  // IDENTIFIABILITY. A deep in-the-money contract is worth its intrinsic value
  // and almost nothing else: at S=25, K=18, 7 days, every volatility from 0.01%
  // to 200% prices it within a rounding error of the same number. The solver
  // converges happily and returns whichever end of the bracket it drifted to,
  // which looks like an answer and is noise.
  //
  // Vega is exactly the measure of how much the price knows about volatility,
  // so when it is negligible the honest return is null. The alternative - a
  // confident 0.01% IV - would poison the ATM interpolation, the variance risk
  // premium gate and the forward-variance event detector, all of which average
  // across strikes and have no way to tell a real low reading from a
  // meaningless one.
  const { vega } = bsGreeks(S, K, T, r, v, isCall, q);
  if (!(vega > 1e-4)) return null;

  return v;
}
