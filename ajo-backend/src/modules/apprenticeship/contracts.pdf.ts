import fs from 'fs/promises';
import path from 'path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { UPLOAD_ROOT } from '../../services/storage.service';

const FONT_DIR = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const REG = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');
const CLAY = '#C2410C';
const GOLD = '#F6B33D';
const INK = '#2A1712';

export interface ContractPdfData {
  contractId: string;
  status: string;
  tradeCategory: string;
  durationMonths: number;
  startDate: Date | null;
  endDate: Date | null;
  groupName: string;
  parties: { role: string; name: string }[];
  monthlyContribution: string;
  targetSettlement: string;
  monthlyStipend: string | null;
  terms: string;
  signatures: { role: string; typedName: string; signedAt: Date; ip: string; imageUrl: string | null }[];
  verifyUrl: string;
}

/** A saved upload, if the signature image is one of ours and still on disk. Anything else is simply skipped. */
export async function localUpload(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  const i = url.indexOf('/files/');
  if (i < 0) return null;
  const rel = decodeURIComponent(url.slice(i + 7));
  const full = path.resolve(UPLOAD_ROOT, rel);
  if (!full.startsWith(UPLOAD_ROOT + path.sep)) return null; // never read outside the uploads folder
  try { return await fs.readFile(full); } catch { return null; }
}

const maskIp = (ip: string) => (ip.includes('.') ? ip.replace(/\.\d+$/, '.•') : ip.replace(/:[0-9a-f]*$/i, ':•'));
const role = (r: string) => ({ MASTER: 'Master', APPRENTICE: 'Apprentice', GUARANTOR: 'Guarantor', PARENT_GUARDIAN: 'Parent or guardian' } as Record<string, string>)[r] ?? r;

/**
 * The signed agreement. It never contains anyone's date of birth or phone number. It states plainly that CC-ÀJỌ records
 * the savings and promises no return.
 */
export async function buildContractPdf(d: ContractPdfData): Promise<Buffer> {
  const qr = await QRCode.toBuffer(d.verifyUrl, { width: 130, margin: 1 });
  const images = await Promise.all(d.signatures.map((s) => localUpload(s.imageUrl)));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width;

    doc.rect(0, 0, W, 90).fill(CLAY);
    doc.fillColor('#FFFFFF').font(BOLD).fontSize(21).text('Igba Boyi: Apprenticeship agreement', 50, 32);
    doc.rect(0, 90, W, 5).fill(GOLD);
    doc.image(qr, W - 150, 105, { width: 100 });
    doc.fillColor('#7A5C50').font(REG).fontSize(8).text(`Agreement ${d.contractId}\nScan to check this agreement`, W - 160, 208, { width: 120, align: 'center' });

    let y = 112;
    const row = (label: string, value: string) => {
      doc.fillColor('#7A5C50').font(REG).fontSize(10).text(label, 50, y, { width: 130 });
      doc.fillColor(INK).font(BOLD).fontSize(11).text(value, 185, y, { width: W - 360 });
      y = Math.max(y + 22, doc.y + 6);
    };
    row('Trade', d.tradeCategory);
    row('Group', d.groupName);
    row('Length', `${d.durationMonths} months`);
    row('Status', d.status.replace(/_/g, ' ').toLowerCase());
    row('Starts', d.startDate ? d.startDate.toISOString().slice(0, 10) : 'when everyone has signed');
    row('Ends', d.endDate ? d.endDate.toISOString().slice(0, 10) : '');
    for (const p of d.parties) row(role(p.role), p.name);
    y += 8;
    row('Monthly savings', `₦${d.monthlyContribution}`);
    row('Savings goal', `₦${d.targetSettlement}`);
    if (d.monthlyStipend) row('Monthly stipend to apprentice', `₦${d.monthlyStipend}`);

    doc.y = Math.max(y + 10, 250); doc.x = 50;
    doc.fillColor(INK).font(BOLD).fontSize(12).text('Terms');
    doc.moveDown(0.4);
    doc.font(REG).fontSize(10).text(d.terms, { width: W - 100, align: 'left' });
    doc.moveDown();
    doc.font(BOLD).fontSize(10).text('About the savings');
    doc.font(REG).fontSize(9).fillColor('#7A5C50').text('The monthly savings are the master’s own money, set aside toward the apprentice’s start-up capital and held in escrow through the payment partner. CC-ÀJỌ records and shows every payment. It does not promise any return or interest, and the amount at the end is only what was paid in.', { width: W - 100 });

    doc.moveDown();
    if (doc.y > doc.page.height - 260) doc.addPage();
    doc.fillColor(INK).font(BOLD).fontSize(12).text('Signatures');
    doc.moveDown(0.5);
    d.signatures.forEach((s, i) => {
      if (doc.y > doc.page.height - 130) doc.addPage();
      const top = doc.y;
      if (images[i]) { try { doc.image(images[i]!, 50, top, { fit: [140, 45] }); } catch { /* an unreadable image is skipped */ } }
      doc.fillColor(INK).font(BOLD).fontSize(10).text(`${role(s.role)}: ${s.typedName}`, 210, top, { width: W - 260 });
      doc.font(REG).fontSize(8).fillColor('#7A5C50').text(`Signed ${s.signedAt.toUTCString()} · from ${maskIp(s.ip)}`, 210, doc.y + 2, { width: W - 260 });
      doc.y = top + 58; doc.x = 50;
    });
    if (!d.signatures.length) doc.font(REG).fontSize(10).text('Not signed yet.');
    doc.end();
  });
}
