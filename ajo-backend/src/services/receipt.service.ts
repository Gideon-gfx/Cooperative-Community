import path from 'path';
import PDFDocument from 'pdfkit';
import { saveFile } from './storage.service';

export interface AjoReceiptData {
  poolTitle: string;
  cycleNumber: number;
  recipientName: string;
  totalCollected: number;
  platformFee: number;
  collectorFee: number;
  netPayout: number;
  monnifyRef: string;
  payoutDate: Date;
  groupName: string;
}

const FONT_DIR = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const REG = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');
// Brand palette (CC-ÀJỌ): Terracotta Clay, Àkàrà Gold, Cocoa.
const GREEN = '#C2410C';
const AMBER = '#F6B33D';
const INK = '#2A1712';
const money = (n: number) => `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

export function buildReceiptPdf(d: AjoReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;

    doc.rect(0, 0, W, 90).fill(GREEN);
    doc.fillColor('#FFFFFF').font(BOLD).fontSize(24).text('ÀJỌ Community Co-operative', 50, 34);
    doc.rect(0, 90, W, 5).fill(AMBER);

    doc.fillColor(GREEN).font(BOLD).fontSize(16).text('OFFICIAL RECEIPT', 50, 115, { align: 'right', width: W - 100 });

    doc.fillColor(INK).font(REG).fontSize(12);
    let y = 160;
    const row = (label: string, value: string) => {
      doc.fillColor('#7A5C50').font(REG).fontSize(11).text(label, 50, y);
      doc.fillColor(INK).font(BOLD).fontSize(12).text(value, 220, y, { width: W - 270 });
      y += 28;
    };
    row('Group', d.groupName);
    row('Pool', d.poolTitle);
    row('Cycle', `#${d.cycleNumber}`);
    row('Recipient', d.recipientName);
    row('Payout date', d.payoutDate.toDateString());

    y += 10;
    doc.moveTo(50, y).lineTo(W - 50, y).strokeColor(AMBER).lineWidth(1).stroke();
    y += 20;
    row('Total collected', money(d.totalCollected));
    if (d.platformFee > 0) row('Service fee deducted', `- ${money(d.platformFee)}`);
    if (d.collectorFee > 0) row('Collector fee deducted', `- ${money(d.collectorFee)}`);

    y += 10;
    doc.fillColor(GREEN).font(BOLD).fontSize(13).text('NET PAYOUT', 50, y);
    doc.fontSize(30).text(money(d.netPayout), 50, y + 20);
    y += 80;

    doc.fillColor(INK).font(REG).fontSize(11).text(`Payout reference: ${d.monnifyRef}`, 50, y);
    doc.text(`Verify: ${d.monnifyRef}`, 50, y + 18);

    doc.page.margins.bottom = 0; // draw the footer inside the bottom margin without triggering a page break
    doc.fillColor(GREEN).font(REG).fontSize(9)
      .text(`Recorded on ÀJỌ | Ref: ${d.monnifyRef} | Funds are held and paid out by the group collector; ÀJỌ records and verifies.`, 50, doc.page.height - 60, { align: 'center', width: W - 100 });
    doc.end();
  });
}

/** Generates the receipt PDF, stores it under uploads/ajo/receipts/ and returns its public URL. */
export async function generateAjoReceipt(data: AjoReceiptData): Promise<string> {
  const pdf = await buildReceiptPdf(data);
  return saveFile(pdf, 'ajo/receipts', 'pdf', `receipt-${data.monnifyRef}`);
}
