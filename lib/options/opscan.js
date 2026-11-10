// Options opportunity scanner: which contract, anywhere in the universe, is
// the market overpaying for?
//
// HOW THIS DIFFERS FROM THE THREE PANELS
//
// The covered-call, put-selling and long-call panels answer "given this
// symbol, which strike?" They rank with a sum of hand-chosen component
// weights, and those weights have never been validated against outcomes -
// jitter them 15% and the put panel's top pick changes 31% of the time. That
// is tolerable when a human has already chosen the symbol and is reading the
// reasoning. It is not tolerable as the basis for ranking sixty symbols
// against each other, because the errors compound instead of cancelling and
// nothing on screen tells you which comparisons are real.
//
// So this scanner does not use those scores. It ranks on expected value from
// lib/options/expectancy.js - premium received minus the contract's fair value
// under the asset's own vol-forecast-scaled return distribution - which is a
// quantity with an observable counterpart and which has been through a
// calibration test. Hard gates come first, ordering second, and the ordering
// metric is money per unit of capital rather than points.
//
// THE GATES, AND WHY EACH ONE IS A GATE RATHER THAN A SCORE COMPONENT
//
// A gate is for a condition where failing it makes the trade bad regardless of
// how good everything else looks. Those must not be tradeable against other
// factors, which is exactly what a weighted sum does.
//
//   VARIANCE RISK PREMIUM. Writing options when implied sits below realised is
//   negative expectancy before strike selection begins. No amount of good
//   structure fixes it. Gate, not a deduction.
//
//   LIQUIDITY. A 40%-wide bid-ask destroys more than the entire measured edge
//   on most of these contracts. Edge computed off a mid you cannot trade at is
//   fiction.
//
//   SAMPLE ADEQUACY. Overlapping windows share all but one of their days, so
//   the honest sample size is windows/horizon. Below about 40 effective
//   observations the fair value is too noisy to rank on.
//
//   EXPECTED VALUE ITSELF. A contract whose premium is below its fair value is
//   not a weak opportunity, it is a bad trade. It never ranks.
//
//   EVENT PREMIUM. The volatility forecast is built from price history and
//   cannot see a scheduled earnings date. When it cannot, implied vol sits far
//   above the forecast and the model reports the gap as edge - and because the
//   gap scales with the size of the event, the contaminated names sort to the
//   TOP. The first run of this scanner put NVDA first at a claimed 46% edge
//   with earnings inside the tenor. termStructureEvent in vol.js reads the
//   event out of the chain's own term structure, and anything it flags is held
//   out of the ranking and listed separately rather than dropped silently -
//   the premium is real, it is just not free, and that is the user's call to
//   make with the date in front of them.
import { fetchChain, pickExpiry } from '../data/cboe.js';
import { riskFreeRate } from '../data/rates.js';
import { fetchSeries } from '../data/yahoo.js';
import { runAnalysis } from '../analyze.js';
import { cached } from '../cache.js';
import { atmImpliedVol, forwardVolForecast, symbolVolBias, putSkew, termStructureEvent } from './vol.js';
import {
  returnDistribution, shortExpectancy, longExpectancy, tradingDaysFor,
} from './expectancy.js';

