import axios from 'axios';
import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import { config } from '../lib/config';
import { termiiRouter } from '../modules/termii/termii.router';
import { sendSms, verifyTermiiWebhookSignature } from '../services/termii.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
app.use('/webhook', termiiRouter);
const server = app.listen(0);
const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;

const originalConfig = {
  apiKey: config.termiiApiKey,
  senderId: config.termiiSenderId,
  webhookSecret: config.termiiWebhookSecret,
};
const testSecret = 'termii-webhook-test-secret';
const payload = { event: 'message.delivery', message_id: 'test-message', status: 'delivered' };
const rawPayload = JSON.stringify(payload);
const sign = (body: string) => crypto.createHmac('sha256', testSecret).update(body).digest('hex');

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  config.termiiApiKey = originalConfig.apiKey;
  config.termiiSenderId = originalConfig.senderId;
  config.termiiWebhookSecret = originalConfig.webhookSecret;
  jest.clearAllMocks();
});

describe('Termii SMS delivery', () => {
  it('sends SMS using configured credentials and approved sender ID without logging message content', async () => {
    config.termiiApiKey = 'test-api-key';
    config.termiiSenderId = 'AJOAPP';
    mockedAxios.post.mockResolvedValue({} as never);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await sendSms('+2348012345678', 'verification message');

    expect(mockedAxios.post).toHaveBeenCalledWith(`${config.termiiBaseUrl}/api/sms/send`, {
      to: '2348012345678',
      from: 'AJOAPP',
      sms: 'verification message',
      type: 'plain',
      channel: 'generic',
      api_key: 'test-api-key',
    });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('fails explicitly when API key or sender ID is missing', async () => {
    config.termiiApiKey = '';
    config.termiiSenderId = 'AJOAPP';
    await expect(sendSms('+2348012345678', 'test')).rejects.toThrow('TERMII_API_KEY is not configured');
    config.termiiApiKey = 'test-api-key';
    config.termiiSenderId = '';
    await expect(sendSms('+2348012345678', 'test')).rejects.toThrow('TERMII_SENDER_ID is not configured');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('surfaces a sanitized provider rejection reason without exposing phone numbers', async () => {
    config.termiiApiKey = 'test-api-key';
    config.termiiSenderId = 'AJOAPP';
    mockedAxios.isAxiosError.mockReturnValue(true);
    mockedAxios.post.mockRejectedValue({
      response: { status: 422, data: { message: 'Invalid recipient +2348012345678' } },
    });

    await expect(sendSms('+2348012345678', 'verification message')).rejects.toThrow(
      'Termii request failed with HTTP 422: Invalid recipient [redacted]',
    );
  });
});

describe('Termii webhook signature verification', () => {
  it('verifies an HMAC-SHA256 signature over the exact raw body', () => {
    config.termiiWebhookSecret = testSecret;
    expect(verifyTermiiWebhookSignature(rawPayload, sign(rawPayload))).toBe(true);
    expect(verifyTermiiWebhookSignature(rawPayload, `sha256=${sign(rawPayload)}`)).toBe(true);
    expect(verifyTermiiWebhookSignature(`${rawPayload} `, sign(rawPayload))).toBe(false);
    expect(verifyTermiiWebhookSignature(rawPayload, 'invalid')).toBe(false);
  });

  it('acknowledges only signed Termii callbacks', async () => {
    config.termiiWebhookSecret = testSecret;
    const invalid = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-termii-signature': 'invalid' },
      body: rawPayload,
    });
    expect(invalid.status).toBe(401);

    const valid = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-termii-signature': sign(rawPayload) },
      body: rawPayload,
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ received: true });
  });

  it('returns service unavailable when the signing secret is not configured', async () => {
    config.termiiWebhookSecret = '';
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-termii-signature': sign(rawPayload) },
      body: rawPayload,
    });
    expect(response.status).toBe(503);
  });
});
