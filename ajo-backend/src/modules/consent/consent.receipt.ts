import path from 'path';
import PDFDocument from 'pdfkit';

const FONT_DIR = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const REG = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');
const CLAY = '#C2410C';
const GOLD = '#F6B33D';
const INK = '#2A1712';

export interface ConsentReceiptData {
  receiptNo: string;
  documentTitle: string;
  documentVersion: number;
  documentSha256: string;
  signerName: string;
  signedAt: Date;
  groupName?: string;
  translationLanguage: string;
  translationStatus: string;
  translationHash?: string | null;
  signatureHash: string;
  witnessName?: string | null;
  demo: boolean;
}

/** A signed receipt: who signed which version of the ORIGINAL text, what they read, and the hashes that prove it. */
export function buildConsentReceiptPdf(d: ConsentReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width;

    doc.rect(0, 0, W, 90).fill(CLAY);
    doc.fillColor('#FFFFFF').font(BOLD).fontSize(22).text('CC-ÀJỌ · Signed consent', 50, 34);
    doc.rect(0, 90, W, 5).fill(GOLD);

    if (d.demo) doc.fillColor('#B3261E').font(BOLD).fontSize(12).text('DRAFT · DEMO MODE · not yet approved by a lawyer', 50, 108);

    let y = 140;
    const row = (label: string, value: string) => {
      doc.fillColor('#7A5C50').font(REG).fontSize(10).text(label, 50, y, { width: 150 });
      doc.fillColor(INK).font(BOLD).fontSize(11).text(value, 210, y, { width: W - 260 });
      y = Math.max(y + 24, doc.y + 8);
    };
    row('Receipt', d.receiptNo);
    row('Document', `${d.documentTitle} (version ${d.documentVersion}, controlling English text)`);
    row('Signed by', d.signerName);
    if (d.groupName) row('Group', d.groupName);
    row('Signed on', d.signedAt.toUTCString());
    row('Language read', `${d.translationLanguage} · ${d.translationStatus.replace(/_/g, ' ').toLowerCase()}`);
    if (d.witnessName) row('Witness', d.witnessName);
    y += 8;
    doc.moveTo(50, y).lineTo(W - 50, y).strokeColor(GOLD).lineWidth(1).stroke();
    y += 14;
    row('Document hash (SHA-256)', d.documentSha256);
    if (d.translationHash) row('Translation hash', d.translationHash);
    row('Signature hash', d.signatureHash);

    doc.page.margins.bottom = 0;
    doc.fillColor(INK).font(REG).fontSize(9).text(
      'The signature is on the controlling English original. A translation is only a help to understand it. CC-ÀJỌ records this consent and does not hold or guarantee your money in collector-custody groups.',
      50, doc.page.height - 80, { align: 'center', width: W - 100 },
    );
    doc.end();
  });
}