// Only instruments with listed US options. Futures and FX are excluded by
// construction rather than discovered by a failed request, which saves a
// round trip per symbol on every scan.
export const OPTION_UNIVERSES = {
  liquid: {
    label: 'Liquid',
    note:
      'Index, sector and commodity ETFs plus megacap single names - the chains with the ' +
      'tightest spreads and the deepest open interest, where measured edge survives execution.',
    symbols: [
      'SPY', 'QQQ', 'IWM', 'DIA', 'EEM', 'EFA', 'FXI', 'EWZ',
      'XLE', 'XLF', 'XLI', 'XLK', 'XLV', 'XLU', 'XLP', 'XLY', 'XLB',
      'SMH', 'KRE', 'XBI', 'ARKK',
      'GLD', 'SLV', 'GDX', 'GDXJ', 'COPX', 'USO', 'UNG',
      'TLT', 'IEF', 'HYG', 'LQD',
      'IBIT', 'MSTR',
      'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'XOM',
    ],
  },
  etf: {
    label: 'ETFs only',
    note:
      'No single names, so no earnings dates inside the tenor - which is the one risk the ' +
      'volatility forecast genuinely cannot see.',
    symbols: [
      'SPY', 'QQQ', 'IWM', 'DIA', 'EEM', 'EFA', 'FXI', 'EWZ', 'EWJ',
      'XLE', 'XLF', 'XLI', 'XLK', 'XLV', 'XLU', 'XLP', 'XLY', 'XLB', 'XLRE',
      'SMH', 'KRE', 'XBI', 'ITB', 'ARKK',
      'GLD', 'SLV', 'GDX', 'GDXJ', 'COPX', 'CPER', 'USO', 'UNG', 'DBA',
      'TLT', 'IEF', 'HYG', 'LQD', 'IBIT',
    ],
  },
  vaneck: {
    label: 'VanEck',
    note:
      'The VanEck funds that carry listed options with usable chains. Most of the income ' +
      'sleeve has no options market at all, so this list is much shorter than the chart scanner.',
    symbols: ['GDX', 'GDXJ', 'SMH', 'OIH', 'MOAT', 'REMX', 'ESPO', 'BBH', 'PPH', 'MOO', 'ANGL', 'BIZD', 'MORT', 'HYD'],
  },
};

export const STRATEGIES = {
  covered: {
    label: 'Covered calls',
    side: 'write',
    kind: 'call',
    targetDte: 35,
    // Writing upside. Needs implied above realised to be worth doing at all.
    requireRichVol: true,
    blurb: 'Writing calls against stock you own. Ranked by expected value per dollar of stock committed.',
  },
  puts: {
    label: 'Cash-secured puts',
    side: 'write',
    kind: 'put',
    targetDte: 35,
    requireRichVol: true,
    blurb: 'Writing puts with cash set aside. Ranked by expected value per dollar of collateral.',
  },
  longcalls: {
    label: 'Long calls',
    side: 'buy',
    kind: 'call',
    targetDte: 60,
    // Buying. The gate inverts: you want to be paying BELOW realised vol.
    requireRichVol: false,
    blurb: 'Buying calls outright. Ranked by expected value per dollar of premium risked.',
  },
};

// --- gate thresholds ------------------------------------------------------
//
// Each of these rejects rather than deducts, for the reasons in the header.
const GATES = {
  // Implied must exceed forecast realised by this ratio to write. Not 1.0:
  // at parity the writer earns nothing for the gamma risk and the tail, and
  // the forecast itself carries error.
  minWriteIvRatio: 1.05,
  // To buy, implied must sit at or below forecast realised.
  maxBuyIvRatio: 1.00,
  minEffectiveN: 40,
  // Sample adequacy AT THE CONTRACT, not just at the symbol. A contract's
  // fair value is an average over the windows that finished in the money, so
  // what matters is how many of those there were - probITM * effectiveN, not
  // effectiveN. Without this gate the long-call table filled with deep
  // out-of-the-money lottery tickets: an SLV call 39% out of the money
  // claimed a 166% edge off roughly FOUR in-the-money observations, because a
  // couple of historical silver spikes set the entire fair value. Eight is
  // still thin; below it the number is not an estimate of anything.
  minItmObservations: 8,
  maxSpreadPct: 15,
  minOpenInterest: 50,
  minBid: 0.10,
  // Delta band. Outside roughly 8-40 delta a write is either unpaid for the
  // risk or simply a synthetic position in the underlying.
  writeDelta: [0.08, 0.42],
  // Positive expected value, with a small buffer so contracts that are only
  // nominally positive do not crowd the table.
  minWriteEvAnnualPct: 1.0,
  minBuyEdgePct: 5.0,
};

