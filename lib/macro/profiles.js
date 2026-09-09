// Asset classification and the prior weight each macro factor carries for that
// class.
//
// Two numbers per factor:
//   weight - how much this factor matters for this asset (weights sum to 1)
//   sign   - +1 if a RISING factor reading is bullish for the asset,
//            -1 if a rising reading is bearish
//
// The sign is what makes the same factor cut opposite ways across assets:
// rising real rates are a headwind for gold and bitcoin (sign -1) but barely
// register for copper, where Chinese construction demand dominates.
//
// These are priors. macro.js blends them with the correlation actually
// observed in the last few months, so a regime change shows up as a
// disagreement between the prior and the market instead of being papered over.

export const PROFILES = {
  industrial_metal: {
    label: 'Industrial metal',
    thesis:
      'Priced off physical demand from construction and manufacturing, with China the marginal buyer. ' +
      'The dollar matters because the contract is dollar-denominated; supply disruptions in Chile, Peru and the DRC set the floor.',
    factors: {
      china_growth: { weight: 0.22, sign: 1, note: 'China is roughly half of global refined copper demand' },
      global_growth: { weight: 0.17, sign: 1, note: 'Manufacturing and construction cycle drives volume' },
      dollar: { weight: 0.15, sign: -1, note: 'Dollar-denominated, so a stronger dollar mechanically pressures price' },
      geopolitical_risk: { weight: 0.09, sign: 1, note: 'Mine supply is concentrated in politically exposed jurisdictions - disruption is bullish' },
      inflation: { weight: 0.07, sign: 1, note: 'Real-asset bid and cost pass-through' },
      real_rates: { weight: 0.07, sign: -1, note: 'Carry cost of holding inventory' },
      risk_appetite: { weight: 0.07, sign: 1, note: 'Trades as a cyclical risk asset' },
      energy: { weight: 0.06, sign: 1, note: 'Smelting and haulage set the cost curve' },
      seasonality: { weight: 0.05, sign: 1, note: 'Restocking cycles ahead of construction season' },
      positioning_stretch: { weight: 0.05, sign: -1, note: 'Stretched positioning invites mean reversion' },
    },
  },

  crypto: {
    label: 'Crypto asset',
    thesis:
      'A long-duration liquidity asset with no cash flow. It trades on the marginal dollar available for speculation: ' +
      'central bank liquidity, real rates, and the flow through spot ETFs and treasury-holding companies.',
    factors: {
      liquidity: { weight: 0.24, sign: 1, note: 'The dominant driver - crypto is the highest-beta expression of liquidity' },
      risk_appetite: { weight: 0.18, sign: 1, note: 'Sells off with equities in genuine risk-off episodes' },
      crypto_flows: { weight: 0.16, sign: 1, note: 'Spot ETF and treasury-company demand is the current marginal buyer' },
      real_rates: { weight: 0.15, sign: -1, note: 'Zero-yield asset - a higher risk-free rate raises the hurdle to hold it' },
      dollar: { weight: 0.09, sign: -1, note: 'Inverse to the dollar as a global liquidity gauge' },
      inflation: { weight: 0.05, sign: 1, note: 'Debasement thesis - weak empirically, strong narratively' },
      geopolitical_risk: { weight: 0.05, sign: 1, note: 'Cuts both ways: capital-flight bid against risk-off selling' },
      positioning_stretch: { weight: 0.05, sign: -1, note: 'Leverage flushes are violent and frequent' },
      seasonality: { weight: 0.03, sign: 1, note: 'Weak signal - the sample is short' },
    },
  },

  precious_metal: {
    label: 'Precious metal',
    thesis:
      'A zero-coupon claim on monetary distrust. The real yield on Treasuries is its opportunity cost, ' +
      'and geopolitical stress plus central bank buying provide the bid the rates model cannot explain.',
    factors: {
      real_rates: { weight: 0.26, sign: -1, note: 'The textbook driver - gold pays nothing, so real yield is the hurdle' },
      geopolitical_risk: { weight: 0.18, sign: 1, note: 'Reserve diversification and crisis hedging' },
      dollar: { weight: 0.16, sign: -1, note: 'Priced in dollars and held as a dollar alternative' },
      inflation: { weight: 0.10, sign: 1, note: 'Store-of-value bid when price stability is questioned' },
      liquidity: { weight: 0.10, sign: 1, note: 'Monetary expansion supports hard assets' },
      risk_appetite: { weight: 0.08, sign: -1, note: 'Safe haven - benefits when risk appetite falls' },
      positioning_stretch: { weight: 0.07, sign: -1, note: 'Crowded trades correct' },
      seasonality: { weight: 0.05, sign: 1, note: 'Physical demand cycles around Indian and Chinese buying seasons' },
    },
  },

  energy: {
    label: 'Energy commodity',
    thesis:
      'Supply is politically administered and demand is cyclical. Geopolitics sets the risk premium, ' +
      'the global growth cycle sets the volume, and inventories decide how violently the two collide.',
    factors: {
      geopolitical_risk: { weight: 0.22, sign: 1, note: 'Production is concentrated in conflict-exposed regions' },
      global_growth: { weight: 0.22, sign: 1, note: 'Consumption tracks industrial activity and transport' },
      china_growth: { weight: 0.10, sign: 1, note: 'The largest marginal importer' },
      dollar: { weight: 0.10, sign: -1, note: 'Dollar-denominated pricing' },
      positioning_stretch: { weight: 0.10, sign: -1, note: 'Prone to sharp spike reversals' },
      risk_appetite: { weight: 0.08, sign: 1, note: 'Trades with the cyclical complex' },
      seasonality: { weight: 0.07, sign: 1, note: 'Driving season and heating demand are real and recurring' },
      inflation: { weight: 0.06, sign: 1, note: 'Both a cause and a consequence of headline inflation' },
      real_rates: { weight: 0.05, sign: -1, note: 'Storage carry cost' },
    },
  },

  equity_index: {
    label: 'Equity index',
    thesis:
      'A claim on nominal corporate earnings discounted at the real rate. Growth sets the numerator, ' +
      'rates and liquidity set the denominator, and risk appetite decides the multiple.',
    factors: {
      global_growth: { weight: 0.22, sign: 1, note: 'Earnings track nominal activity' },
      liquidity: { weight: 0.18, sign: 1, note: 'Multiple expansion follows liquidity' },
      risk_appetite: { weight: 0.18, sign: 1, note: 'Credit and volatility set the multiple' },
      real_rates: { weight: 0.16, sign: -1, note: 'The discount rate on future earnings' },
      yield_curve: { weight: 0.08, sign: -1, note: 'Rapid steepening out of inversion has historically preceded recession' },
      inflation: { weight: 0.06, sign: -1, note: 'Margin pressure and a higher discount rate' },
      geopolitical_risk: { weight: 0.06, sign: -1, note: 'Risk premium widens on conflict' },
      positioning_stretch: { weight: 0.03, sign: -1, note: 'Extension from trend' },
      seasonality: { weight: 0.03, sign: 1, note: 'Modest but persistent calendar effects' },
    },
  },

  equity_single: {
    label: 'Single stock',
    thesis:
      'Mostly the market plus a sector tilt. Company-specific catalysts - earnings, guidance, litigation - ' +
      'are not in this model, so treat the macro read as the backdrop rather than the thesis.',
    factors: {
      equity_beta: { weight: 0.30, sign: 1, note: 'Most single-stock variance is just the index' },
      global_growth: { weight: 0.14, sign: 1, note: 'Revenue cyclicality' },
      real_rates: { weight: 0.14, sign: -1, note: 'Discount rate, heaviest on long-duration growth names' },
      risk_appetite: { weight: 0.14, sign: 1, note: 'Multiple compression in risk-off' },
      liquidity: { weight: 0.10, sign: 1, note: 'Flows into equity as an asset class' },
      positioning_stretch: { weight: 0.06, sign: -1, note: 'Extension from trend' },
      geopolitical_risk: { weight: 0.05, sign: -1, note: 'Supply chain and demand disruption' },
      inflation: { weight: 0.04, sign: -1, note: 'Input cost pressure' },
      seasonality: { weight: 0.03, sign: 1, note: 'Calendar effects' },
    },
  },

  fx: {
    label: 'FX pair',
    thesis:
      'A relative price of two monetary policies. Rate differentials and growth differentials dominate; ' +
      'risk appetite decides whether the funding currency or the carry currency wins.',
    factors: {
      dollar: { weight: 0.35, sign: 1, note: 'Sign is set by the quote convention of the pair' },
      yield_curve: { weight: 0.20, sign: 1, note: 'US curve shape only - the model has no feed for the other leg, so a true rate differential is NOT measured here' },
      risk_appetite: { weight: 0.15, sign: 1, note: 'Carry trades unwind in risk-off' },
      global_growth: { weight: 0.10, sign: 1, note: 'Relative growth momentum' },
      geopolitical_risk: { weight: 0.10, sign: -1, note: 'Safe-haven flows dominate in crisis' },
      inflation: { weight: 0.05, sign: 1, note: 'Feeds policy expectations' },
      positioning_stretch: { weight: 0.05, sign: -1, note: 'Crowded FX trades reverse hard' },
    },
  },

  bond: {
    label: 'Bond / rates',
    thesis:
      'Price is the inverse of yield, so every factor that pushes yields up pushes this down. ' +
      'Growth and inflation set the level; risk-off sets the flight-to-quality bid.',
    factors: {
      real_rates: { weight: 0.30, sign: -1, note: 'Yields up, price down - the mechanical relationship' },
      inflation: { weight: 0.20, sign: -1, note: 'Erodes the fixed coupon and lifts term premium' },
      global_growth: { weight: 0.15, sign: -1, note: 'Strong growth lifts yields' },
      risk_appetite: { weight: 0.15, sign: -1, note: 'Flight to quality bids bonds when risk appetite falls' },
      liquidity: { weight: 0.10, sign: 1, note: 'Central bank purchases suppress yields' },
      geopolitical_risk: { weight: 0.05, sign: 1, note: 'Safe-haven demand' },
      positioning_stretch: { weight: 0.05, sign: -1, note: 'Extension from trend' },
    },
  },

  agriculture: {
    label: 'Agricultural commodity',
    thesis:
      'Weather and acreage dominate the supply side and are not in this model. What is here: ' +
      'the dollar, energy costs that flow through fertiliser and diesel, and export-market politics.',
    factors: {
      geopolitical_risk: { weight: 0.18, sign: 1, note: 'Export bans and Black Sea shipping have repriced grains repeatedly' },
      dollar: { weight: 0.15, sign: -1, note: 'Dollar pricing sets import affordability' },
      energy: { weight: 0.15, sign: 1, note: 'Fertiliser, diesel and biofuel demand linkage' },
      seasonality: { weight: 0.12, sign: 1, note: 'Planting and harvest cycles are the strongest calendar effect in commodities' },
      china_growth: { weight: 0.12, sign: 1, note: 'The dominant import buyer for soy and corn' },
      inflation: { weight: 0.12, sign: 1, note: 'Food is a core inflation component' },
      positioning_stretch: { weight: 0.08, sign: -1, note: 'Fund positioning swings are large relative to open interest' },
      global_growth: { weight: 0.08, sign: 1, note: 'Protein demand tracks income growth' },
    },
  },
};

