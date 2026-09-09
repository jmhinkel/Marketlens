// Covered-call strike scoring.
//
// The thing that makes this different from every delta-based screener: delta
// does not know that 6.76 is a level which has rejected price four times, and
// it does not know that this app's own pattern engine is projecting a move to
// 7.51. Both of those change which strike is actually safe to sell.
//
// Three questions, in order:
//   1. Is premium rich enough to sell at all?        (vol.js)
//   2. Does selling calls here fight our own read?   (assessThesis)
//   3. Given both, which strike?                     (scoreStrikes)
import { fetchChain, pickExpiry, OPTIONABLE_PROXIES } from '../data/cboe.js';
import { volatilityProfile, historicalBreach } from './vol.js';
import { runAnalysis } from '../analyze.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Calendar days to trading days, for projecting trendlines forward.
const tradingDays = (dte) => Math.round((dte * 252) / 365);

// --- Question 2: is the model's own read arguing against this trade? -------

function assessThesis(analysis, spot, expiry) {
  const t = analysis.technical;
  const reasons = [];
  const ceilings = [];

  // A bullish formation with a measured-move target above spot is the classic
  // way covered-call sellers get run over: they cap the exact move their own
  // analysis predicted.
  const bullish = (t.patterns || []).filter(
    (p) => p.direction === 'bullish' && p.target != null && p.target > spot && p.stage !== 'failed'
  );
  for (const p of bullish) {
    // A confirmed formation is a live projection; a forming one is a maybe.
    // Both are worth saying out loud, but only the confirmed one should push
    // strikes around hard.
    const hard = p.stage === 'confirmed' && p.confidence >= 55;
    ceilings.push({ price: p.target, source: `${p.name} measured-move target`, hard, stage: p.stage });
    reasons.push(
      `The chart engine has a ${p.stage} ${p.name.toLowerCase()} projecting ${p.target.toFixed(2)}` +
      (hard
        ? '. Selling a strike below that caps the move this model is actively forecasting.'
        : `, though it has not triggered yet (${p.confidence}% confidence), so treat it as a caution rather than a hard ceiling.`)
    );
  }

  // A rising channel keeps making new highs by construction - project its
  // upper rail out to expiry rather than using today's value.
  if (t.channel && t.channel.direction === 'rising') {
    const projected = t.channel.upper.currentValue + t.channel.upper.slopePerBar * tradingDays(expiry.dte);
    if (projected > spot) {
      ceilings.push({ price: projected, source: 'rising channel top projected to expiry', hard: true, stage: 'live' });
      reasons.push(
        `Price is in a rising channel whose upper rail projects to about ${projected.toFixed(2)} by ` +
        `${expiry.expiry}. A strike beneath that is inside the trend's normal path.`
      );
    }
  }

  const composite = analysis.composite.score;
  if (composite >= 25) {
    reasons.push(
      `Composite read is ${composite > 0 ? '+' : ''}${composite} (${analysis.composite.label.toLowerCase()}). ` +
      `Selling upside into your own constructive signal is a deliberate choice, not a neutral one.`
    );
  }

  // The floor under any strike we would be comfortable recommending. Hard
  // ceilings bind; soft ones only inform.
  const hardCeilings = ceilings.filter((c) => c.hard);
  const minimumSafeStrike = hardCeilings.length ? Math.max(...hardCeilings.map((c) => c.price)) : null;
  const softCeiling = ceilings.length ? Math.max(...ceilings.map((c) => c.price)) : null;

  let stance = 'clear';
  if (composite >= 45 && hardCeilings.length) stance = 'fighting the model';
  else if (composite >= 25 || ceilings.length) stance = 'caution';
  else if (composite <= -25) stance = 'supportive';

  return {
    stance,
    composite,
    reasons,
    ceilings,
    minimumSafeStrike,
    softCeiling,
    supportive:
      composite <= -25
        ? `Composite is ${composite}, so the model is already leaning lower. Covered calls work with that view rather than against it.`
        : null,
  };
}

// --- Question 3: score each out-of-the-money call -------------------------

