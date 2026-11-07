// Cash-secured put selling.
//
// The mirror of covered.js, but three things invert rather than reflect, and
// they are what the scoring turns on:
//
//   1. STRUCTURE. A call seller wants resistance BELOW the strike as a barrier.
//      A put seller wants support ABOVE it - clustered demand price has to chew
//      through before the strike is threatened.
//   2. THESIS. A bullish formation argues FOR selling puts, where it argues
//      against selling calls. The conflict case is a confirmed bearish
//      formation projecting through the strike.
//   3. ASSIGNMENT. Being assigned a call ends the position; being assigned a
//      put starts one. That makes "is the effective basis a price I would
//      happily own at" the central question, not a footnote - so it is scored
//      against support and the long-term average rather than just reported.
import { fetchChain, pickExpiry, OPTIONABLE_PROXIES } from '../data/cboe.js';
import { volatilityProfile, historicalBreach, putSkew, markTies } from './vol.js';
import { runAnalysis } from '../analyze.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const tradingDays = (dte) => Math.round((dte * 252) / 365);

// --- Does the model's own read argue against selling downside here? -------

function assessThesis(analysis, spot, expiry) {
  const t = analysis.technical;
  const reasons = [];
  const floors = [];

  // A bearish formation projecting below spot is the put seller's version of
  // the covered-call trap: you are selling insurance against the exact move
  // your own model is forecasting.
  const bearish = (t.patterns || []).filter(
    (p) => p.direction === 'bearish' && p.target != null && p.target < spot && p.stage !== 'failed'
  );
  for (const p of bearish) {
    const hard = p.stage === 'confirmed' && p.confidence >= 55;
    floors.push({ price: p.target, source: `${p.name} measured-move target`, hard, stage: p.stage });
    reasons.push(
      `The chart engine has a ${p.stage} ${p.name.toLowerCase()} projecting ${p.target.toFixed(2)}` +
      (hard
        ? '. Strikes above that are selling insurance against a move this model is actively forecasting.'
        : `, though it has not triggered yet (${p.confidence}% confidence), so treat it as a caution rather than a hard floor.`)
    );
  }

  // A falling channel keeps making lower lows by construction.
  if (t.channel && t.channel.direction === 'falling') {
    const projected = t.channel.lower.currentValue + t.channel.lower.slopePerBar * tradingDays(expiry.dte);
    if (projected < spot) {
      floors.push({ price: projected, source: 'falling channel floor projected to expiry', hard: true, stage: 'live' });
      reasons.push(
        `Price is in a falling channel whose lower rail projects to about ${projected.toFixed(2)} by ` +
        `${expiry.expiry}. A strike above that sits inside the trend's normal path.`
      );
    }
  }

  const composite = analysis.composite.score;
  if (composite <= -25) {
    reasons.push(
      `Composite read is ${composite} (${analysis.composite.label.toLowerCase()}). Selling downside into ` +
      `your own negative signal is a deliberate choice, not a neutral one.`
    );
  }

  const hardFloors = floors.filter((f) => f.hard);
  const maximumSafeStrike = hardFloors.length ? Math.min(...hardFloors.map((f) => f.price)) : null;
  const softFloor = floors.length ? Math.min(...floors.map((f) => f.price)) : null;

  let stance = 'clear';
  if (composite <= -45 && hardFloors.length) stance = 'fighting the model';
  else if (composite <= -25 || floors.length) stance = 'caution';
  else if (composite >= 25) stance = 'supportive';

  return {
    stance,
    composite,
    reasons,
    floors,
    maximumSafeStrike,
    softFloor,
    supportive:
      composite >= 25
        ? `Composite is +${composite}, so the model already leans higher. Selling puts works with that view rather than against it.`
        : null,
  };
}

// --- Score each out-of-the-money put --------------------------------------

