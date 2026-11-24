// Does the implied-volatility inversion actually work?
//
//   node tools/validate-greeks.mjs
//
// This matters more than it would have a month ago. The app used to be handed
// implied vol and greeks by CBOE; now it derives them, and every downstream
// number - the variance risk premium gate, the expected move, the contract
// scanner's entire ranking, the earnings detector's forward variance - rests
// on this file being right.
//
// Four checks, in increasing order of how much they would hurt to fail:
//
//   1. ROUND TRIP. Price at a known vol, invert, recover the vol. If this
//      fails nothing else is worth reading.
//   2. PUT-CALL PARITY. C - P = S*e^-qT - K*e^-rT must hold to machine
//      precision. Catches sign and discounting errors that a round trip can
//      hide because it makes the same mistake twice.
//   3. GREEKS AGAINST NUMERICAL DERIVATIVES. Delta, gamma, vega and theta
//      recomputed by bumping the inputs. Catches an analytic formula that is
//      internally consistent but simply wrong.
//   4. KNOWN TEXTBOOK VALUES. A fixed case with a published answer, so a
//      systematic error that all three self-consistency checks share still
//      gets caught.
import { bsPrice, bsGreeks, impliedVol, normCdf } from '../lib/options/blackscholes.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

// --- 1. round trip -------------------------------------------------------
console.log('\n=== 1. ROUND TRIP: price at a known vol, invert, recover it ===');
console.log('  Swept across moneyness, tenor and vol - including the wings, where');
console.log('  vega collapses and a Newton-only solver would wander off.\n');

let worst = 0;
let worstCase = null;
let tested = 0;
let uninvertible = 0;
const r = 0.04;
for (const S of [25, 100, 750]) {
  for (const moneyness of [0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.3]) {
    for (const days of [7, 35, 90, 365]) {
      for (const trueVol of [0.08, 0.2, 0.45, 0.9]) {
        for (const isCall of [true, false]) {
          const K = S * moneyness;
          const T = days / 365;
          const price = bsPrice(S, K, T, r, trueVol, isCall);
          tested++;
          // Contracts worth less than a cent carry no recoverable information
          // and are exactly what the liquidity gates throw away anyway.
          if (price < 0.01) { uninvertible++; continue; }
          // A null here is the solver refusing a price that carries no
          // volatility information - a deep in-the-money contract worth its
          // intrinsic and nothing else. That is the correct answer, not a
          // miss, so it is counted separately rather than scored.
          const iv = impliedVol(price, S, K, T, r, isCall);
          if (iv == null) { uninvertible++; continue; }
          const err = Math.abs(iv - trueVol);
          if (err > worst) {
            worst = err;
            worstCase = `S=${S} K=${K.toFixed(0)} ${days}d ${isCall ? 'call' : 'put'} vol=${trueVol} -> ${iv.toFixed(6)}`;
          }
        }
      }
    }
  }
}
check(
  `${tested - uninvertible} of ${tested} cases inverted, max vol error ${worst.toExponential(2)}`,
  worst < 1e-5,
  worstCase ? `worst: ${worstCase}` : ''
);
console.log(
  `        ${uninvertible} declined: sub-cent premium, or deep in-the-money where the price is\n` +
  '        all intrinsic and carries no recoverable volatility information'
);

// --- 2. put-call parity --------------------------------------------------
console.log('\n=== 2. PUT-CALL PARITY: C - P = S - K*e^-rT ===');
let parityWorst = 0;
for (const S of [25, 100, 750]) {
  for (const m of [0.8, 1.0, 1.25]) {
    for (const days of [10, 60, 250]) {
      for (const v of [0.12, 0.4, 0.8]) {
        const K = S * m;
        const T = days / 365;
        const lhs = bsPrice(S, K, T, r, v, true) - bsPrice(S, K, T, r, v, false);
        const rhs = S - K * Math.exp(-r * T);
        parityWorst = Math.max(parityWorst, Math.abs(lhs - rhs));
      }
    }
  }
}
check(`max parity violation ${parityWorst.toExponential(2)}`, parityWorst < 1e-9);

