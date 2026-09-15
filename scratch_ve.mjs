import { scanUniverse } from './lib/scan.js';
const r = await scanUniverse({ universe: 'vaneck', limit: 6 });
console.log(`scanned ${r.scanned}/${r.scanned + r.failed.length} in ${r.elapsedMs} ms | failed: ${r.failed.map(f=>f.symbol).join(',') || 'none'}\n`);
const show = (t, rows) => {
  console.log(`=== ${t} ===`);
  for (const s of rows) {
    console.log(`${String(s.score).padStart(3)} ${s.symbol.padEnd(6)} ${String(s.name).replace('VanEck ','').slice(0,34).padEnd(35)} px=${String(s.price?.toFixed(2)).padStart(8)} atr=${s.atrPct?.toFixed(2)}%`);
    console.log(`    ${s.pattern ? `${s.pattern.name} [${s.pattern.stage}] trig=${s.pattern.trigger?.toFixed(2)} tgt=${s.pattern.target?.toFixed(2)} inval=${s.pattern.invalidation?.toFixed(2)} rr=${s.pattern.riskReward}` : 'no formation'}`);
  }
  console.log();
};
show('BEST LONGS', r.longs);
show('BEST SHORTS', r.shorts);