function scoreStrikes({ analysis, chain, expiry, vol, thesis }) {
  const spot = chain.spot;
  const t = analysis.technical;
  const dte = Math.max(expiry.dte, 1);
  const oneSigma = vol.expectedMove?.oneSigma ?? null;
  const sma200 = t.movingAverages?.sma200 ?? null;

  // Support ABOVE the strike is what protects a short put - price has to break
  // through it before the strike comes into play.
  const supports = (t.levels || []).filter((l) => l.price < spot);

  const rows = [];
  for (const c of expiry.puts) {
    if (c.strike >= spot) continue;
    const bid = c.bid;
    if (bid == null || bid <= 0) continue;

    const otmPct = ((spot - c.strike) / spot) * 100;
    if (otmPct > 60) continue;

    const mid = c.ask != null && c.ask > 0 ? (bid + c.ask) / 2 : bid;
    const spreadPct = c.ask != null && c.ask > 0 ? ((c.ask - bid) / mid) * 100 : null;

    // Cash-secured: the collateral is the strike, less the premium you keep.
    const collateral = c.strike - bid;
    const premiumPct = (bid / collateral) * 100;
    const annualised = premiumPct * (365 / dte);

    // If assigned, this is what you actually pay.
    const basis = c.strike - bid;
    const basisVsSpot = ((basis - spot) / spot) * 100;
    const basisVs200 = sma200 ? ((basis - sma200) / sma200) * 100 : null;

    const protecting = supports.filter((l) => l.price >= c.strike);
    const strongest = protecting.length
      ? protecting.reduce((m, l) => (l.strength > m.strength ? l : m))
      : null;

    const breach = historicalBreach(vol.dailyBars, -otmPct, tradingDays(dte), 'down');
    const sigma = oneSigma ? (spot - c.strike) / oneSigma : null;
    const absDelta = c.delta != null ? Math.abs(c.delta) : null;

    const belowFloor = thesis.maximumSafeStrike != null && c.strike > thesis.maximumSafeStrike;
    const belowSoftFloor =
      !belowFloor && thesis.softFloor != null && c.strike > thesis.softFloor;

    // A put that pays a rounding error still carries full assignment risk and
    // ties up the collateral the whole time.
    if (bid < 0.05 || annualised < 5) continue;

    const parts = [];
    const add = (label, points, detail) => parts.push({ label, points, detail });

    add('Premium on collateral', clamp(30 * (1 - Math.exp(-annualised / 14)), 0, 30),
      `${bid.toFixed(2)} on ${collateral.toFixed(2)} of cash for ${dte} days — ${annualised.toFixed(1)}% annualised if it expires worthless`);

    if (absDelta != null) {
      let pts;
      let note;
      if (absDelta > 0.45) { pts = -clamp((absDelta - 0.45) * 90 + 14, 14, 34); note = 'likely to be assigned'; }
      else if (absDelta >= 0.30) { pts = -6; note = 'aggressive but standard for premium capture'; }
      else if (absDelta >= 0.15) { pts = 8; note = 'the conventional cash-secured band'; }
      else if (absDelta >= 0.08) { pts = 2; note = 'conservative — safer, but thin for the capital tied up'; }
      else { pts = -8; note = 'so far out the premium does not justify committing the collateral'; }
      add('Assignment probability', pts, `${(absDelta * 100).toFixed(0)}% chance of being put the stock — ${note}`);
    }

    if (breach) {
      const gap = breach.finishBeyond - (absDelta != null ? absDelta * 100 : breach.finishBeyond);
      add('Historical breach rate', -clamp((breach.finishBeyond / 100) * 30, 0, 24),
        `Over ${breach.windows} historical ${tradingDays(dte)}-day windows this fell ${otmPct.toFixed(1)}%+ ` +
        `${breach.finishBeyond}% of the time (traded through it ${breach.everTouched}% of the time)` +
        (Math.abs(gap) > 6
          ? `. That is ${gap > 0 ? 'worse' : 'better'} than delta implies by ${Math.abs(gap).toFixed(0)} points.`
          : '.'));
    }

    // The differentiated input, inverted from the call side.
    if (strongest) {
      add('Support above strike', clamp(strongest.strength / 4.5, 0, 20),
        `${protecting.length} support level${protecting.length === 1 ? '' : 's'} between spot and this strike; ` +
        `the strongest sits at ${strongest.price.toFixed(2)} with ${strongest.touches} touches. ` +
        `Price has to break it before the strike is threatened.`);
    } else {
      add('Support above strike', -6,
        'No clustered support between spot and this strike — nothing structural slows a decline into it.');
    }

    // Unique to puts: assignment hands you the shares, so the basis has to be
    // a price worth owning at.
    if (basisVs200 != null) {
      if (basis < sma200) {
        add('Basis below the 200-day', 9,
          `Assignment would hand you stock at ${basis.toFixed(2)}, ${Math.abs(basisVs200).toFixed(1)}% below the 200-day average — a historically reasonable place to be long`);
      } else {
        add('Basis above the 200-day', -7,
          `Assignment would hand you stock at ${basis.toFixed(2)}, ${basisVs200.toFixed(1)}% above the 200-day average — you would be long at a stretched price`);
      }
    }

    if (belowFloor) {
      add('Conflicts with our own target', -18,
        `Sits above ${thesis.maximumSafeStrike.toFixed(2)}, where this model's confirmed bearish projection points.`);
    } else if (belowSoftFloor) {
      add('Above an untriggered target', -7,
        `Sits above ${thesis.softFloor.toFixed(2)}, projected by a formation that has not triggered — a caution, not a veto.`);
    } else if (thesis.maximumSafeStrike != null || thesis.softFloor != null) {
      add('Clears our own target', 10,
        `Below the ${(thesis.maximumSafeStrike ?? thesis.softFloor).toFixed(2)} floor implied by the model's bearish projection.`);
    }

    if (sigma != null) {
      const cushion = sigma < 1.4 ? (sigma - 0.7) * 11 : Math.max(0, 7.7 - (sigma - 1.4) * 6);
      add('Expected-move cushion', clamp(cushion, -8, 8),
        `${sigma.toFixed(2)} standard deviations below spot on the ${dte}-day expected move`);
    }

    let liq = 0;
    const liqNotes = [];
    if (spreadPct != null && spreadPct > 25) { liq -= 12; liqNotes.push(`${spreadPct.toFixed(0)}% bid-ask spread`); }
    else if (spreadPct != null && spreadPct > 12) { liq -= 5; liqNotes.push(`${spreadPct.toFixed(0)}% spread`); }
    if (c.openInterest < 10) { liq -= 8; liqNotes.push(`only ${c.openInterest} open interest`); }
    else if (c.openInterest < 50) { liq -= 3; liqNotes.push(`${c.openInterest} open interest`); }
    if (liq < 0) add('Liquidity drag', liq, `Hard to work a fill: ${liqNotes.join(', ')}`);

    rows.push({
      occ: c.occ,
      strike: c.strike,
      otmPct: Number(otmPct.toFixed(2)),
      bid, ask: c.ask, mid: Number(mid.toFixed(3)),
      spreadPct: spreadPct == null ? null : Number(spreadPct.toFixed(1)),
      iv: c.iv == null ? null : Number((c.iv * 100).toFixed(1)),
      delta: c.delta == null ? null : Number(c.delta.toFixed(3)),
      theta: c.theta == null ? null : Number(c.theta.toFixed(4)),
      openInterest: c.openInterest,
      volume: c.volume,
      collateral: Number(collateral.toFixed(2)),
      premiumPct: Number(premiumPct.toFixed(2)),
      annualised: Number(annualised.toFixed(1)),
      effectiveBasis: Number(basis.toFixed(2)),
      basisVsSpot: Number(basisVsSpot.toFixed(2)),
      basisVs200: basisVs200 == null ? null : Number(basisVs200.toFixed(2)),
      sigmaDistance: sigma == null ? null : Number(sigma.toFixed(2)),
      supportCount: protecting.length,
      strongestSupport: strongest ? { price: strongest.price, touches: strongest.touches, strength: strongest.strength } : null,
      historicalBreach: breach,
      aboveThesisFloor: belowFloor,
      // Same scale as the call side, but not a like-for-like number: the put
      // side carries one criterion with no call equivalent - whether the
      // assignment basis is a price worth owning at - so it can reach roughly
      // seven points higher on an otherwise identical setup. Compare scores
      // within a panel freely; across panels, treat it as a rough guide.
      score: clamp(Math.round(32 + parts.reduce((s, p) => s + p.points, 0) * 0.78), 0, 100),
      components: parts.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    });
  }

  return rows.sort((a, b) => b.score - a.score);
}

