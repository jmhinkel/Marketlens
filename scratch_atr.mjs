import { runAnalysis } from './lib/analyze.js';
const syms = ['CBON','CLOI','HYEM','MLN','FLTR','SHYD','ITM','HYD','ANGL','GRNB','PFXF','BIZD','MORT','EMLC','IHY',
              'SPY','TLT','GLD','SMH','GDX','QQQ','IWM','XLU','HYG','MOAT','RTH','BBH'];
const rows = [];
for (const s of syms) {
  try { const a = await runAnalysis({symbol:s, timeframe:'1d', skipMacro:true});
    rows.push([s, a.technical.volatility.atrPct]); } catch(e){}
}
rows.sort((a,b)=>a[1]-b[1]);
console.log('ATR% (daily true range as % of price), ascending:');
for (const [s,v] of rows) console.log(`  ${s.padEnd(6)} ${v.toFixed(3)}%`);
