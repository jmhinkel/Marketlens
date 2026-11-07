// Buying calls.
//
// This is not the covered-call panel with the sign flipped. Premium selling and
// premium buying are different trades and almost every test inverts:
//
//   1. THE VOLATILITY GATE REVERSES. A seller wants implied above realised. A
//      buyer wants it at or below - paying 45 vol for an asset that delivers 30
//      means being right on direction and still losing.
//   2. YOU PAY THE ASK. Sellers receive the bid. On a wide market that gap is
//      the single largest cost in the trade, so it is priced in here rather
//      than quoted off the mid.
//   3. TIME IS THE ENEMY. Theta is a daily bleed, so the move has to happen,
//      and happen soon. A seller is paid to wait; a buyer pays to.
//   4. THE TARGET MUST CLEAR THE BREAKEVEN. This is the test the rest of this
//      app uniquely enables: the chart engine already computes a measured-move
//      target, so we can ask whether the move the model forecasts is even
//      enough to pay for the option. If the target sits below the breakeven,
//      the position loses money while the thesis plays out perfectly - and
//      that is the most common way a correct directional call still loses.
import { fetchChain, pickExpiry, OPTIONABLE_PROXIES } from '../data/cboe.js';
import { volatilityProfile, historicalBreach } from './vol.js';
import { runAnalysis } from '../analyze.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const tradingDays = (dte) => Math.round((dte * 252) / 365);

// --- Is there a directional case worth paying for at all? ----------------

function assessThesis(analysis, spot, expiry) {
  const t = analysis.technical;
  const reasons = [];

  const bullish = (t.patterns || [])
    .filter((p) => p.direction === 'bullish' && p.target != null && p.target > spot && p.stage !== 'failed')
    .sort((a, b) => b.confidence - a.confidence);
  const best = bullish[0] || null;

  // A rising channel gives a second, independent projection to aim at.
  let channelTarget = null;
  if (t.channel && t.channel.direction === 'rising') {
    const projected = t.channel.upper.currentValue + t.channel.upper.slopePerBar * tradingDays(expiry.dte);
    if (projected > spot) channelTarget = projected;
  }

  const target = best?.target ?? channelTarget ?? null;
  const composite = analysis.composite.score;

  if (best) {
    reasons.push(
      `The chart engine has a ${best.stage} ${best.name.toLowerCase()} projecting ${best.target.toFixed(2)} ` +
      `(${(((best.target - spot) / spot) * 100).toFixed(1)}% above spot) at ${best.confidence}% confidence.`
    );
    if (best.stage === 'forming' && best.trigger != null) {
      reasons.push(
        `It has not triggered yet — that needs a close above ${best.trigger.toFixed(2)}. Buying before the ` +
        `trigger means paying theta while you wait for the setup to even begin.`
      );
    }
  } else if (channelTarget) {
    reasons.push(`No completed bullish formation, but a rising channel projects about ${channelTarget.toFixed(2)} by expiry.`);
  } else {
    reasons.push(
      'No bullish formation and no rising channel. Buying calls here is paying for a move the chart ' +
      'engine has no basis to expect — the premium has to come out of something other than this model.'
    );
  }

  let stance = 'no case';
  if (best && best.stage === 'confirmed' && composite >= 15) stance = 'strong';
  else if (best && (best.stage === 'confirmed' || composite >= 15)) stance = 'reasonable';
  else if (best || channelTarget) stance = 'speculative';

  if (composite <= -25) {
    reasons.push(
      `Composite reads ${composite} (${analysis.composite.label.toLowerCase()}), so the broader model leans ` +
      `against this direction even if a formation points up.`
    );
    if (stance === 'strong') stance = 'reasonable';
  }

  return { stance, composite, target, pattern: best, channelTarget, reasons };
}

// --- Score each call you might buy ---------------------------------------

