import path from 'path';
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { koboToNaira } from '../../lib/kobo';
import { loadForUser } from '../apprenticeship/contracts.service';
import { fundOf, statement } from './settlement.service';

const FONT_DIR = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const REG = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

/** A monthly statement for one agreement: what went in that month, where the fund stands, and which months are paid. Principal only. */
export async function monthlyStatementPdf(user: { id: string; role: string }, contractId: string, month: string): Promise<Buffer> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Use YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)), to = new Date(Date.UTC(y, m, 1));
  const { c } = await loadForUser(user, contractId);
  const fund = await fundOf(contractId);
  const s = await statement(user, contractId, new Date(to.getTime() - 1));
  const entries = await prisma.fundsEntry.findMany({ where: { purposeType: 'SETTLEMENT_FUND', purposeId: fund.id, status: 'CONFIRMED', createdAt: { gte: from, lt: to } }, orderBy: { createdAt: 'asc' } });
  const names = await prisma.user.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.payerUserId))] } }, select: { id: true, fullName: true } });
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: c.communityGroupId }, select: { name: true } });
  const inMonth = entries.filter((e) => e.type === 'CONTRIBUTION').reduce((sum, e) => sum + e.amountKobo, 0n);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width;
    doc.rect(0, 0, W, 90).fill('#C2410C');
    doc.fillColor('#FFFFFF').font(BOLD).fontSize(21).text(`Settlement Fund statement · ${month}`, 50, 32);
    doc.rect(0, 90, W, 5).fill('#F6B33D');
    let y = 115;
    const row = (label: string, value: string, bold = false) => {
      doc.fillColor('#2A1712').font(bold ? BOLD : REG).fontSize(11).text(label, 50, y, { width: 300 });
      doc.font(BOLD).text(value, 360, y, { width: W - 410, align: 'right' });
      y += 22;
    };
    row('Group', group.name); row('Trade', c.tradeCategory); row('Fund status', s.fundStatus.toLowerCase().replace(/_/g, ' '));
    y += 8;
    row('Paid in this month', `₦${koboToNaira(inMonth)}`);
    row('Master contributions to date', `₦${s.totals.masterContributions}`);
    row('Community match to date', `₦${s.totals.communityMatch}`);
    row('Waiting at the payment partner', `₦${s.totals.pending}`);
    row('Released so far', `₦${s.totals.released}`);
    row('Confirmed in the fund now', `₦${s.totals.balance}`, true);
    y += 12;
    doc.y = y; doc.x = 50;
    doc.font(BOLD).fontSize(12).text('This month\'s payments'); doc.moveDown(0.4);
    if (!entries.length) doc.font(REG).fontSize(10).text('No confirmed payments this month.');
    for (const e of entries) {
      if (doc.y > doc.page.height - 100) doc.addPage();
      doc.font(REG).fontSize(10).text(`${e.createdAt.toISOString().slice(0, 10)}   ${e.type.toLowerCase()}   ${names.find((n) => n.id === e.payerUserId)?.fullName ?? '—'}   ₦${koboToNaira(e.amountKobo)}${e.payerUserId === c.masterId ? '' : '   (community match)'}`);
    }
    doc.moveDown();
    doc.font(BOLD).fontSize(12).text('Monthly contributions'); doc.moveDown(0.4);
    for (const d of s.dues) {
      if (doc.y > doc.page.height - 100) doc.addPage();
      doc.font(REG).fontSize(10).text(`Month ${d.number}   due ${d.dueDate}   ₦${d.amount}   ${d.status.toLowerCase()}`);
    }
    doc.page.margins.bottom = 0;
    doc.fillColor('#7A5C50').font(REG).fontSize(9).text('The fund holds only what was paid in, in escrow through the payment partner. CC-ÀJỌ records every payment. It does not promise any return or interest.', 50, doc.page.height - 60, { align: 'center', width: W - 100 });
    doc.end();
  });
}
