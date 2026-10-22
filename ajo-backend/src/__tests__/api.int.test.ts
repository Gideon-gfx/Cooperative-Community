import { execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import os from 'os';
import path from 'path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const sms: { to: string; msg: string }[] = [];
jest.mock('../services/termii.service', () => ({ sendSms: async (to: string, msg: string) => void sms.push({ to, msg }) }));

const mails: { to: string; text: string }[] = [];
jest.mock('../lib/mailer', () => ({ sendEmail: async (to: string, _s: string, text: string) => void mails.push({ to, text }) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let rs: MongoMemoryReplSet;
let server: http.Server;
let base: string;
let prisma: any;

async function call(method: string, url: string, token?: string, body?: unknown, form = false) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body && !form ? { 'content-type': 'application/json' } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? (form ? new URLSearchParams(body as any).toString() : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* plain text / csv */ }
  return { status: res.status, json, text };
}

/** Real login: request an OTP, read it from the (mocked) SMS, verify it. */
async function login(phone: string, fullName: string, role = 'MEMBER') {
  expect((await call('POST', '/api/auth/request-otp', undefined, { phoneNumber: phone })).status).toBe(200);
  const code = sms.filter((m) => m.to === phone.replace(/^0/, '+234')).pop()!.msg.match(/code is (\d{6})/)![1];
  const r = await call('POST', '/api/auth/verify-otp', undefined, { phoneNumber: phone, otp: code, fullName, role });
  expect(r.status).toBe(200);
  expect(r.json.user.pinHash).toBeUndefined(); // never leak the hash
  return { token: r.json.token as string, user: r.json.user };
}

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ binary: { version: '6.0.14' }, instanceOpts: [{ launchTimeout: 60000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const url = `${rs.getUri().split('/?')[0]}/ajo?replicaSet=testset`;
  Object.assign(process.env, { DATABASE_URL: url, UPLOAD_DIR: path.join(os.tmpdir(), 'ajo-int-uploads'), AJO_PLATFORM_FEE_RATE: '0', CCGB_PLATFORM_FEE_RATE: '0', WEBHOOK_SECRET: 'hook-secret', JWT_SECRET: 'test-secret' });
  await promisify(execFile)(path.resolve('node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], { env: process.env, timeout: 150000 });
  ({ prisma } = require('../lib/prisma'));
  const { app } = require('../app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  server?.close();
  await prisma?.$disconnect();
  await require('../lib/mongodb').closeMongoConnection();
  await rs?.stop();
});

describe('HTTP: a collector runs an Àjọ pool end to end', () => {
  let baba: any, ada: any, bola: any, group: any, pool: any, assistedId: string;

  it('initializes startup indexes and seeds through the native MongoDB driver', async () => {
    const { ensureEmailUniqueIndex } = require('../lib/prisma');
    const { seedPlanPricesNative } = require('../modules/billing/billing.service');
    const { seedConsentDocumentsNative } = require('../modules/consent/consent.service');
    await ensureEmailUniqueIndex();
    expect(await seedPlanPricesNative()).toBe(4);
    expect(await seedPlanPricesNative()).toBe(0);
    expect(await seedConsentDocumentsNative()).toBe(3);
    expect(await seedConsentDocumentsNative()).toBe(0);
  });

  it('rejects bad input and unauthenticated calls', async () => {
    expect((await call('POST', '/api/auth/request-otp', undefined, { phoneNumber: '12345' })).status).toBe(400);
    expect((await call('GET', '/api/auth/profile')).status).toBe(401);
    expect((await call('GET', '/api/ajo/my-pools', 'bad.token.here')).status).toBe(401);
  });

  it('OTP login with real hashing; wrong code fails; resend is throttled', async () => {
    baba = await login('08011111111', 'Baba Alajo', 'COLLECTOR');
    ada = await login('08022222222', 'Ada Member');
    bola = await login('08033333333', 'Bola Member');
    expect((await call('POST', '/api/auth/request-otp', undefined, { phoneNumber: '08088888888' })).status).toBe(200);
    expect((await call('POST', '/api/auth/request-otp', undefined, { phoneNumber: '08088888888' })).status).toBe(429); // resend too soon
    const bad = await call('POST', '/api/auth/verify-otp', undefined, { phoneNumber: '08022222222', otp: '000000', fullName: 'x' });
    expect(bad.status).toBe(400);
  });

  it('registers and signs in with an email and password without a phone number', async () => {
    const credentials = { email: 'Ajo.Member@gmail.com', password: 'a-long-test-password', fullName: 'Ajo Member', role: 'MEMBER' };
    const registered = await call('POST', '/api/auth/register', undefined, credentials);
    expect(registered.status).toBe(201);
    expect(registered.json.user).toMatchObject({ email: 'ajo.member@gmail.com', phoneNumber: null, fullName: 'Ajo Member' });
    expect(mails.filter((mail) => mail.to === 'ajo.member@gmail.com').pop()?.text).toContain('Your ÀJỌ account is ready');
    expect(registered.json.user.passwordHash).toBeUndefined();
    expect(registered.json.user.pinHash).toBeUndefined();
    expect((await call('POST', '/api/auth/register', undefined, credentials)).status).toBe(409);
    expect((await call('POST', '/api/auth/login-email', undefined, { email: credentials.email, password: 'wrong-password' })).status).toBe(401);
    const loggedIn = await call('POST', '/api/auth/login-email', undefined, { email: 'ajo.member@gmail.com', password: credentials.password });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.json.user.id).toBe(registered.json.user.id);
    expect((await call('POST', '/api/auth/update-profile', loggedIn.json.token, { preferredLanguage: 'YO' })).status).toBe(200);
    expect(mails.filter((mail) => mail.to === 'ajo.member@gmail.com').pop()?.text).toContain('profile settings were updated');
    expect((await call('GET', '/api/auth/profile', loggedIn.json.token)).status).toBe(200);
  });

  it('gives each person one referral code and credits whoever signs up with it', async () => {
    const jwt = require('jsonwebtoken');
    await require('../lib/prisma').ensureEmailUniqueIndex();
    const owner = await prisma.user.create({ data: { phoneNumber: '+2348055550777', fullName: 'Referrer', isVerified: true } });
    const token = jwt.sign({ userId: owner.id, role: 'MEMBER', phone: owner.phoneNumber }, 'test-secret');
    expect((await call('GET', '/api/auth/referral', token)).json).toEqual({ code: null, referred: 0 });
    const made = await call('POST', '/api/auth/referral-code', token);
    expect(made.json.code).toMatch(/^AJO-[A-Z2-9]{6}$/);
    expect((await call('POST', '/api/auth/referral-code', token)).json.code).toBe(made.json.code); // same code every time
    const bad = await call('POST', '/api/auth/register', undefined, { email: 'ref.bad@gmail.com', password: 'a-long-test-password', fullName: 'Typo', referralCode: 'AJO-NOPE99' });
    expect(bad.status).toBe(400);
    const ok = await call('POST', '/api/auth/register', undefined, { email: 'ref.ok@gmail.com', password: 'a-long-test-password', fullName: 'Friend', referralCode: ` ${made.json.code.toLowerCase()} ` });
    expect(ok.status).toBe(201);
    expect((await prisma.user.findUnique({ where: { id: ok.json.user.id } })).referredById).toBe(owner.id);
    expect((await call('GET', '/api/auth/referral', token)).json).toEqual({ code: made.json.code, referred: 1 });
  });

  it('resets a forgotten PIN with an SMS code', async () => {
    const phone = '+2348055550123';
    const { hashPin } = require('../lib/security');
    const u = await prisma.user.create({ data: { phoneNumber: phone, fullName: 'Pin Forgetter', isVerified: true, pinHash: hashPin('4821'), pinFailedCount: 4 } });
    expect((await call('POST', '/api/auth/forgot-pin', undefined, { phoneNumber: '08055559999', country: 'NG' })).status).toBe(404); // no account, no code
    expect((await call('POST', '/api/auth/forgot-pin', undefined, { phoneNumber: '08055550123', country: 'NG' })).json).toEqual({ success: true });
    const code = sms.filter((m) => m.to === phone).pop()!.msg.match(/code is (\d{6})/)![1];
    expect((await call('POST', '/api/auth/verify-reset-code', undefined, { phoneNumber: '08055550123', country: 'NG', code })).json).toEqual({ valid: true });
    expect((await call('POST', '/api/auth/reset-pin', undefined, { phoneNumber: '08055550123', country: 'NG', code, newPin: '1111' })).status).toBe(400); // too easy
    expect((await call('POST', '/api/auth/reset-pin', undefined, { phoneNumber: '08055550123', country: 'NG', code, newPin: '7391' })).status).toBe(200);
    expect((await call('POST', '/api/auth/reset-pin', undefined, { phoneNumber: '08055550123', country: 'NG', code, newPin: '7392' })).status).toBe(400); // used once
    expect((await call('POST', '/api/auth/login-pin', undefined, { phoneNumber: '08055550123', country: 'NG', pin: '7391' })).status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: u.id } })).pinFailedCount).toBe(0);
  });

  it('resets a forgotten password with an emailed code, one use, and refuses unknown emails', async () => {
    const email = 'reset.me@gmail.com';
    const { hashPassword } = require('../lib/security');
    await require('../lib/prisma').ensureEmailUniqueIndex();
    await prisma.user.create({ data: { email, fullName: 'Reset Me', passwordHash: await hashPassword('old-password-123'), isVerified: true } }); // not via /register: its rate limit is shared with the other tests
    expect((await call('POST', '/api/auth/forgot-password', undefined, { email: 'nobody@gmail.com' })).status).toBe(404);
    expect(mails.some((m) => m.to === 'nobody@gmail.com')).toBe(false);
    expect((await call('POST', '/api/auth/forgot-password', undefined, { email })).json).toEqual({ success: true });
    const code = mails.filter((m) => m.to === email).pop()!.text.match(/code is (\d{6})/)![1];
    expect((await call('POST', '/api/auth/reset-password', undefined, { email, code: code === '000000' ? '111111' : '000000', newPassword: 'new-password-123' })).status).toBe(400);
    expect((await call('POST', '/api/auth/reset-password', undefined, { email, code, newPassword: 'short' })).status).toBe(400);
    expect((await call('POST', '/api/auth/verify-reset-code', undefined, { email, code })).json).toEqual({ valid: true });
    const done = await call('POST', '/api/auth/reset-password', undefined, { email, code, newPassword: 'new-password-123' });
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ success: true });
    expect((await call('POST', '/api/auth/reset-password', undefined, { email, code, newPassword: 'another-pass-123' })).status).toBe(400); // used once
    expect((await call('POST', '/api/auth/login-email', undefined, { email, password: 'old-password-123' })).status).toBe(401);
    expect((await call('POST', '/api/auth/login-email', undefined, { email, password: 'new-password-123' })).status).toBe(200);
  });

  it('an unapproved collector cannot create a group; an admin approves them', async () => {
    const denied = await call('POST', '/api/groups/create', baba.token, { name: 'Market Women' });
    expect(denied.status).toBe(403);
    const admin = await prisma.user.create({ data: { phoneNumber: '+2348099999999', fullName: 'Admin', role: 'ADMIN', isVerified: true } });
    const jwt = require('jsonwebtoken').sign({ userId: admin.id, role: 'ADMIN', phone: admin.phoneNumber }, 'test-secret');
    expect((await call('PATCH', `/api/auth/admin/collectors/${baba.user.id}/approve`, jwt)).status).toBe(200);
    const ok = await call('POST', '/api/groups/create', baba.token, { name: 'Market Women', country: 'NG' });
    expect(ok.status).toBe(201);
    group = ok.json.group;
    expect(group.currency).toBe('NGN');
  });

  it('collector invites members, and creates an assisted account for someone with a basic phone', async () => {
    const inv = await call('POST', `/api/groups/${group.id}/invite`, baba.token, { phoneNumbers: ['08022222222', '08033333333', 'bogus'] });
    expect(inv.json).toMatchObject({ added: 2, invalid: ['bogus'] });
    expect((await call('POST', `/api/groups/${group.id}/invite`, ada.token, { phoneNumbers: ['08044444444'] })).status).toBe(403); // not the admin

    const created = await call('POST', '/api/agent/members', baba.token, { groupId: group.id, fullName: 'Mama Ngozi', phoneNumber: '08055555555', language: 'IG' });
    expect(created.status).toBe(201);
    assistedId = created.json.user.id;
    expect(JSON.stringify(created.json)).not.toMatch(/\b\d{4}\b.*pin/i); // the temp PIN is SMSed to the member, never returned to the collector
    const smsToMember = sms.filter((m) => m.to === '+2348055555555').pop()!;
    expect(smsToMember.msg).toMatch(/temporary PIN \d{4}/);
    expect((await call('POST', '/api/agent/members', ada.token, { groupId: group.id, fullName: 'x', phoneNumber: '08066666666' })).status).toBe(403);
  });

  it('the assisted member sets a PIN via USSD; the webhook needs the shared secret', async () => {
    const tempPin = sms.filter((m) => m.to === '+2348055555555').pop()!.msg.match(/PIN (\d{4})/)![1];
    const dial = (text: string, key = 'hook-secret') => call('POST', `/api/ussd?key=${key}`, undefined, { phoneNumber: '+2348055555555', text, sessionId: 's1' }, true);
    expect((await dial('', 'wrong')).status).toBe(401);
    expect((await dial('')).text).toMatch(/^CON/);
    expect((await dial(`${tempPin}*7351`)).text).toMatch(/^END/);
    expect((await dial('')).text).toMatch(/^CON/); // now shows the menu
    // …and can sign in to the app with phone + PIN
    const li = await call('POST', '/api/auth/login-pin', undefined, { phoneNumber: '08055555555', pin: '7351' });
    expect(li.status).toBe(200);
    expect((await call('POST', '/api/auth/login-pin', undefined, { phoneNumber: '08055555555', pin: '0000' })).status).toBe(401);
  });

  it('creates a pool (preserved order, 1 hand each) via the API', async () => {
    await prisma.user.update({ where: { id: ada.user.id }, data: { email: 'ada-updates@example.com' } });
    await prisma.user.update({ where: { id: bola.user.id }, data: { email: 'bola-updates@example.com' } });
    const memberIds = [ada.user.id, bola.user.id, assistedId];
    const r = await call('POST', '/api/ajo/pools/create', baba.token, {
      groupId: group.id, title: 'Weekly Àjọ', amountPerMember: 2000, cycleFrequency: 'WEEKLY', collectorFeePct: 2, memberIds, startDate: new Date().toISOString(), preserveOrder: true, graceDays: 1,
    });
    expect(r.status).toBe(201);
    pool = r.json.pool;
    expect(pool.schedules).toHaveLength(3);
    await require('../cron/ajo.cron').sendWeeklyDigest();
    expect(mails.filter((mail) => mail.to === 'ada-updates@example.com').pop()?.text).toContain('Weekly Àjọ:');
    expect((await call('POST', '/api/ajo/pools/create', ada.token, { groupId: group.id, title: 'x', amountPerMember: 1, cycleFrequency: 'WEEKLY', memberIds, startDate: new Date().toISOString() })).status).toBe(403);
  });

  it('member dashboard shows what is due, and the pool shows funds', async () => {
    const mine = await call('GET', '/api/ajo/my-pools', bola.token);
    expect(mine.status).toBe(200);
    expect(mine.json.pools).toHaveLength(1);
    expect(mine.json.notifications.filter((n: any) => n.kind === 'DUE').length).toBeGreaterThan(0);
    const detail = await call('GET', `/api/ajo/pools/${pool.id}`, bola.token);
    expect(detail.json.funds).toMatchObject({ heldByCollector: 0, totalIn: 0 });
    expect(detail.json.myContributions.length).toBe(2);
    expect((await call('GET', `/api/ajo/pools/${pool.id}`, (await login('08077777777', 'Outsider')).token)).status).toBe(403);
  });

  it('payments: member reports → collector verifies; collector records cash for the assisted member', async () => {
    const first = pool.schedules[0]; // Ada collects; Bola and Mama Ngozi pay
    const rec = await call('POST', '/api/ajo/contributions/record', bola.token, { scheduleId: first.id, method: 'TRANSFER', reference: 'GT-123' });
    expect(rec.status).toBe(201);
    const view = await call('GET', `/api/ajo/schedules/${first.id}/contributions`, baba.token);
    const bolaRow = view.json.contributions.find((c: any) => c.contributorName === 'Bola Member');
    expect(bolaRow.payments[0]).toMatchObject({ status: 'PENDING', amount: 2000 });
    // a member only sees their own row
    expect((await call('GET', `/api/ajo/schedules/${first.id}/contributions`, bola.token)).json.contributions).toHaveLength(1);

    expect((await call('PATCH', `/api/ajo/contributions/${bolaRow.id}/verify`, bola.token)).status).toBe(403);
    expect((await call('PATCH', `/api/ajo/contributions/${bolaRow.id}/verify`, baba.token)).status).toBe(200);
    expect(mails.filter((mail) => mail.to === 'bola-updates@example.com').pop()?.text).toContain('confirmed your Àjọ payment');

    const cash = await call('POST', '/api/ajo/contributions/record-for', baba.token, { scheduleId: first.id, contributorId: assistedId, method: 'CASH' });
    expect(cash.status).toBe(201);
    expect(cash.json).toMatchObject({ contributionVerified: true, readyForPayout: true });
  });

  it('payout needs the collector\'s PIN; the ledger, receipt and confirmation follow', async () => {
    const first = pool.schedules[0];
    const body = { method: 'TRANSFER', reference: 'MYBANK-77' };
    // no PIN set yet
    const noPin = await call('POST', `/api/ajo/schedules/${first.id}/payout`, baba.token, { ...body, pin: '2468' });
    expect(noPin.status).toBe(403);
    expect(noPin.json.error).toMatch(/PIN_REQUIRED/);
    expect((await call('POST', '/api/auth/set-pin', baba.token, { pin: '1111' })).status).toBe(400); // too guessable
    expect((await call('POST', '/api/auth/set-pin', baba.token, { pin: '2468' })).status).toBe(200);
    expect((await call('POST', `/api/ajo/schedules/${first.id}/payout`, baba.token, { ...body, pin: '9999' })).status).toBe(401);

    const ok = await call('POST', `/api/ajo/schedules/${first.id}/payout`, baba.token, { ...body, pin: '2468' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ totalCollected: 4000, collectorFee: 80, netPayout: 3920 });
    expect(mails.filter((mail) => mail.to === 'ada-updates@example.com').pop()?.text).toContain('says they paid you');
    expect(ok.json.receiptUrl).toMatch(/\.pdf$/);
    const pdf = await fetch(ok.json.receiptUrl.replace(/^https?:\/\/[^/]+/, base));
    expect(pdf.status).toBe(200); // the stored receipt is actually served
    expect((await call('POST', `/api/ajo/schedules/${first.id}/payout`, baba.token, { ...body, pin: '2468' })).status).toBe(409);

    const ledger = await call('GET', `/api/ajo/pools/${pool.id}/ledger`, bola.token); // any member can see it
    expect(ledger.json).toMatchObject({ totalIn: 4000, totalOut: 4000, heldByCollector: 0, currency: 'NGN' });

    // Ada is told to confirm and sees it in her notices; then confirms
    const adaMine = await call('GET', '/api/ajo/my-pools', ada.token);
    expect(adaMine.json.notifications.some((n: any) => n.kind === 'CONFIRM_PAYOUT')).toBe(true);
    expect((await call('POST', `/api/ajo/schedules/${first.id}/confirm-receipt`, ada.token, { received: true })).json.status).toBe('COMPLETED');
    expect((await call('GET', '/api/ajo/my-pools', ada.token)).json.notifications.some((n: any) => n.kind === 'CONFIRM_PAYOUT')).toBe(false);
  });

  it('the group chat carries the receipt card, and members get trust scores', async () => {
    const chat = await call('GET', `/api/groups/${group.id}`, bola.token);
    const receipt = chat.json.messages.find((m: any) => m.messageType === 'RECEIPT');
    expect(receipt.receipt).toMatchObject({ netPayout: 3920, currency: 'NGN' });
    expect(chat.json.members.every((m: any) => m.trust && 'label' in m.trust)).toBe(true);
    expect(chat.json.collector).toMatchObject({ groups: 1, completedPayouts: 1, verified: true });
  });

  it('collector exports a CSV; attests balance; members cannot', async () => {
    const csv = await call('GET', `/api/ajo/pools/${pool.id}/export.csv`, baba.token);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('MYBANK-77');
    expect((await call('GET', `/api/ajo/pools/${pool.id}/export.csv`, bola.token)).status).toBe(403);
    const att = await call('POST', `/api/ajo/pools/${pool.id}/attest`, baba.token, { declaredAmount: 0, pin: '2468' });
    expect(att.json.mismatch).toBe(0);
    expect((await call('POST', `/api/ajo/pools/${pool.id}/attest`, bola.token, { declaredAmount: 0, pin: '2468' })).status).toBe(403);
  });

  it('disputes: member raises, escalates; once escalated the collector cannot close it', async () => {
    const d = await call('POST', '/api/disputes', bola.token, { groupId: group.id, kind: 'COLLECTOR_CONDUCT', description: 'Collector is not answering calls' });
    expect(d.status).toBe(201);
    expect((await call('GET', `/api/disputes?groupId=${group.id}`, baba.token)).json.disputes).toHaveLength(1);
    expect((await call('GET', `/api/disputes?groupId=${group.id}`, ada.token)).json.disputes).toHaveLength(0); // Ada can't see Bola's
    expect((await call('POST', `/api/disputes/${d.json.dispute.id}/escalate`, ada.token)).status).toBe(403);
    expect((await call('POST', `/api/disputes/${d.json.dispute.id}/escalate`, bola.token)).status).toBe(200);
    expect((await call('PATCH', `/api/disputes/${d.json.dispute.id}/resolve`, baba.token, { resolution: 'All good' })).status).toBe(403);
  });

  it('SMS commands work for feature phones', async () => {
    const send = (text: string) => call('POST', '/api/sms/inbound?key=hook-secret', undefined, { from: '+2348033333333', text });
    expect((await send('BAL')).json.reply).toMatch(/₦2,000/);
    expect((await send('FUNDS')).json.reply).toMatch(/collector holds ₦0/);
    expect((await send('hello')).json.reply).toMatch(/BAL/);
  });

  it('suppliers and drivers have their own limited views', async () => {
    expect((await call('GET', '/api/ccgb/suppliers/me', bola.token)).json.supplier).toBeNull();
    expect((await call('GET', '/api/ccgb/jobs', bola.token)).status).toBe(403); // members are not drivers
    const driver = await login('08099990000', 'Driver Dan', 'TRANSPORTER');
    const jobs = await call('GET', '/api/ccgb/jobs', driver.token);
    expect(jobs.status).toBe(200);
    expect(jobs.json.jobs).toEqual([]);
    // a driver is not a group member, so they cannot read a group's pool
    expect((await call('GET', `/api/ajo/pools/${pool.id}`, driver.token)).status).toBe(403);
  });
});
