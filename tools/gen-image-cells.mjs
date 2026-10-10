// Writes test/image-cells/*.t1: cells that write image files through the patra file window, so the page's
// image channel is tested with files a PROGRAM wrote (no fixture injection). Every Devanagari word below is
// copied from sassembly crates/yantra/tests/memfs_parity.rs (file names खपत्रम् and कपत्रम्, the write member,
// the variable names), never coined here.
// usage: node tools/gen-image-cells.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (f) => readFileSync(join(root, 'test/fixtures', f));
const dev = (n) => String(n).replace(/\d/g, (d) => '०१२३४५६७८९'[d]);
const enc = new TextEncoder();

const HEAD = 'मण्डलम् शृङ्खला ॥\nआयातः अष्टक ।\n\nसार्वजनिक वृत्तिः स्वपरीक्षास्वप्रतिबिम्बम् ददाति न६४ आदि\n' +
  '    चरः मार्गः ॱॱ अङ्कः अन्तः अ८ भवति उक्तम् खपत्रम् इति ।\n' +
  '    चरः स्थितिः ॱॱ अङ्कः अन्तः न६४ भवति ० ।\n';
const TAIL = '    प्रत्यागमनम् ० ।\nइति\n';
// ख (E0 A4 96) and क (E0 A4 95) differ only in their last octet: octet 2 of the path picks the file
const TO_KA = '    ॰ the second file: खपत्रम् becomes कपत्रम् (octet 2 of the path, 150 -> 149)\n    मार्गः अङ्कः २ अन्तः भवति १४९ ।\n';
const fill = (arr, bytes, at = 0) => Array.from(bytes, (b, i) => `    ${arr} अङ्कः ${dev(at + i)} अन्तः भवति ${dev(b)} ।\n`).join('');
const write = (arr, count) => `    चरः ${count} ॱॱ न६४ भवति अष्टकॱपत्रलेखनम् आरभ्य मार्गः ऽ ${arr} ऽ स्थितिः समाप्तम् ।\n`;
const file1 = (bytes) => `    चरः पात्रम् ॱॱ अङ्कः अन्तः अ८ भवति ० ।\n${fill('पात्रम्', bytes)}${write('पात्रम्', 'अवगणनक')}`;
const file2 = (bytes) => `${TO_KA}    चरः पुनःपात्रम् ॱॱ अङ्कः अन्तः अ८ भवति ० ।\n${fill('पुनःपात्रम्', bytes)}${write('पुनःपात्रम्', 'अवगणनख')}`;
const two = (a, b) => HEAD + file1(a) + file2(b) + TAIL;

// A large SVG built by a loop (over 64 KB, so a saved notebook puts it in a side file): head, REPS copies of one
// rect, tail. Written to खपत्रम्.
const REPS = 2400;
const bigHead = enc.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40" width="120" height="80">');
const rect = enc.encode('<rect width="1" height="1"/>');
const bigTail = enc.encode('</svg>');
const big = HEAD +
  `    चरः पात्रम् ॱॱ अङ्कः अन्तः अ८ भवति ० ।\n${fill('पात्रम्', bigHead)}` +
  `    चरः पुनःपात्रम् ॱॱ अङ्कः अन्तः अ८ भवति ० ।\n${fill('पुनःपात्रम्', rect)}` +
  `    चरः योगफलम् ॱॱ न६४ भवति ${dev(bigHead.length)} ।\n` +
  '    चरः क्रमः ॱॱ न६४ भवति ० ।\n' +
  '    चरः गणना ॱॱ न६४ भवति ० ।\n' +
  '    चरः ज ॱॱ न६४ भवति ० ।\n' +
  `    यावत् क्रमः न्यूनम् ${dev(REPS)} आदि\n` +
  '        गणना भवति ० ।\n' +
  `        यावत् गणना न्यूनम् ${dev(rect.length)} आदि\n` +
  '            ज भवति योगफलम् योगः गणना ।\n' +
  '            पात्रम् अङ्कः ज अन्तः भवति पुनःपात्रम् अङ्कः गणना अन्तः ।\n' +
  '            गणना भवति गणना योगः १ ।\n' +
  '        इति\n' +
  `        योगफलम् भवति योगफलम् योगः ${dev(rect.length)} ।\n` +
  '        क्रमः भवति क्रमः योगः १ ।\n' +
  '    इति\n' +
  Array.from(bigTail, (b, i) => `    ज भवति योगफलम् योगः ${dev(i)} ।\n    पात्रम् अङ्कः ज अन्तः भवति ${dev(b)} ।\n`).join('') +
  write('पात्रम्', 'अवगणनक') + TAIL;

const out = join(root, 'test/image-cells');
mkdirSync(out, { recursive: true });
const cells = {
  'png_and_svg.t1': two(fx('small.png'), fx('ok.svg')),
  'other_png_and_svg.t1': two(fx('other.png'), fx('ok.svg')),
  // the small fixtures keep the compile inside the step budget (about 3M compile steps per byte statement)
  'jpeg_and_hostile_svg.t1': two(fx('tiny.jpg'), fx('hostile-small.svg')),
  'big_svg.t1': big,
};
for (const [n, s] of Object.entries(cells)) writeFileSync(join(out, n), s);
writeFileSync(join(out, 'big_svg.expected'), Buffer.concat([bigHead, ...Array(REPS).fill(rect), bigTail]));
console.log(Object.keys(cells).join(' '));