const pct = (v) => Number(v.toFixed(2));

// Evaluate every tradeable strike in one expiry for one strategy, and return
// the best few by expected value. Returns a gate verdict when nothing passes,
// because "why did my symbol not appear" is the question a scanner has to be
// able to answer.
function evaluateChain({ strategy, chain, expiry, dist }) {
  const spec = STRATEGIES[strategy];
  const spot = chain.spot;
  const dte = Math.max(expiry.dte, 1);
  const writing = spec.side === 'write';
  const contracts = spec.kind === 'call' ? expiry.calls : expiry.puts;
  const rejected = { moneyness: 0, liquidity: 0, delta: 0, thinTail: 0, ev: 0 };
  // How many of the distribution's independent observations finished beyond
  // this strike. Below the gate the fair value is an average over too few
  // events to rank on.
  const itmObs = (probITM) => probITM * dist.effectiveN;

  const rows = [];
  for (const c of contracts || []) {
    // Out of the money only. In-the-money writes are a different trade with a
    // different risk profile and do not belong in the same ranking.
    const otm = spec.kind === 'call' ? c.strike > spot : c.strike < spot;
    if (!otm) continue;

    const distancePct = Math.abs((c.strike - spot) / spot) * 100;
    if (distancePct > 40) { rejected.moneyness++; continue; }

    // Writers receive the bid; buyers pay the ask. Using the mid for either
    // overstates the edge by half the spread, which on these contracts is
    // frequently larger than the edge itself.
    const price = writing ? c.bid : c.ask;
    if (!(price > 0) || price < GATES.minBid) { rejected.liquidity++; continue; }

    const spreadPct =
      c.bid > 0 && c.ask > 0 ? ((c.ask - c.bid) / ((c.ask + c.bid) / 2)) * 100 : null;
    if (spreadPct == null || spreadPct > GATES.maxSpreadPct) { rejected.liquidity++; continue; }
    if (!(c.openInterest >= GATES.minOpenInterest)) { rejected.liquidity++; continue; }

    const absDelta = c.delta == null ? null : Math.abs(c.delta);
    if (writing && absDelta != null) {
      if (absDelta < GATES.writeDelta[0] || absDelta > GATES.writeDelta[1]) { rejected.delta++; continue; }
    }

    if (writing) {
      // Capital committed: the collateral for a put, the shares for a call.
      const capital = spec.kind === 'put' ? c.strike - price : spot;
      const e = shortExpectancy({
        dist, spot, strike: c.strike, premium: price, kind: spec.kind, capital, dte,
      });
      if (!e) { rejected.ev++; continue; }
      if (itmObs(e.probITM) < GATES.minItmObservations) { rejected.thinTail++; continue; }
      if (e.evAnnualPct < GATES.minWriteEvAnnualPct) { rejected.ev++; continue; }

      rows.push({
        occ: c.occ, strike: c.strike, kind: spec.kind,
        distancePct: pct(distancePct),
        bid: c.bid, ask: c.ask, spreadPct: pct(spreadPct),
        openInterest: c.openInterest, volume: c.volume,
        iv: c.iv == null ? null : pct(c.iv * 100),
        delta: c.delta == null ? null : Number(c.delta.toFixed(3)),
        premium: price,
        capital: pct(capital),
        // Headline ranking metric.
        evAnnualPct: e.evAnnualPct,
        evPctCapital: e.evPctCapital,
        edgePctOfPremium: e.edgePctOfPremium,
        fairValue: e.fairValue,
        // What the market pays versus what the risk is worth, side by side -
        // the whole argument for the trade in two numbers.
        marketPremium: price,
        probITM: pct(e.probITM * 100),
        probLoss: pct(e.probLoss * 100),
        cvar5PctCapital: e.cvar5PctCapital,
        worstPctCapital: e.worstPctCapital,
        evPerTailUnit: e.evPerTailUnit,
        // Delta is the market's own assignment probability. Where it disagrees
        // with the measured one, that disagreement IS the edge, so show it.
        deltaVsMeasured:
          absDelta == null ? null : pct(absDelta * 100 - e.probITM * 100),
        annualYieldPct: pct(((price / capital) * 100) * (365 / dte)),
      });
    } else {
      const e = longExpectancy({ dist, spot, strike: c.strike, cost: price, kind: spec.kind, dte });
      if (!e) { rejected.ev++; continue; }
      if (itmObs(e.probITM) < GATES.minItmObservations) { rejected.thinTail++; continue; }
      if (e.edgePctOfCost < GATES.minBuyEdgePct) { rejected.ev++; continue; }

      rows.push({
        occ: c.occ, strike: c.strike, kind: spec.kind,
        distancePct: pct(distancePct),
        bid: c.bid, ask: c.ask, spreadPct: pct(spreadPct),
        openInterest: c.openInterest, volume: c.volume,
        iv: c.iv == null ? null : pct(c.iv * 100),
        delta: c.delta == null ? null : Number(c.delta.toFixed(3)),
        premium: price,
        capital: price,
        edgePctOfCost: e.edgePctOfCost,
        evAnnualPct: e.evAnnualPct,
        fairValue: e.fairValue,
        marketPremium: price,
        probITM: pct(e.probITM * 100),
        probProfit: pct(e.probProfit * 100),
        upside5PctOfCost: e.upside5PctOfCost,
        breakeven: pct(spec.kind === 'call' ? c.strike + price : c.strike - price),
        deltaVsMeasured:
          absDelta == null ? null : pct(absDelta * 100 - e.probITM * 100),
      });
    }
  }

  const sortKey = writing ? 'evAnnualPct' : 'edgePctOfCost';
  rows.sort((a, b) => b[sortKey] - a[sortKey]);
  return { rows, rejected };
}