function scoreStrikes({ analysis, chain, expiry, vol, thesis }) {
  const spot = chain.spot;
  const t = analysis.technical;
  const dte = Math.max(expiry.dte, 1);
  const oneSigma = vol.expectedMove?.oneSigma ?? null;

  // Resistance levels sitting between spot and the strike are barriers price
  // has to break before the short call is threatened. Delta cannot see them.
  const resistances = (t.levels || []).filter((l) => l.price > spot);

  const rows = [];
  for (const c of expiry.calls) {
    if (c.strike <= spot) continue;
    const bid = c.bid;
    if (bid == null || bid <= 0) continue;

    const moneyness = ((c.strike - spot) / spot) * 100;
    if (moneyness > 60) continue; // far wings carry no useful premium

    const mid = c.ask != null && c.ask > 0 ? (bid + c.ask) / 2 : bid;
    const spreadPct = c.ask != null && c.ask > 0 ? ((c.ask - bid) / mid) * 100 : null;

    // Premium is taken at the bid: that is what you actually receive.
    const premiumPct = (bid / spot) * 100;
    const staticAnnual = premiumPct * (365 / dte);
    const ifCalledPct = ((c.strike - spot + bid) / spot) * 100;
    const ifCalledAnnual = ifCalledPct * (365 / dte);

    const protecting = resistances.filter((l) => l.price <= c.strike);
    const strongest = protecting.length
      ? protecting.reduce((m, l) => (l.strength > m.strength ? l : m))
      : null;

    const breach = historicalBreach(vol.dailyBars, moneyness, tradingDays(dte));
    const sigma = oneSigma ? (c.strike - spot) / oneSigma : null;

    const belowCeiling =
      thesis.minimumSafeStrike != null && c.strike < thesis.minimumSafeStrike;
    const belowSoftCeiling =
      !belowCeiling && thesis.softCeiling != null && c.strike < thesis.softCeiling;

    // A call that pays almost nothing is not a safe trade, it is a pointless
    // one: you take real assignment risk and cap real upside for a rounding
    // error. Screen those out before scoring rather than letting a high
    // safety score float them to the top.
    if (bid < 0.05 || premiumPct < 0.25 || staticAnnual < 5) continue;

    // --- score components, each named so the UI can show the reasoning
    const parts = [];
    const add = (label, points, detail) => parts.push({ label, points, detail });

    // Reward: annualised static return, saturating around 35%/yr so an
    // enormous premium cannot outvote the risk it carries.
    add('Premium collected', clamp(30 * (1 - Math.exp(-staticAnnual / 14)), 0, 30),
      `${premiumPct.toFixed(2)}% for ${dte} days — ${staticAnnual.toFixed(1)}% annualised if it expires worthless`);

    // Risk: the market's own assignment probability, scored as a band rather
    // than a straight line. Covered calls live in roughly 0.15-0.35 delta:
    // below that you are not paid for the upside you surrender, above it you
    // are simply short the stock's best days.
    if (c.delta != null) {
      const d = c.delta;
      let pts;
      let note;
      if (d > 0.45) { pts = -clamp((d - 0.45) * 90 + 14, 14, 34); note = 'well inside the range where you are likely to be called away'; }
      else if (d >= 0.30) { pts = -6; note = 'aggressive but standard for premium capture'; }
      else if (d >= 0.15) { pts = 8; note = 'the conventional covered-call band'; }
      else if (d >= 0.08) { pts = 2; note = 'conservative — safer, but you are giving up premium for it'; }
      else { pts = -8; note = 'so far out that the premium does not compensate for capping the position'; }
      add('Assignment probability', pts,
        `${(d * 100).toFixed(0)}% chance of finishing in the money — ${note}`);
    }

    // Risk: what this asset has actually done, which has fatter tails than
    // the lognormal model behind delta.
    if (breach) {
      const gap = breach.finishAbove - (c.delta != null ? c.delta * 100 : breach.finishAbove);
      add('Historical breach rate', -clamp((breach.finishAbove / 100) * 30, 0, 24),
        `Over ${breach.windows} historical ${tradingDays(dte)}-day windows this asset gained ${moneyness.toFixed(1)}%+ ` +
        `${breach.finishAbove}% of the time (touched it ${breach.everTouched}% of the time)` +
        (Math.abs(gap) > 6
          ? `. That is ${gap > 0 ? 'worse' : 'better'} than delta implies by ${Math.abs(gap).toFixed(0)} points.`
          : '.'));
    }

    // Structure: the differentiated input.
    if (strongest) {
      add('Resistance below strike', clamp(strongest.strength / 4.5, 0, 20),
        `${protecting.length} resistance level${protecting.length === 1 ? '' : 's'} between spot and this strike; ` +
        `the strongest sits at ${strongest.price.toFixed(2)} with ${strongest.touches} touches. ` +
        `Price has to break it before the call is threatened.`);
    } else {
      add('Resistance below strike', -6,
        'No clustered resistance between spot and this strike — nothing structural stands in the way of a run.');
    }

    // Thesis conflict.
    if (belowCeiling) {
      add('Conflicts with our own target', -18,
        `Sits below ${thesis.minimumSafeStrike.toFixed(2)}, which is where this model's own confirmed bullish projection points.`);
    } else if (belowSoftCeiling) {
      add('Below an untriggered target', -7,
        `Sits below ${thesis.softCeiling.toFixed(2)}, projected by a formation that has not triggered yet — a caution, not a veto.`);
    } else if (thesis.minimumSafeStrike != null || thesis.softCeiling != null) {
      add('Clears our own target', 10,
        `Above the ${(thesis.minimumSafeStrike ?? thesis.softCeiling).toFixed(2)} ceiling implied by the model's bullish projection.`);
    }

    // Distance in the market's own expected-move units. This peaks a little
    // past one sigma and fades after that - beyond roughly two sigma you are
    // no longer being paid for the distance, which the premium term already
    // reflects, so it must not keep adding points forever.
    if (sigma != null) {
      const cushion = sigma < 1.4 ? (sigma - 0.7) * 11 : Math.max(0, 7.7 - (sigma - 1.4) * 6);
      add('Expected-move cushion', clamp(cushion, -8, 8),
        `${sigma.toFixed(2)} standard deviations out on the ${dte}-day expected move` +
        (sigma > 2.5 ? ' — far outside the range the market is pricing, which is why the premium is so thin' : ''));
    }

    // Liquidity: a great strike you cannot get filled on is not a great strike.
    let liq = 0;
    const liqNotes = [];
    if (spreadPct != null && spreadPct > 25) { liq -= 12; liqNotes.push(`${spreadPct.toFixed(0)}% bid-ask spread`); }
    else if (spreadPct != null && spreadPct > 12) { liq -= 5; liqNotes.push(`${spreadPct.toFixed(0)}% spread`); }
    if (c.openInterest < 10) { liq -= 8; liqNotes.push(`only ${c.openInterest} open interest`); }
    else if (c.openInterest < 50) { liq -= 3; liqNotes.push(`${c.openInterest} open interest`); }
    if (liq < 0) add('Liquidity drag', liq, `Hard to work a fill: ${liqNotes.join(', ')}`);

    const score = clamp(Math.round(50 + parts.reduce((s, p) => s + p.points, 0)), 0, 100);

    rows.push({
      occ: c.occ,
      strike: c.strike,
      moneyness: Number(moneyness.toFixed(2)),
      bid, ask: c.ask, mid: Number(mid.toFixed(3)),
      spreadPct: spreadPct == null ? null : Number(spreadPct.toFixed(1)),
      iv: c.iv == null ? null : Number((c.iv * 100).toFixed(1)),
      delta: c.delta == null ? null : Number(c.delta.toFixed(3)),
      theta: c.theta == null ? null : Number(c.theta.toFixed(4)),
      openInterest: c.openInterest,
      volume: c.volume,
      premiumPct: Number(premiumPct.toFixed(2)),
      staticAnnual: Number(staticAnnual.toFixed(1)),
      ifCalledPct: Number(ifCalledPct.toFixed(2)),
      ifCalledAnnual: Number(ifCalledAnnual.toFixed(1)),
      breakeven: Number((c.strike + bid).toFixed(2)),
      sigmaDistance: sigma == null ? null : Number(sigma.toFixed(2)),
      resistanceCount: protecting.length,
      strongestResistance: strongest ? { price: strongest.price, touches: strongest.touches, strength: strongest.strength } : null,
      historicalBreach: breach,
      belowThesisCeiling: belowCeiling,
      score,
      components: parts.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    });
  }

  return rows.sort((a, b) => b.score - a.score);
}