function scoreStrikes({ analysis, chain, expiry, vol, thesis }) {
  const spot = chain.spot;
  const t = analysis.technical;
  const dte = Math.max(expiry.dte, 1);
  const oneSigma = vol.expectedMove?.oneSigma ?? null;
  const target = thesis.target;

  // Resistance between spot and the breakeven is a wall the trade has to clear
  // before it makes a cent. For a buyer this is a cost, not a cushion.
  const resistances = (t.levels || []).filter((l) => l.price > spot);

  const rows = [];
  for (const c of expiry.calls) {
    // Buyers pay the ask. Quoting these off the mid flatters every number
    // downstream - breakeven, return, theta burn - so the ask is used
    // throughout even though it makes the panel look worse.
    const ask = c.ask;
    if (ask == null || ask <= 0) continue;
    if (c.strike < spot * 0.85 || c.strike > spot * 1.6) continue;

    const mid = c.bid != null && c.bid > 0 ? (c.bid + ask) / 2 : ask;
    const spreadPct = c.bid != null && c.bid > 0 ? ((ask - c.bid) / mid) * 100 : null;

    const breakeven = c.strike + ask;
    const breakevenPct = ((breakeven - spot) / spot) * 100;
    const premiumPctOfSpot = (ask / spot) * 100;

    // Theta is quoted per day per share.
    const thetaDayPct = c.theta != null && ask > 0 ? (Math.abs(c.theta) / ask) * 100 : null;

    const targetClears = target != null ? target - breakeven : null;
    const returnAtTarget =
      target != null ? ((Math.max(0, target - c.strike) - ask) / ask) * 100 : null;
    const targetSigma = target != null && oneSigma ? (target - spot) / oneSigma : null;

    // A far more sober yardstick than the measured move: what this contract
    // returns if the asset simply does what the option market expects it to.
    // For most out-of-the-money calls the answer is a loss, which is the whole
    // point of showing it.
    const oneSigmaPrice = oneSigma ? spot + oneSigma : null;
    const returnAtOneSigma = oneSigmaPrice
      ? ((Math.max(0, oneSigmaPrice - c.strike) - ask) / ask) * 100
      : null;

    const breachToBreakeven = historicalBreach(vol.dailyBars, breakevenPct, tradingDays(dte), 'up');
    const sigma = oneSigma ? (breakeven - spot) / oneSigma : null;
    const throughBreakeven = resistances.filter((l) => l.price <= breakeven);

    const parts = [];
    const add = (label, points, detail) => parts.push({ label, points, detail });

    // --- The test this app is uniquely positioned to make.
    if (target != null) {
      if (targetClears > 0) {
        const headroom = (targetClears / ask) * 100;
        // A measured move is geometry, not a probability, and some of them are
        // extravagant - a flag's pole projection can imply +75% in ten weeks.
        // The option market's own expected move is the reality check: credit
        // for clearing the breakeven is scaled down as the target drifts
        // beyond what that move makes plausible, because a buyer is betting
        // entirely on the target being reachable.
        const plausible = targetSigma == null ? 1 : clamp(1 - (targetSigma - 2) / 2.2, 0.15, 1);
        add('Target clears the breakeven', clamp((8 + headroom / 14) * plausible, 3, 26),
          `Breakeven ${breakeven.toFixed(2)} sits below the ${target.toFixed(2)} target with ${targetClears.toFixed(2)} to spare` +
          (returnAtTarget != null ? ` — about ${returnAtTarget.toFixed(0)}% on the premium if it gets there` : '') +
          (targetSigma != null && targetSigma > 2.5
            ? `. That target is ${targetSigma.toFixed(1)} standard deviations away though, well beyond what the option market prices as a likely move, so this credit is discounted heavily.`
            : ''));
      } else {
        add('Target does NOT clear the breakeven', -30,
          `Breakeven ${breakeven.toFixed(2)} is above the ${target.toFixed(2)} target. The model's own forecast ` +
          `does not get this position to profit — you would be right on direction and still lose.`);
      }
    } else {
      add('No target to measure against', -14,
        'The chart engine projects no bullish target, so there is nothing to say this premium can be earned back.');
    }

    // --- The gate, inverted from the selling panels.
    if (vol.ratio != null) {
      if (vol.ratio >= 1.25) {
        add('Paying for rich volatility', -18,
          `Implied ${vol.impliedVol}% against realised ${vol.realizedVol}% — you are buying volatility ` +
          `${((vol.ratio - 1) * 100).toFixed(0)}% above what this asset actually delivers`);
      } else if (vol.ratio >= 1.05) {
        add('Volatility modestly rich', -7,
          `Implied ${vol.impliedVol}% against realised ${vol.realizedVol}% — a small overpay`);
      } else {
        add('Volatility is cheap', 16,
          `Implied ${vol.impliedVol}% at or below realised ${vol.realizedVol}% — options are not pricing ` +
          `the movement this asset has been delivering, which is the condition for buying premium`);
      }
    }

    // --- Theta. The daily cost of being early.
    if (thetaDayPct != null) {
      add('Time decay', -clamp(thetaDayPct * 9, 0, 22),
        `Losing about ${thetaDayPct.toFixed(2)}% of the premium per day to decay — roughly ` +
        `${(thetaDayPct * 7).toFixed(1)}% a week if the price does not move`);
    }

    // --- Delta. Too little and it is a lottery ticket.
    if (c.delta != null) {
      const d = c.delta;
      let pts;
      let note;
      if (d >= 0.60) { pts = 8; note = 'behaves much like the shares, with less premium at risk'; }
      else if (d >= 0.40) { pts = 10; note = 'the usual band for a directional call — real participation without paying for deep intrinsic'; }
      else if (d >= 0.25) { pts = 2; note = 'needs a decisive move to pay'; }
      else { pts = -12; note = 'a lottery ticket: most of the time this expires worthless'; }
      add('Delta', pts, `${(d * 100).toFixed(0)} delta — ${note}`);
    }

    // --- Does history say the breakeven is even reachable in this window?
    if (breachToBreakeven) {
      add('Historical odds of clearing breakeven',
        clamp((breachToBreakeven.finishBeyond - 35) / 2.6, -16, 14),
        `Over ${breachToBreakeven.windows} historical ${tradingDays(dte)}-day windows this asset gained ` +
        `${breakevenPct.toFixed(1)}%+ only ${breachToBreakeven.finishBeyond}% of the time`);
    }

    // --- Walls in the way.
    if (throughBreakeven.length) {
      const strongest = throughBreakeven.reduce((m, l) => (l.strength > m.strength ? l : m));
      add('Resistance below breakeven', -clamp(throughBreakeven.length * 4 + strongest.touches, 3, 14),
        `${throughBreakeven.length} resistance level${throughBreakeven.length === 1 ? '' : 's'} between spot and breakeven; ` +
        `the strongest at ${strongest.price.toFixed(2)} has held ${strongest.touches} times`);
    }

    // --- Setup timing. Paying theta before the trigger is paying to wait.
    if (thesis.pattern?.stage === 'forming' && thesis.pattern.trigger != null) {
      const atr = t.volatility.atr;
      const distATR = atr ? Math.abs(thesis.pattern.trigger - spot) / atr : null;
      if (distATR != null && distATR > 1.5) {
        add('Setup has not triggered', -10,
          `The formation is still ${distATR.toFixed(1)} ATR from its trigger, so decay runs before the thesis even starts`);
      }
    }

    // --- Spreads hurt buyers roughly twice as much as sellers.
    let liq = 0;
    const liqNotes = [];
    if (spreadPct != null && spreadPct > 25) { liq -= 16; liqNotes.push(`${spreadPct.toFixed(0)}% bid-ask spread`); }
    else if (spreadPct != null && spreadPct > 12) { liq -= 7; liqNotes.push(`${spreadPct.toFixed(0)}% spread`); }
    if (c.openInterest < 10) { liq -= 8; liqNotes.push(`only ${c.openInterest} open interest`); }
    else if (c.openInterest < 50) { liq -= 3; liqNotes.push(`${c.openInterest} open interest`); }
    if (liq < 0) add('Liquidity drag', liq,
      `You cross the spread to get in and again to get out: ${liqNotes.join(', ')}`);

    rows.push({
      occ: c.occ,
      strike: c.strike,
      moneyness: Number((((c.strike - spot) / spot) * 100).toFixed(2)),
      bid: c.bid, ask, mid: Number(mid.toFixed(3)),
      spreadPct: spreadPct == null ? null : Number(spreadPct.toFixed(1)),
      iv: c.iv == null ? null : Number((c.iv * 100).toFixed(1)),
      delta: c.delta == null ? null : Number(c.delta.toFixed(3)),
      theta: c.theta == null ? null : Number(c.theta.toFixed(4)),
      thetaDayPct: thetaDayPct == null ? null : Number(thetaDayPct.toFixed(2)),
      openInterest: c.openInterest,
      volume: c.volume,
      premiumPctOfSpot: Number(premiumPctOfSpot.toFixed(2)),
      breakeven: Number(breakeven.toFixed(2)),
      breakevenPct: Number(breakevenPct.toFixed(2)),
      target: target == null ? null : Number(target.toFixed(2)),
      targetClears: targetClears == null ? null : Number(targetClears.toFixed(2)),
      returnAtTarget: returnAtTarget == null ? null : Number(returnAtTarget.toFixed(0)),
      targetSigma: targetSigma == null ? null : Number(targetSigma.toFixed(2)),
      returnAtOneSigma: returnAtOneSigma == null ? null : Number(returnAtOneSigma.toFixed(0)),
      sigmaToBreakeven: sigma == null ? null : Number(sigma.toFixed(2)),
      historicalOdds: breachToBreakeven,
      resistanceBelowBreakeven: throughBreakeven.length,
      score: clamp(Math.round(42 + parts.reduce((s, p) => s + p.points, 0) * 0.8), 0, 100),
      components: parts.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    });
  }

  return rows.sort((a, b) => b.score - a.score);
}