// One symbol, one strategy. Returns either a ranked best contract or the
// reason the symbol was screened out.
async function evaluateSymbol({ symbol, strategy, driftAnnualPct }) {
  const spec = STRATEGIES[strategy];

  let chain;
  try {
    chain = await fetchChain(symbol);
  } catch (err) {
    return { symbol, skipped: err.code === 'NO_OPTIONS' ? 'no listed options' : err.message };
  }

  const expiry = pickExpiry(chain, spec.targetDte);
  if (!expiry) return { symbol, skipped: 'no usable expiry near the target tenor' };

  const [series, analysis] = await Promise.all([
    fetchSeries(symbol, '1d'),
    // skipMacro: the macro model moves the chart verdict, not the arithmetic
    // of whether a contract is mispriced, and it costs several upstream calls
    // per symbol. Structure context comes from the technical read.
    runAnalysis({ symbol, timeframe: '1d', skipMacro: true }).catch(() => null),
  ]);
  const bars = series.bars;

  const horizon = tradingDaysFor(expiry.dte);
  // Fit the per-symbol vol bias once, here, and thread it through everything
  // downstream. It walks the symbol's history, so it must not be recomputed
  // per strike.
  const bias = await symbolVolBias(symbol, bars, horizon);
  const vf = forwardVolForecast(bars, horizon, { symbolBias: bias });
  const iv = atmImpliedVol(expiry.calls, chain.spot);
  if (!vf) return { symbol, skipped: 'not enough price history for a volatility forecast' };
  if (iv == null) return { symbol, skipped: 'no readable implied volatility in the chain' };

  // --- GATE 1: variance risk premium.
  const ivRatio = iv / vf.forecast;
  if (spec.requireRichVol && ivRatio < GATES.minWriteIvRatio) {
    return {
      symbol, name: analysis?.name, spot: chain.spot,
      skipped: `implied ${iv.toFixed(1)}% is only ${ivRatio.toFixed(2)}x forecast realised ${vf.forecast.toFixed(1)}% - not rich enough to write`,
      gate: 'vol',
      iv: pct(iv), rvForecast: pct(vf.forecast), ivRatio: Number(ivRatio.toFixed(3)),
    };
  }
  if (!spec.requireRichVol && ivRatio > GATES.maxBuyIvRatio) {
    return {
      symbol, name: analysis?.name, spot: chain.spot,
      skipped: `implied ${iv.toFixed(1)}% is ${ivRatio.toFixed(2)}x forecast realised ${vf.forecast.toFixed(1)}% - too expensive to buy`,
      gate: 'vol',
      iv: pct(iv), rvForecast: pct(vf.forecast), ivRatio: Number(ivRatio.toFixed(3)),
    };
  }

  // --- GATE 2: sample adequacy.
  const dist = returnDistribution(bars, horizon, { driftAnnualPct, volAnnualPct: vf.forecast });
  if (!dist) return { symbol, skipped: 'not enough history to build a return distribution' };
  if (dist.effectiveN < GATES.minEffectiveN) {
    return {
      symbol, name: analysis?.name,
      skipped: `only ${dist.effectiveN} effective independent observations at this tenor - too noisy to rank`,
      gate: 'sample',
    };
  }

  // --- GATE 3 and 4 are per-strike, inside evaluateChain.
  const { rows, rejected } = evaluateChain({ strategy, chain, expiry, dist });

  if (!rows.length) {
    const why = rejected.ev
      ? 'every liquid strike is priced at or below its measured fair value'
      : rejected.liquidity
        ? `no strike clears the liquidity gate (${GATES.maxSpreadPct}% spread, ${GATES.minOpenInterest} open interest)`
        : rejected.delta
          ? 'no strike sits inside the tradeable delta band'
          : rejected.thinTail
            ? `every liquid strike is too far out for this history to price - fewer than ${GATES.minItmObservations} independent observations finished beyond it`
            : 'no tradeable strike in this expiry';
    return { symbol, name: analysis?.name, spot: chain.spot, skipped: why, gate: 'strikes', rejected };
  }

  // Read event premium out of the term structure. Deliberately NOT a reason to
  // discard the symbol: the contract is listed, the premium is real, and the
  // only honest move is to show it with the date attached and keep it out of a
  // ranking whose edge figure it would distort.
  const event = termStructureEvent(chain, expiry.dte);

  const t = analysis?.technical;
  return {
    symbol,
    name: analysis?.name ?? symbol,
    spot: chain.spot,
    fetchedAt: chain.fetchedAt,
    eventRisk: event,
    expiry: { expiry: expiry.expiry, dte: expiry.dte },
    iv: pct(iv),
    rvForecast: pct(vf.forecast),
    rvCurrent: pct(vf.current),
    ivRatio: Number(ivRatio.toFixed(3)),
    volForecast: vf,
    skew: spec.kind === 'put' ? putSkew(expiry, chain.spot) : null,
    distribution: {
      horizon: dist.horizon,
      windows: dist.windows,
      effectiveN: dist.effectiveN,
      historyYears: dist.historyYears,
      sampleVolAnnualPct: dist.sampleVolAnnualPct,
      volScale: dist.volScale,
      volScaleClamped: dist.volScaleClamped,
      sampleDriftAnnualPct: dist.sampleDriftAnnualPct,
      driftAppliedAnnualPct: dist.driftAppliedAnnualPct,
    },
    // Chart context, reported but NOT used in the ranking. The setup score it
    // comes from failed its own backtest on direction, so it informs the read
    // and must not move the order.
    context: t
      ? {
          structure: t.structure?.trend ?? null,
          regime: t.regime ?? null,
          rsi: t.momentum?.rsi ?? null,
          atrPct: t.volatility?.atrPct ?? null,
          technicalScore: t.score ?? null,
          squeeze: Boolean(t.volatility?.squeeze),
        }
      : null,
    best: rows[0],
    alternatives: rows.slice(1, 4),
    strikesConsidered: rows.length,
    rejected,
  };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i]);
        } catch (err) {
          out[i] = { symbol: items[i], skipped: err.message };
        }
      }
    })
  );
  return out;
}