// --- Panel verdict ---------------------------------------------------------

function buildVerdict(vol, thesis, best) {
  const reasons = [];
  let verdict = 'acceptable';

  if (vol.verdict === 'cheap') {
    verdict = 'unfavourable';
    reasons.push(vol.verdictDetail);
  } else if (vol.verdict === 'rich') {
    reasons.push(vol.verdictDetail);
  } else if (vol.verdict === 'fair') {
    reasons.push(vol.verdictDetail);
  }

  if (thesis.stance === 'fighting the model') {
    verdict = 'unfavourable';
    reasons.push(
      `This is the setup where covered calls do the most damage: a strong constructive read plus a live bullish ` +
      `formation. If you sell here, stay above ${thesis.minimumSafeStrike?.toFixed(2)} or accept that you are ` +
      `capping the move the model is forecasting.`
    );
  } else if (thesis.stance === 'caution') {
    if (verdict !== 'unfavourable') verdict = 'acceptable';
    reasons.push(...thesis.reasons);
  } else if (thesis.stance === 'supportive') {
    if (vol.verdict === 'rich') verdict = 'favourable';
    reasons.push(thesis.supportive);
  }

  if (vol.verdict === 'rich' && thesis.stance === 'clear') verdict = 'favourable';
  if (!best) {
    verdict = 'unfavourable';
    reasons.push('No out-of-the-money call in this expiry has a live bid worth selling.');
  }

  return { verdict, reasons: reasons.filter(Boolean) };
}

export async function analyzeCoveredCalls({ symbol, expiry: requestedExpiry, targetDte = 35 }) {
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
          ? 'There are no listed options on this instrument. These are the liquid ways to express it, and analyzing one of them runs the whole model against that underlying.'
          : 'There are no listed US options on this instrument, and no standard proxy is mapped for it.',
      };
    }
    throw err;
  }

  const expiry = requestedExpiry
    ? chain.expiries.find((e) => e.expiry === requestedExpiry) || pickExpiry(chain, targetDte)
    : pickExpiry(chain, targetDte);
  if (!expiry) return { available: false, symbol, reason: 'No usable expiries in this chain.' };

  // The structural read comes from the same engine the rest of the app uses,
  // on the same underlying the options are written on.
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

  // Keep the payload lean: the dailyBars array was only needed for scoring.
  const { dailyBars, ...volOut } = vol;

  return {
    available: true,
    symbol: chain.symbol,
    name: analysis.name,
    spot: chain.spot,
    fetchedAt: chain.fetchedAt,
    expiry: { expiry: expiry.expiry, dte: expiry.dte },
    expiries: chain.expiries
      .filter((e) => e.dte >= 1 && e.calls.length >= 4)
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
