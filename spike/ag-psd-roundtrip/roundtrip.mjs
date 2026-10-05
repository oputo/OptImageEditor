// ag-psd round-trip: read -> write without changes. Usage: node roundtrip.mjs <in.psd>... (writes out/<name>.rt.psd)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { readPsd, writePsd, initializeCanvas } from 'ag-psd';

// No real canvas needed: we only use ImageData (useImageData: true)
initializeCanvas(
  () => { throw new Error('canvas not available'); },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
);

mkdirSync('out', { recursive: true });
for (const f of process.argv.slice(2)) {
  const name = basename(f, '.psd');
  const missing = [];
  const origLog = console.log;
  console.log = (...a) => missing.push(a.join(' '));   // capture logMissingFeatures output
  let t0 = performance.now();
  let psd;
  try {
    psd = readPsd(readFileSync(f), { useImageData: true, logMissingFeatures: true, logDevFeatures: false });
  } finally { console.log = origLog; }
  const tRead = performance.now() - t0;
  const rssRead = process.memoryUsage().rss;
  t0 = performance.now();
  const buf = writePsd(psd, { generateThumbnail: false, trimImageData: false, noBackground: false });
  const tWrite = performance.now() - t0;
  const rssWrite = process.memoryUsage().rss;
  writeFileSync(`out/${name}.rt.psd`, Buffer.from(buf));
  const walk = (ls, d = 0) => (ls || []).flatMap(l => [
    `${'  '.repeat(d)}${l.children ? '[group]' : l.text ? '[type]' : l.adjustment ? '[adj:' + l.adjustment.type + ']' : l.placedLayer ? '[smart]' : '[pixel]'} ${l.name}`
      + (l.effects ? ' fx' : '') + (l.mask ? ' mask' : '') + (l.clipping ? ' clip' : ''),
    ...walk(l.children, d + 1)]);
  console.log(`== ${name}: ${psd.width}x${psd.height} bpc=${psd.bitsPerChannel} mode=${psd.colorMode} read=${tRead.toFixed(0)}ms write=${tWrite.toFixed(0)}ms rss(read)=${(rssRead/2**20).toFixed(0)}MB rss(write)=${(rssWrite/2**20).toFixed(0)}MB`);
  console.log(walk(psd.children).join('\n'));
  if (missing.length) console.log('  missing features:', [...new Set(missing)].slice(0, 20));
}