// One chain fetch plus one price series per symbol, and CBOE is the tighter
// constraint of the two, so this stays conservative.
const CONCURRENCY = Number(process.env.OPSCAN_CONCURRENCY) || 6;

export async function scanOptions({ universe = 'liquid', strategy = 'covered', limit = 8 } = {}) {
  const spec = OPTION_UNIVERSES[universe];
  if (!spec) throw new Error(`Unknown options universe: ${universe}`);
  if (!STRATEGIES[strategy]) throw new Error(`Unknown strategy: ${strategy}`);

  return cached(`opscan:${universe}:${strategy}:${limit}`, 300_000, async () => {
    const started = Date.now();
    const rf = await riskFreeRate();

    const results = await pool(spec.symbols, CONCURRENCY, (symbol) =>
      evaluateSymbol({ symbol, strategy, driftAnnualPct: rf.annualPct })
    );

    const sortKey = STRATEGIES[strategy].side === 'write' ? 'evAnnualPct' : 'edgePctOfCost';
    const withBest = results.filter((r) => r && r.best);

    // Event-contaminated chains are separated here rather than earlier so they
    // keep their full evaluation and can be shown with the measured numbers
    // and the window side by side.
    const ranked = withBest
      .filter((r) => !r.eventRisk?.detected)
      .sort((a, b) => b.best[sortKey] - a.best[sortKey]);
    const eventPremium = withBest
      .filter((r) => r.eventRisk?.detected)
      .sort((a, b) => b.best[sortKey] - a.best[sortKey]);

    // Everything that did not make the table, with the reason. A scanner that
    // silently drops symbols is impossible to trust or to debug.
    const screened = results
      .filter((r) => r && r.skipped)
      .map((r) => ({ symbol: r.symbol, name: r.name ?? null, reason: r.skipped, gate: r.gate ?? null }));

    const byGate = screened.reduce((acc, s) => {
      const k = s.gate || 'other';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    return {
      universe,
      universeLabel: spec.label,
      universeNote: spec.note,
      strategy,
      strategyLabel: STRATEGIES[strategy].label,
      strategyBlurb: STRATEGIES[strategy].blurb,
      side: STRATEGIES[strategy].side,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      scanned: spec.symbols.length,
      passed: ranked.length,
      heldForEvents: eventPremium.length,
      gates: GATES,
      gateSummary: byGate,
      riskFree: rf,
      // Surfaced deliberately: this is the measured, one-directional weakness
      // of the valuation, and it points the wrong way for call writers.
      caveat:
        STRATEGIES[strategy].kind === 'call' && STRATEGIES[strategy].side === 'write'
          ? `Valued at the risk-free rate (${rf.annualPct}%/yr). In a market that rises faster than ` +
            `cash, that under-states the chance a short call is breached - measured at about 3 points ` +
            `across the core universe. Treat the call-writing edge below as the optimistic reading.`
          : STRATEGIES[strategy].kind === 'put' && STRATEGIES[strategy].side === 'write'
            ? `Valued at the risk-free rate (${rf.annualPct}%/yr). In a rising market that OVER-states ` +
              `the chance a short put is breached, so this is the conservative reading on the put side.`
            : `Valued at the risk-free rate (${rf.annualPct}%/yr). A buyer benefits from any drift above ` +
              `cash, so the edge shown is the conservative reading.`,
      results: ranked.slice(0, limit),
      // Shown separately, with the window, so the decision is informed rather
      // than made silently on the user's behalf.
      eventPremium: eventPremium.slice(0, limit),
      screened,
    };
  });
}