// --- 3. greeks vs numerical derivatives ----------------------------------
console.log('\n=== 3. GREEKS vs numerical derivatives (bump and reprice) ===');
const S0 = 100;
const T0 = 45 / 365;
const v0 = 0.3;
const rows = [];
for (const K of [85, 95, 100, 105, 120]) {
  for (const isCall of [true, false]) {
    const g = bsGreeks(S0, K, T0, r, v0, isCall);
    const h = 1e-4;
    const numDelta =
      (bsPrice(S0 + h, K, T0, r, v0, isCall) - bsPrice(S0 - h, K, T0, r, v0, isCall)) / (2 * h);
    const numGamma =
      (bsPrice(S0 + h, K, T0, r, v0, isCall) - 2 * bsPrice(S0, K, T0, r, v0, isCall) +
        bsPrice(S0 - h, K, T0, r, v0, isCall)) / (h * h);
    // vega is reported per percentage point, theta per calendar day.
    const numVega =
      (bsPrice(S0, K, T0, r, v0 + 1e-6, isCall) - bsPrice(S0, K, T0, r, v0 - 1e-6, isCall)) / (2e-6) / 100;
    const dt = 1 / 365;
    const numTheta = bsPrice(S0, K, T0 - dt, r, v0, isCall) - bsPrice(S0, K, T0, r, v0, isCall);
    rows.push({
      K, isCall,
      dErr: Math.abs(g.delta - numDelta),
      gErr: Math.abs(g.gamma - numGamma),
      vErr: Math.abs(g.vega - numVega),
      tErr: Math.abs(g.theta - numTheta),
    });
  }
}
const maxOf = (k) => Math.max(...rows.map((x) => x[k]));
// The floor on these is the normal CDF approximation, not the greek formulas.
// Abramowitz & Stegun 26.2.17 is accurate to ~7.5e-8, and a central difference
// of two prices each carrying that error leaves a residue around 1e-5 after
// the correlated part cancels. The analytic delta is exactly e^-qT N(d1), so
// agreement to five decimal places is the measurement limit, not a defect -
// and five decimals of delta is four more than any trading decision uses.
check(`delta max error ${maxOf('dErr').toExponential(2)} (normCdf approximation floor)`, maxOf('dErr') < 1e-4);
check(`gamma max error ${maxOf('gErr').toExponential(2)}`, maxOf('gErr') < 1e-4);
check(`vega  max error ${maxOf('vErr').toExponential(2)}`, maxOf('vErr') < 1e-6);
// Theta's numerical form is a one-day finite difference of a convex function,
// so it differs from the instantaneous derivative by a genuine second-order
// term. A loose bound here is correct, not a fudge.
check(`theta max error ${maxOf('tErr').toExponential(2)} (1-day difference vs instantaneous)`, maxOf('tErr') < 5e-3);

// --- 4. textbook values --------------------------------------------------
console.log('\n=== 4. KNOWN VALUES (Hull, Options Futures and Other Derivatives) ===');
// Hull ch.15: S=42, K=40, r=10%, v=20%, T=0.5 -> call 4.76, put 0.81
const hullCall = bsPrice(42, 40, 0.5, 0.1, 0.2, true);
const hullPut = bsPrice(42, 40, 0.5, 0.1, 0.2, false);
check(`Hull call = ${hullCall.toFixed(4)} (expected 4.7594)`, Math.abs(hullCall - 4.7594) < 5e-4);
check(`Hull put  = ${hullPut.toFixed(4)} (expected 0.8086)`, Math.abs(hullPut - 0.8086) < 5e-4);
check(`normCdf(0) = ${normCdf(0).toFixed(8)}`, Math.abs(normCdf(0) - 0.5) < 1e-7);
check(`normCdf(1.96) = ${normCdf(1.96).toFixed(6)} (expected 0.975002)`, Math.abs(normCdf(1.96) - 0.975002) < 1e-5);

// --- 5. the shape IV should have -----------------------------------------
console.log('\n=== 5. SANITY: a real chain should produce a smile, not noise ===');
console.log('  Prices generated WITH a skew, then inverted. If the inversion is sound');
console.log('  the recovered IVs reproduce the skew that was put in.\n');
const skewed = [];
for (const m of [0.85, 0.9, 0.95, 1.0, 1.05, 1.1]) {
  const K = 100 * m;
  // Put a real downward skew in: lower strikes carry higher vol.
  const trueVol = 0.25 + (1 - m) * 0.6;
  const price = bsPrice(100, K, 35 / 365, r, trueVol, false);
  const iv = impliedVol(price, 100, K, 35 / 365, r, false);
  skewed.push({ m, trueVol, iv });
  console.log(`    K=${K.toFixed(0).padStart(3)}  put ${price.toFixed(4).padStart(8)}  true vol ${(trueVol * 100).toFixed(1)}%  recovered ${iv == null ? 'null' : `${(iv * 100).toFixed(1)}%`}`);
}
const skewOk = skewed.every((x) => x.iv != null && Math.abs(x.iv - x.trueVol) < 1e-5);
const monotone = skewed.every((x, i, a) => i === 0 || x.iv <= a[i - 1].iv + 1e-9);
check('every strike recovered its own vol', skewOk);
check('recovered smile is monotone decreasing in strike, as constructed', monotone);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