const CRYPTO_HINT = /-USD$/;
const FUTURE_HINT = /=F$/;
const FX_HINT = /=X$/;

const EXPLICIT = {
  'HG=F': 'industrial_metal', 'ALI=F': 'industrial_metal',
  'GC=F': 'precious_metal', 'SI=F': 'precious_metal', 'PL=F': 'precious_metal', 'PA=F': 'precious_metal',
  GLD: 'precious_metal', SLV: 'precious_metal', IAU: 'precious_metal', PPLT: 'precious_metal',
  'CL=F': 'energy', 'BZ=F': 'energy', 'NG=F': 'energy', 'RB=F': 'energy', 'HO=F': 'energy',
  USO: 'energy', UNG: 'energy', XLE: 'energy',
  'ZC=F': 'agriculture', 'ZW=F': 'agriculture', 'ZS=F': 'agriculture', 'KC=F': 'agriculture',
  'CT=F': 'agriculture', 'SB=F': 'agriculture', 'CC=F': 'agriculture', 'LE=F': 'agriculture',
  'ES=F': 'equity_index', 'NQ=F': 'equity_index', 'YM=F': 'equity_index', 'RTY=F': 'equity_index',
  SPY: 'equity_index', QQQ: 'equity_index', IWM: 'equity_index', DIA: 'equity_index',
  VTI: 'equity_index', VOO: 'equity_index', EFA: 'equity_index', EEM: 'equity_index', FXI: 'equity_index',
  TLT: 'bond', IEF: 'bond', SHY: 'bond', AGG: 'bond', BND: 'bond', LQD: 'bond', HYG: 'bond',
  'ZN=F': 'bond', 'ZB=F': 'bond', 'ZF=F': 'bond',
  COPX: 'industrial_metal', JJC: 'industrial_metal',
};

