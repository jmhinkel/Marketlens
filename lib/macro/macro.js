// Turns factor readings into an asset-specific macro score.
//
// The weight applied to each factor is not purely a hand-set prior. It is the
// prior scaled by how strongly this asset has ACTUALLY moved with that factor
// over the last few months. That does two useful things: it adapts when a
// regime changes, and it surfaces the cases where an asset is trading against
// its textbook relationship, which is usually the most interesting thing on
// the page.
import { fetchDailyCloses } from '../data/yahoo.js';
import { correlation } from '../ta/indicators.js';
import { classify, dollarSignFor } from './profiles.js';
import { loadMacroInputs, buildFactors, PROXIES } from './factors.js';

const CORRELATION_WINDOW = 90;

// Daily returns on the dates two series share, so correlation is not thrown
// off by different holiday calendars (crypto trades weekends, copper does not).
function alignedReturns(mapA, mapB, window) {
  if (!mapA || !mapB) return null;
  const dates = Object.keys(mapA)
    .filter((d) => mapB[d] != null)
    .sort();
  if (dates.length < 40) return null;
  const use = dates.slice(-(window + 1));
  const ra = [];
  const rb = [];
  for (let i = 1; i < use.length; i++) {
    const a0 = mapA[use[i - 1]];
    const b0 = mapB[use[i - 1]];
    if (!a0 || !b0) continue;
    ra.push((mapA[use[i]] - a0) / a0);
    rb.push((mapB[use[i]] - b0) / b0);
  }
  return ra.length >= 30 ? { ra, rb } : null;
}

export async function analyzeMacro(symbol, meta, assetContext) {
  const profile = classify(symbol, meta);
  const inputs = await loadMacroInputs();
  const factors = buildFactors(inputs, assetContext);

  // The asset's own daily closes, for the correlation pass.
  let assetCloses = null;
  try {
    assetCloses = await fetchDailyCloses(symbol, 3);
  } catch {
    assetCloses = null;
  }

  const entries = [];
  for (const [id, spec] of Object.entries(profile.factors)) {
    const factor = factors[id];
    if (!factor) continue;

    // FX flips the dollar factor depending on quote convention.
    let sign = spec.sign;
    if (id === 'dollar' && profile.key === 'fx') sign = dollarSignFor(symbol);

    // Empirical check: how has this asset actually co-moved with the factor's
    // proxy lately?
    let observed = null;
    const proxySymbol = factor.proxy ? PROXIES[factor.proxy] : null;
    if (proxySymbol && assetCloses && proxySymbol !== symbol) {
      const aligned = alignedReturns(assetCloses, inputs.market[factor.proxy], CORRELATION_WINDOW);
      if (aligned) {
        const c = correlation(aligned.ra, aligned.rb);
        if (c != null) observed = Number(c.toFixed(2));
      }
    }

    // Evidence multiplier: a factor the asset is currently tracking closely
    // gets more weight than one it has decoupled from.
    //
    // Guard against tautology. Some proxies are near-identical to the asset
    // itself - IBIT against BTC-USD is a bitcoin ETF against bitcoin, and it
    // correlates ~0.96 by construction. That is not evidence the factor
    // matters, so a correlation that high is treated as no information.
    const tautological = observed != null && Math.abs(observed) > 0.9;
    const evidence = observed == null || tautological ? 1 : 0.65 + 0.7 * Math.abs(observed);

    // Does the market disagree with the textbook sign? VIX is the exception -
    // its proxy moves inversely to risk appetite by construction, so the
    // expected correlation is already flipped.
    const proxyInverted = factor.proxy === 'vix';
    const expectedSign = proxyInverted ? -sign : sign;
    const conflict =
      !tautological && observed != null && Math.abs(observed) > 0.25 && observed * expectedSign < 0;

    entries.push({
      id,
      label: factor.label,
      priorWeight: spec.weight,
      sign,
      note: spec.note,
      stance: Number((factor.stance ?? 0).toFixed(3)),
      value: factor.value,
      detail: factor.detail,
      source: factor.source,
      confidence: factor.confidence,
      observedCorrelation: observed,
      tautological,
      evidence,
      conflict,
      rawWeight: spec.weight * evidence,
    });
  }

  // Renormalise so the weights still sum to 1 after the evidence adjustment.
  const totalWeight = entries.reduce((s, e) => s + e.rawWeight, 0) || 1;
  for (const e of entries) {
    e.weight = e.rawWeight / totalWeight;
    // A factor the asset trades AGAINST should not be scored with the
    // textbook sign. Follow the market: flip the sign and say so.
    const effectiveSign = e.conflict ? -e.sign : e.sign;
    e.effectiveSign = effectiveSign;
    e.contribution = Number((e.stance * effectiveSign * e.weight * 100).toFixed(2));
  }

  entries.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const score = Math.max(-100, Math.min(100, Math.round(entries.reduce((s, e) => s + e.contribution, 0) * 1.6)));

  const proxyCount = entries.filter((e) => e.confidence === 'proxy').length;
  const dataQuality = {
    fredConnected: inputs.hasFred,
    proxyFactors: proxyCount,
    note: inputs.hasFred
      ? 'Economic series pulled live from FRED.'
      : 'No FRED key configured - real rates, liquidity and inflation are running on market proxies. The curve still comes from the US Treasury feed.',
  };

  return {
    profile: {
      key: profile.key,
      label: profile.label,
      thesis: profile.thesis,
      confidence: profile.confidence,
      note: profile.note,
    },
    score,
    factors: entries,
    conflicts: entries.filter((e) => e.conflict),
    dataQuality,
  };
}