function buildVerdict(vol, thesis, best) {
  const reasons = [];
  let verdict = 'unfavourable';

  if (vol.ratio != null) {
    if (vol.ratio >= 1.25) {
      reasons.push(
        `Implied volatility is ${vol.impliedVol}% against realised ${vol.realizedVol}%. Buying premium at ` +
        `this ratio means the move has to be larger than the asset normally delivers just to break even — ` +
        `this is the condition for SELLING options, not buying them.`
      );
    } else if (vol.ratio >= 1.05) {
      reasons.push(`Implied ${vol.impliedVol}% against realised ${vol.realizedVol}% — a modest overpay, tolerable if the directional case is strong.`);
    } else {
      reasons.push(`Implied ${vol.impliedVol}% is at or below realised ${vol.realizedVol}%. Options are cheap relative to how this asset has actually been moving, which is the right condition for buying.`);
    }
  }

  reasons.push(...thesis.reasons);

  const cheapEnough = vol.ratio == null || vol.ratio < 1.25;
  if (thesis.stance === 'strong' && cheapEnough) verdict = 'favourable';
  else if (thesis.stance === 'strong' || (thesis.stance === 'reasonable' && cheapEnough)) verdict = 'acceptable';
  else if (thesis.stance === 'no case') verdict = 'unfavourable';

  if (best && best.targetSigma != null && best.targetSigma > 2.5) {
    reasons.push(
      `The chart target sits ${best.targetSigma.toFixed(1)} standard deviations above spot — further than the ` +
      `option market prices as a likely move over this tenor. Treat the returns-at-target column as an upper ` +
      `bound on a low-probability path, not an expectation.`
    );
    if (verdict === 'favourable') verdict = 'acceptable';
  }

  if (best && best.targetClears != null && best.targetClears <= 0) {
    verdict = 'unfavourable';
    reasons.push(
      'Even the best-scoring strike has a breakeven above the model\'s own target, so no contract on this ' +
      'expiry profits from the move being forecast. A longer expiry or a lower strike would be needed.'
    );
  }

  return { verdict, reasons: reasons.filter(Boolean) };
}