// Copper miners and gold miners trade as leveraged proxies for the metal, not
// as ordinary equities, so classify them with the underlying.
const MINER_HINTS = {
  precious_metal: ['GDX', 'GDXJ', 'NEM', 'GOLD', 'AEM', 'KGC', 'AU', 'WPM', 'FNV'],
  industrial_metal: ['FCX', 'SCCO', 'TECK', 'BHP', 'RIO', 'VALE'],
};

export function classify(symbol, meta = {}) {
  const s = (symbol || '').toUpperCase();

  if (EXPLICIT[s]) return { key: EXPLICIT[s], ...PROFILES[EXPLICIT[s]], confidence: 'explicit' };

  for (const [key, list] of Object.entries(MINER_HINTS)) {
    if (list.includes(s)) {
      return {
        key,
        ...PROFILES[key],
        confidence: 'mapped',
        note: 'Classified with the underlying metal - miners trade as a leveraged proxy, with equity beta and cost inflation on top.',
      };
    }
  }

  if (CRYPTO_HINT.test(s) || meta.quoteType === 'CRYPTOCURRENCY')
    return { key: 'crypto', ...PROFILES.crypto, confidence: 'inferred' };
  if (FX_HINT.test(s) || meta.quoteType === 'CURRENCY')
    return { key: 'fx', ...PROFILES.fx, confidence: 'inferred' };
  if (s.startsWith('^')) return { key: 'equity_index', ...PROFILES.equity_index, confidence: 'inferred' };
  if (FUTURE_HINT.test(s)) return { key: 'industrial_metal', ...PROFILES.industrial_metal, confidence: 'guess' };

  return { key: 'equity_single', ...PROFILES.equity_single, confidence: 'inferred' };
}

// For an FX pair the dollar factor flips depending on which side the dollar is
// quoted on: USDJPY rises when the dollar strengthens, EURUSD falls.
export function dollarSignFor(symbol) {
  const base = (symbol || '').toUpperCase().replace('=X', '');
  if (base.startsWith('USD')) return 1;
  return -1;
}
