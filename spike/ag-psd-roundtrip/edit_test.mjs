// ag-psd edit test: change text of first type layer, hide one pixel layer, then write.
// Usage: node edit_test.mjs <in.psd>  -> out/<name>.edit.psd
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readPsd, writePsd, initializeCanvas } from 'ag-psd';
initializeCanvas(() => { throw new Error('no canvas'); },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));

const f = process.argv[2];
const psd = readPsd(readFileSync(f), { useImageData: true });
const all = []; const walk = ls => (ls || []).forEach(l => { all.push(l); walk(l.children); }); walk(psd.children);
const t = all.find(l => l.text);
if (t) { console.log('text:', JSON.stringify(t.text.text), '-> "<A> edited by ag-psd"'); t.text.text = '<A> edited by ag-psd'; }
const p = all.find(l => !l.text && !l.children && l.name !== all[0].name);
if (p) { console.log('hide layer:', p.name); p.hidden = true; }
const out = `out/${basename(f, '.psd')}.edit.psd`;
writeFileSync(out, Buffer.from(writePsd(psd, { invalidateTextLayers: true })));
console.log('wrote', out);
