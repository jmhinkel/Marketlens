// The written synthesis pass.
//
// Everything numeric is computed before this runs. Claude's job is to explain
// the reading and supply the named real-world context that no free data feed
// provides - not to invent numbers. The system prompt draws that line hard,
// because a plausible-sounding fabricated level is the single most dangerous
// failure mode for a tool like this.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

const SYSTEM = `You are a markets analyst writing a briefing for a professional
who reads charts and follows macro. Your reader is an experienced financial
professional; write for a peer, not a beginner.

You will receive a JSON analysis produced by a deterministic engine: chart
formations detected from price history, computed indicator readings, and a
weighted macro factor model tuned to this asset's class.

HARD RULES

1. Every price, level, target, percentage and indicator value you cite must
   come from the JSON. Never invent, round-trip or estimate a number that is
   not there. If something is not in the data, say it is not measured.
2. The JSON's factor readings are market-derived. They describe what markets
   are PRICING, not a live news feed. Never present them as reports of events.
3. You may add named real-world context - specific policy, conflicts, supply
   disruptions, central bank posture, elections - from your own knowledge.
   When you do, put it under the "Context not in the data" heading and be
   explicit that it is background knowledge with a training cutoff, not live
   reporting, and that the reader should verify anything time-sensitive.
4. Where the technical read and the macro read disagree, say so plainly and
   explain which one usually dominates on this timeframe. Do not split the
   difference to sound balanced.
5. This is analysis, not personalised investment advice, and you are not
   recommending a trade or a position size. Write about what the asset is
   doing and what would change that. Do not tell the reader to buy or sell.
6. No hedging filler. If the read is weak, say the read is weak.

FORMAT

Use these markdown headings exactly, in order:

## The read
Two to four sentences. What is this chart and this macro backdrop actually
saying, together. Lead with the conclusion.

## What the chart shows
The formation, its stage, the levels that define it, the structure and
momentum backdrop. Quote the specific levels.

## The macro weighting
Why THIS asset weights these factors the way it does, what the top factors
currently read, and what that adds up to. Name the two or three that carry
the analysis. If the model found the asset trading against a textbook
relationship, that belongs here and is usually the most interesting thing on
the page.

## Context not in the data
Named real-world situations that bear on this asset, flagged as background
knowledge rather than live data. Say plainly that these need verifying.

## What would change this
The specific levels and factor turns that would break the current read.`;

function compact(analysis) {
  // Trim the payload to what the writer needs. The raw bar arrays and the
  // full indicator series are large and add nothing to the prose.
  const t = analysis.technical;
  return {
    symbol: analysis.symbol,
    name: analysis.name,
    exchange: analysis.exchange,
    currency: analysis.currency,
    timeframe: analysis.timeframeLabel,
    asOf: analysis.generatedAt,
    composite: analysis.composite,
    price: t.price,
    regime: t.regime,
    structure: t.structure,
    movingAverages: t.movingAverages,
    momentum: t.momentum,
    volatility: t.volatility,
    patterns: t.patterns,
    stalePatterns: t.stalePatterns?.map((p) => ({ name: p.name, staleReason: p.staleReason })),
    channel: t.channel && {
      direction: t.channel.direction,
      top: t.channel.top,
      bottom: t.channel.bottom,
      positionInChannel: t.channel.positionInChannel,
    },
    levels: t.levels,
    candles: t.candles,
    volumeProfile: t.volumeProfile && {
      pointOfControl: t.volumeProfile.pointOfControl,
      valueAreaLow: t.volumeProfile.valueAreaLow,
      valueAreaHigh: t.volumeProfile.valueAreaHigh,
    },
    seasonality: t.seasonality?.current,
    technicalContributions: t.contributions,
    macro: analysis.macro && {
      profile: analysis.macro.profile,
      score: analysis.macro.score,
      dataQuality: analysis.macro.dataQuality,
      factors: analysis.macro.factors.map((f) => ({
        label: f.label,
        weightPct: Number((f.weight * 100).toFixed(1)),
        stance: f.stance,
        reading: f.value,
        detail: f.detail,
        source: f.source,
        confidence: f.confidence,
        whyItMatters: f.note,
        observedCorrelation: f.observedCorrelation,
        tradingAgainstTextbookSign: f.conflict,
        contribution: f.contribution,
      })),
    },
    invalidation: analysis.invalidation,
  };
}

export function llmAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function synthesize(analysis, { question } = {}) {
  if (!llmAvailable()) {
    return { available: false, text: null, error: 'ANTHROPIC_API_KEY is not set.' };
  }

  const client = new Anthropic();
  const payload = compact(analysis);

  const userContent =
    `Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
    `Write the briefing for ${payload.name} (${payload.symbol}) on the ${payload.timeframe} timeframe.\n\n` +
    (question ? `The reader also asked specifically: ${question}\n\n` : '') +
    `ANALYSIS DATA\n${JSON.stringify(payload, null, 1)}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      // Opus 5 thinks adaptively by default; medium effort is plenty for
      // explaining numbers that are already computed.
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: userContent }],
    });

    if (response.stop_reason === 'refusal') {
      return { available: true, text: null, error: 'The model declined this request.' };
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return {
      available: true,
      text,
      model: MODEL,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError)
      return { available: true, text: null, error: 'Anthropic rejected the API key.' };
    if (err instanceof Anthropic.RateLimitError)
      return { available: true, text: null, error: 'Rate limited by the Anthropic API - try again shortly.' };
    if (err instanceof Anthropic.APIError)
      return { available: true, text: null, error: `Anthropic API error ${err.status}: ${err.message}` };
    return { available: true, text: null, error: err.message };
  }
}
