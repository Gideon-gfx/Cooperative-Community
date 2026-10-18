import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { naira } from '../../lib/notify';
import { t, LANG_CODES, type Lang } from '../../lib/i18n';
import { countryOfPhone, normalizePhone } from '../../lib/phone';
import { hashPin, isValidPin, verifyPin } from '../../lib/security';
import { getMemberSummary } from '../../services/member.service';
import { confirmReceipt, recordPayment } from '../ajo/ajo.service';

const fmt = (d: Date) => d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
const LANG_BY_DIGIT: Lang[] = ['EN', 'PCM', 'YO', 'HA', 'IG'];

async function findUser(rawPhone: string) {
  const phone = normalizePhone(rawPhone, countryOfPhone(rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`)) ?? normalizePhone(rawPhone);
  const candidates = phone ? [phone] : [rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`];
  return prisma.user.findFirst({ where: { phoneNumber: { in: candidates } } });
}

const pinOk = async (userId: string, pin: string) => {
  try {
    await verifyPin(userId, pin);
    return true;
  } catch (e) {
    if (e instanceof HttpError) return false;
    throw e;
  }
};

async function nextDueText(userId: string, lang: Lang) {
  const { due } = await getMemberSummary(userId);
  if (!due.length) return t(lang, 'ussd.noDue');
  return due.slice(0, 3).map((d) => t(lang, 'ussd.nextDue', { amount: naira(d.remaining, d.currency), date: fmt(d.dueAt), pool: d.pool })).join('\n');
}
async function turnText(userId: string, lang: Lang) {
  const { turns } = await getMemberSummary(userId);
  if (!turns.length) return t(lang, 'ussd.noTurn');
  return turns.slice(0, 3).map((x) => t(lang, 'ussd.turn', { amount: naira(x.amount, x.currency), date: fmt(x.date), pool: x.pool })).join('\n');
}
async function fundsText(userId: string, lang: Lang) {
  const { funds } = await getMemberSummary(userId);
  if (!funds.length) return t(lang, 'ussd.noPools');
  return funds.slice(0, 3).map((f) => t(lang, 'ussd.funds', { pool: f.pool, held: naira(f.held, f.currency), inn: naira(f.totalIn, f.currency), out: naira(f.totalOut, f.currency) })).join('\n');
}

/**
 * Africa's Talking-style USSD handler. `text` is the full "*"-joined history of this session.
 * Returns the response body: "CON ..." keeps the session open, "END ..." closes it.
 */
export async function handleUssd(input: { phoneNumber: string; text: string }): Promise<string> {
  const user = await findUser(input.phoneNumber);
  if (!user) return `END ${t('EN', 'ussd.notRegistered')}`;
  const lang = user.preferredLanguage as Lang;
  const parts = input.text === '' ? [] : input.text.split('*');
  const END = (k: string, v?: Record<string, string | number>) => `END ${t(lang, k, v)}`;

  // First-time / reset flow: temporary PIN (if any) then choose a new one.
  if (!user.pinHash || user.pinMustChange) {
    if (!user.pinHash) {
      if (parts.length === 0) return `CON ${t(lang, 'ussd.newPin')}`;
      if (!isValidPin(parts[0])) return END('ussd.badInput');
      await prisma.user.update({ where: { id: user.id }, data: { pinHash: hashPin(parts[0]), pinMustChange: false } });
      return END('ussd.pinSet');
    }
    if (parts.length === 0) return `CON ${t(lang, 'ussd.tempPin')}`;
    if (!(await pinOk(user.id, parts[0]))) return END('ussd.wrongPin');
    if (parts.length === 1) return `CON ${t(lang, 'ussd.newPin')}`;
    if (!isValidPin(parts[1]) || parts[1] === parts[0]) return END('ussd.badInput');
    await prisma.user.update({ where: { id: user.id }, data: { pinHash: hashPin(parts[1]), pinMustChange: false } });
    return END('ussd.pinSet');
  }

  if (parts.length === 0) return `CON ${t(lang, 'ussd.welcome')}\n${t(lang, 'ussd.menu')}`;

  switch (parts[0]) {
    case '1': return `END ${await nextDueText(user.id, lang)}`;
    case '2': return `END ${await turnText(user.id, lang)}`;
    case '4': return `END ${await fundsText(user.id, lang)}`;
    case '3': {
      const { due } = await getMemberSummary(user.id);
      if (!due.length) return END('ussd.noDue');
      const list = due.slice(0, 5);
      if (parts.length === 1) return `CON ${t(lang, 'ussd.pickPay')}\n${list.map((d, i) => `${i + 1}. ${naira(d.remaining, d.currency)} ${d.pool}`).join('\n')}`;
      const chosen = list[Number(parts[1]) - 1];
      if (!chosen) return END('ussd.badInput');
      if (parts.length === 2) return `CON ${t(lang, 'ussd.payMethod')}`;
      if (!['1', '2'].includes(parts[2])) return END('ussd.badInput');
      if (parts.length === 3) return `CON ${t(lang, 'ussd.enterPin')}`;
      if (!(await pinOk(user.id, parts[3]))) return END('ussd.wrongPin');
      await recordPayment(user, { contributionId: chosen.contributionId, method: parts[2] === '1' ? 'TRANSFER' : 'CASH' });
      return END('ussd.paid');
    }
    case '5': {
      if (parts.length === 1) return `CON ${t(lang, 'ussd.pickLang')}`;
      const next = LANG_BY_DIGIT[Number(parts[1]) - 1];
      if (!next) return END('ussd.badInput');
      await prisma.user.update({ where: { id: user.id }, data: { preferredLanguage: next } });
      return `END ${t(next, 'ussd.langSet')}`;
    }
    case '6': {
      if (parts.length === 1) return `CON ${t(lang, 'ussd.enterPin')}`;
      if (!(await pinOk(user.id, parts[1]))) return END('ussd.wrongPin');
      if (parts.length === 2) return `CON ${t(lang, 'ussd.newPin')}`;
      if (!isValidPin(parts[2])) return END('ussd.badInput');
      await prisma.user.update({ where: { id: user.id }, data: { pinHash: hashPin(parts[2]) } });
      return END('ussd.pinSet');
    }
    default: return END('ussd.badInput');
  }
}

/** Inbound SMS commands for feature phones: BAL, TURN, FUNDS, PAID <PIN>, CONFIRM, NOTYET, LANG <code>, HELP. */
export async function handleSms(input: { from: string; text: string }): Promise<string> {
  const user = await findUser(input.from);
  if (!user) return t('EN', 'ussd.notRegistered');
  const lang = user.preferredLanguage as Lang;
  const [cmdRaw, ...args] = input.text.trim().split(/\s+/);
  const cmd = (cmdRaw ?? '').toUpperCase();

  switch (cmd) {
    case 'BAL': return nextDueText(user.id, lang);
    case 'TURN': return turnText(user.id, lang);
    case 'FUNDS': return fundsText(user.id, lang);
    case 'LANG': {
      const code = (args[0] ?? '').toUpperCase() as Lang;
      if (!LANG_CODES.includes(code)) return t(lang, 'sms.help');
      await prisma.user.update({ where: { id: user.id }, data: { preferredLanguage: code } });
      return t(code, 'ussd.langSet');
    }
    case 'PAID': {
      if (!(await pinOk(user.id, args[0] ?? ''))) return t(lang, 'ussd.wrongPin');
      const { due } = await getMemberSummary(user.id);
      if (!due.length) return t(lang, 'ussd.noDue');
      await recordPayment(user, { contributionId: due[0].contributionId, method: 'TRANSFER' });
      return t(lang, 'ussd.paid');
    }
    case 'CONFIRM':
    case 'NOTYET': {
      const s = await prisma.ajoRotationSchedule.findFirst({ where: { recipientId: user.id, status: 'COMPLETED', OR: [{ recipientConfirmedAt: null }, { recipientConfirmedAt: { isSet: false } }] }, orderBy: { paidOutAt: 'desc' } });
      if (!s) return t(lang, 'ussd.noDue');
      await confirmReceipt(user.id, s.id, cmd === 'CONFIRM');
      return cmd === 'CONFIRM' ? 'Thank you. Payout confirmed.' : 'Noted. Your collector has been told.';
    }
    default: return t(lang, 'sms.help');
  }
}