export async function analyzeLongCalls({ symbol, expiry: requestedExpiry, targetDte = 60 }) {
  let chain;
  try {
    chain = await fetchChain(symbol);
  } catch (err) {
    if (err.code === 'NO_OPTIONS') {
      const proxies = OPTIONABLE_PROXIES[symbol.toUpperCase()] || null;
      return {
        available: false,
        symbol,
        reason: err.message,
        proxies,
        hint: proxies
          ? 'There are no listed options on this instrument. These are the liquid ways to express it.'
          : 'There are no listed US options on this instrument, and no standard proxy is mapped for it.',
      };
    }
    throw err;
  }

  // Buyers want more time than sellers do - the move has to arrive before
  // decay eats the position - so the default tenor here is longer.
  const expiry = requestedExpiry
    ? chain.expiries.find((e) => e.expiry === requestedExpiry) || pickExpiry(chain, targetDte)
    : pickExpiry(chain, targetDte);
  if (!expiry) return { available: false, symbol, reason: 'No usable expiries in this chain.' };

  const analysis = await runAnalysis({ symbol: chain.symbol, timeframe: '1d' });
  const vol = await volatilityProfile({
    symbol: chain.symbol,
    chain,
    expiry,
    profileKey: analysis.macro?.profile?.key,
  });
  const thesis = assessThesis(analysis, chain.spot, expiry);
  const strikes = scoreStrikes({ analysis, chain, expiry, vol, thesis });
  const verdict = buildVerdict(vol, thesis, strikes[0]);

  const { dailyBars, ...volOut } = vol;

  return {
    available: true,
    symbol: chain.symbol,
    name: analysis.name,
    spot: chain.spot,
    fetchedAt: chain.fetchedAt,
    expiry: { expiry: expiry.expiry, dte: expiry.dte },
    expiries: chain.expiries
      .filter((e) => e.dte >= 7 && e.calls.length >= 4)
      .map((e) => ({ expiry: e.expiry, dte: e.dte, contracts: e.calls.length })),
    volatility: volOut,
    thesis,
    verdict,
    strikes: strikes.slice(0, 12),
    composite: analysis.composite,
    levels: analysis.technical.levels,
    patterns: analysis.technical.patterns,
  };
}
