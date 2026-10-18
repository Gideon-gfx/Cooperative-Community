// Bake-off: runs the reading adapters over a folder of real ledger pages and reports field-level accuracy against a
// hand-keyed answer file. Target: at least 85% of fields correct BEFORE human review (humans review everything anyway).
//
//   npx ts-node --transpile-only scripts/ocr-bakeoff.ts <folder> [recordType] [language]
//
// <folder> holds page images (jpg/png/webp) and, for each, an answer file with the same name and a .json extension:
//   page-01.jpg  +  page-01.json  =  [ { "name": "Adé Bello", "date": "14/03/2023", "amount": "5000", "cycleLabel": "Week 3" }, ... ]
// Needs ANTHROPIC_API_KEY (vision model) and/or GOOGLE_VISION_API_KEY (Google Cloud Vision).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { RecordType } from '@prisma/client';
import { GoogleVisionOcrProvider, VisionModelOcrProvider, type OcrProvider } from '../src/modules/records/ocr.provider';
import { FIELDS, scoreOcr } from '../src/modules/records/records.logic';

const [folder, type = 'CONTRIBUTIONS', language = 'en'] = process.argv.slice(2);
if (!folder) { console.error('Usage: ocr-bakeoff.ts <folder> [recordType] [language]'); process.exit(1); }
const recordType = type as RecordType;
const fields = [...FIELDS[recordType].required, ...FIELDS[recordType].optional].filter((f) => f !== 'phone');
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const providers: OcrProvider[] = [];
if (process.env.ANTHROPIC_API_KEY) providers.push(new VisionModelOcrProvider());
if (process.env.GOOGLE_VISION_API_KEY) providers.push(new GoogleVisionOcrProvider());
if (!providers.length) { console.error('Set ANTHROPIC_API_KEY and/or GOOGLE_VISION_API_KEY'); process.exit(1); }

(async () => {
  const pages = fs.readdirSync(folder).filter((f) => MIME[path.extname(f).toLowerCase()]).sort();
  const answered = pages.filter((p) => fs.existsSync(path.join(folder, p.replace(/\.[^.]+$/, '.json'))));
  console.log(`${pages.length} pages, ${answered.length} with answer files, fields: ${fields.join(', ')}\n`);
  for (const provider of providers) {
    let correct = 0, total = 0, extra = 0, failed = 0;
    const perField: Record<string, { correct: number; total: number }> = Object.fromEntries(fields.map((f) => [f, { correct: 0, total: 0 }]));
    for (const page of answered) {
      const expected = JSON.parse(fs.readFileSync(path.join(folder, page.replace(/\.[^.]+$/, '.json')), 'utf8')) as Record<string, string>[];
      try {
        const res = await provider.extract({ data: fs.readFileSync(path.join(folder, page)), mime: MIME[path.extname(page).toLowerCase()], recordType, language });
        const s = scoreOcr(res.rows.map((r) => r.fields), expected, fields);
        correct += s.correct; total += s.total; extra += s.extraRows;
        for (const f of fields) { perField[f].correct += s.perField[f].correct; perField[f].total += s.perField[f].total; }
        console.log(`  ${provider.name} ${page}: ${(s.accuracy * 100).toFixed(0)}% (${s.correct}/${s.total})${s.extraRows ? `, ${s.extraRows} extra rows` : ''}`);
      } catch (e) { failed++; console.log(`  ${provider.name} ${page}: FAILED ${(e as Error).message}`); }
    }
    const acc = total ? (correct / total) * 100 : 0;
    console.log(`\n${provider.name}: ${acc.toFixed(1)}% of fields correct (${correct}/${total}), ${extra} extra rows, ${failed} failed pages ${acc >= 85 ? '✔ meets the 85% target' : '✘ below the 85% target'}`);
    for (const f of fields) console.log(`    ${f.padEnd(12)} ${perField[f].total ? ((perField[f].correct / perField[f].total) * 100).toFixed(0) : '-'}%`);
    console.log('');
  }
})();