function buildVerdict(vol, thesis, skew, best) {
  const reasons = [];
  let verdict = 'acceptable';

  if (vol.verdict === 'cheap') {
    verdict = 'unfavourable';
    reasons.push(vol.verdictDetail);
  } else {
    reasons.push(vol.verdictDetail);
  }

  if (skew) reasons.push(skew.note);

  if (thesis.stance === 'fighting the model') {
    verdict = 'unfavourable';
    reasons.push(
      `This is where put selling does the most damage: a negative read plus a live bearish formation. ` +
      `If you sell here, stay below ${thesis.maximumSafeStrike?.toFixed(2)} or accept that you are ` +
      `underwriting the decline the model is forecasting.`
    );
  } else if (thesis.stance === 'caution') {
    reasons.push(...thesis.reasons);
  } else if (thesis.stance === 'supportive') {
    if (vol.verdict === 'rich') verdict = 'favourable';
    reasons.push(thesis.supportive);
  }

  if (vol.verdict === 'rich' && thesis.stance === 'clear') verdict = 'favourable';
  if (!best) {
    verdict = 'unfavourable';
    reasons.push('No out-of-the-money put in this expiry pays enough to be worth the collateral.');
  }

  return { verdict, reasons: reasons.filter(Boolean) };
}

export async function analyzeCashSecuredPuts({ symbol, expiry: requestedExpiry, targetDte = 35 }) {
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
  const skew = putSkew(expiry, chain.spot);
  const thesis = assessThesis(analysis, chain.spot, expiry);
  const strikes = scoreStrikes({ analysis, chain, expiry, vol, thesis });
  const verdict = buildVerdict(vol, thesis, skew, strikes[0]);

  const { dailyBars, ...volOut } = vol;

  return {
    available: true,
    symbol: chain.symbol,
    name: analysis.name,
    spot: chain.spot,
    fetchedAt: chain.fetchedAt,
    expiry: { expiry: expiry.expiry, dte: expiry.dte },
    expiries: chain.expiries
      .filter((e) => e.dte >= 1 && e.puts.length >= 4)
      .map((e) => ({ expiry: e.expiry, dte: e.dte, contracts: e.puts.length })),
    volatility: volOut,
    skew,
    thesis,
    verdict,
    strikes: markTies(strikes.slice(0, 12)),
    composite: analysis.composite,
    sma200: analysis.technical.movingAverages?.sma200 ?? null,
    levels: analysis.technical.levels,
    patterns: analysis.technical.patterns,
  };
}
