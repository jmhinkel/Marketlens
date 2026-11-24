// Which options feed the app uses, and the bits that do not depend on it.
//
// This indirection exists because the feed has already been replaced once.
// CBOE's public endpoint was the source until November 2026, when it moved
// behind Cloudflare bot protection and started refusing this server; every
// option panel went dark and reported the outage as "no listed options" for
// forty-four symbols, SPY included. Swapping provider meant touching four
// modules that each imported from cboe.js directly. They now import from here,
// so the next swap is one line.
//
// cboe.js is kept rather than deleted: it holds a working parser for a feed
// that may become reachable again, and the comparison is useful if anyone
// wonders why the greeks are now computed rather than quoted.
export { fetchChain } from './nasdaq.js';

// Assets with no listed options at all - futures, spot crypto, FX, indices we
// cannot trade directly - mapped to the liquid instruments people actually
// trade instead. Ordered most liquid first. Provider-independent, so it lives
// here rather than travelling with whichever feed is current.
export const OPTIONABLE_PROXIES = {
  'HG=F': [
    { symbol: 'FCX', note: 'Freeport-McMoRan - the highest-volume copper options in the US' },
    { symbol: 'COPX', note: 'Global X Copper Miners ETF' },
    { symbol: 'CPER', note: 'US Copper Index Fund - tracks the futures curve directly' },
  ],
  'GC=F': [
    { symbol: 'GLD', note: 'SPDR Gold Shares - deepest gold options' },
    { symbol: 'IAU', note: 'iShares Gold Trust - cheaper contracts, thinner chain' },
    { symbol: 'GDX', note: 'Gold miners - higher beta and richer premium' },
  ],
  'SI=F': [{ symbol: 'SLV', note: 'iShares Silver Trust' }, { symbol: 'SIL', note: 'Silver miners' }],
  'CL=F': [
    { symbol: 'USO', note: 'United States Oil Fund' },
    { symbol: 'XLE', note: 'Energy sector - equity exposure rather than the barrel' },
  ],
  'NG=F': [{ symbol: 'UNG', note: 'United States Natural Gas Fund' }],
  'ZC=F': [{ symbol: 'CORN', note: 'Teucrium Corn Fund - thin chain, check spreads' }],
  'ZW=F': [{ symbol: 'WEAT', note: 'Teucrium Wheat Fund - thin chain' }],
  'ZS=F': [{ symbol: 'SOYB', note: 'Teucrium Soybean Fund - thin chain' }],
  'BTC-USD': [
    { symbol: 'IBIT', note: 'iShares Bitcoin Trust - now the deepest listed bitcoin options' },
    { symbol: 'MSTR', note: 'Strategy - leveraged proxy, far richer premium and far more risk' },
  ],
  'ETH-USD': [{ symbol: 'ETHA', note: 'iShares Ethereum Trust' }],
  '^GSPC': [{ symbol: 'SPY', note: 'SPDR S&P 500 - the most liquid options in the world' }],
  '^NDX': [{ symbol: 'QQQ', note: 'Invesco QQQ' }],
  '^DJI': [{ symbol: 'DIA', note: 'SPDR Dow Jones' }],
  '^RUT': [{ symbol: 'IWM', note: 'iShares Russell 2000' }],
  'ES=F': [{ symbol: 'SPY', note: 'SPDR S&P 500' }],
  'NQ=F': [{ symbol: 'QQQ', note: 'Invesco QQQ' }],
};

// The expiry closest to a target holding period. 30-45 days is the usual
// covered-call window: enough premium to be worth it, fast enough theta decay.
export function pickExpiry(chain, targetDte = 35) {
  const usable = chain.expiries.filter((e) => e.dte >= 7 && e.calls.length >= 4);
  if (!usable.length) return chain.expiries[0] || null;
  return usable.reduce((best, e) =>
    Math.abs(e.dte - targetDte) < Math.abs(best.dte - targetDte) ? e : best
  );
}
