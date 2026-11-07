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
7. Quote numbers the way a person would write them - two decimals on a price,
   one on a percentage. Never reproduce a figure to more decimal places than it
   was given, and never pad one out.
8. Keep the whole briefing under roughly 700 words. Every section must appear;
   brevity comes from cutting restatement, not from dropping a heading.

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

// Round every number in the payload before it is serialised.
//
// Float noise is not harmless here: handed 6.260000228881836 a model will
// faithfully repeat it, and the briefing ends up quoting prices to fifteen
// decimal places. It also wastes a meaningful share of the input budget - the
// raw payload is mostly digits nobody needs.
function roundDeep(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const a = Math.abs(value);
    if (a === 0) return 0;
    // Keep small values (ratios, stances, correlations) usefully precise and
    // large ones (prices, index levels) readable.
    const digits = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
    return Number(value.toFixed(digits));
  }
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = roundDeep(v);
    return out;
  }
  return value;
}

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

// Two backends. Anthropic is used when its key is present; Venice is an
// OpenAI-compatible endpoint, so it needs no SDK at all - just a POST. Set
// LLM_PROVIDER to force one when both keys are configured.
const VENICE_BASE = 'https://api.venice.ai/api/v1';
// gemini-3-6-flash was measured at ~31s for a full briefing with the whole
// payload; the larger models (qwen-3-8-max) ran past two minutes, which is too
// slow for something a person waits on. Override with VENICE_MODEL.
const VENICE_MODEL = process.env.VENICE_MODEL || 'gemini-3-6-flash';

export function activeProvider() {
  const forced = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (forced === 'venice' && process.env.VENICE_API_KEY) return 'venice';
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.VENICE_API_KEY) return 'venice';
  return null;
}

export function llmAvailable() {
  return activeProvider() !== null;
}

export function providerLabel() {
  const p = activeProvider();
  if (p === 'anthropic') return `Anthropic ${MODEL}`;
  if (p === 'venice') return `Venice ${VENICE_MODEL}`;
  return null;
}

// Venice speaks the OpenAI chat-completions shape, so the system prompt moves
// from its own parameter into the first message.
async function callVenice(systemPrompt, userContent) {
  const res = await fetch(`${VENICE_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VENICE_MODEL,
      max_tokens: 12000,
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.text();
      try {
        const parsed = JSON.parse(body);
        detail = parsed.error?.message || parsed.error || body;
      } catch { detail = body; }
    } catch { /* ignore */ }
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
    const hint =
      res.status === 401 ? ' Check VENICE_API_KEY.' :
      res.status === 404 ? ` Model "${VENICE_MODEL}" may not exist - set VENICE_MODEL to one Venice lists.` : '';
    throw new Error(`Venice API ${res.status}: ${String(detail).slice(0, 300)}${hint}`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Venice returned no text.');
  return {
    text,
    model: `venice:${VENICE_MODEL}`,
    usage: {
      input: json.usage?.prompt_tokens ?? null,
      output: json.usage?.completion_tokens ?? null,
    },
  };
}

export async function synthesize(analysis, { question } = {}) {
  const provider = activeProvider();
  if (!provider) {
    return {
      available: false,
      text: null,
      error: 'No model key set. Add ANTHROPIC_API_KEY or VENICE_API_KEY to .env.',
    };
  }

  const payload = roundDeep(compact(analysis));

  const userContent =
    `Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
    `Write the briefing for ${payload.name} (${payload.symbol}) on the ${payload.timeframe} timeframe.\n\n` +
    (question ? `The reader also asked specifically: ${question}\n\n` : '') +
    `ANALYSIS DATA\n${JSON.stringify(payload, null, 1)}`;

  if (provider === 'venice') {
    try {
      const out = await callVenice(SYSTEM, userContent);
      return { available: true, provider: 'venice', ...out };
    } catch (err) {
      return { available: true, provider: 'venice', text: null, error: err.message };
    }
  }

  const client = new Anthropic();

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 12000,
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
      provider: 'anthropic',
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
