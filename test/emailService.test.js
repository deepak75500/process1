const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');

// ------------------ Mock EmailService Implementation ------------------ //
const app = express();
app.use(bodyParser.json());

const sentEmails = new Set();
const emailStatusMap = new Map();
const rateLimits = new Map();

const mockProviders = [
  {
    name: 'ProviderA',
    send: jest.fn((email) => Promise.reject('Failed')), // always fail
  },
  {
    name: 'ProviderB',
    send: jest.fn((email) => Promise.resolve('Success')), // always succeed
  },
];

async function retry(fn, retries = 2, delay = 100) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, delay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function rateLimit(ip, limit = 3, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const attempts = rateLimits.get(ip).filter(t => now - t < windowMs);
  if (attempts.length >= limit) return false;
  attempts.push(now);
  rateLimits.set(ip, attempts);
  return true;
}

app.post('/send-email', async (req, res) => {
  const ip = req.ip || 'local';
  const { id, to, subject, body } = req.body;

  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  if (sentEmails.has(id)) {
    return res.status(409).json({ error: 'Duplicate email' });
  }

  for (const provider of mockProviders) {
    try {
      const result = await retry(() => provider.send({ to, subject, body }));
      sentEmails.add(id);
      emailStatusMap.set(id, 'sent');
      return res.status(200).json({ status: 'sent', provider: provider.name, message: result });
    } catch (_) {}
  }

  emailStatusMap.set(id, 'failed');
  return res.status(500).json({ status: 'failed' });
});

// ------------------ Tests ------------------ //

describe('EmailService Tests', () => {
  beforeEach(() => {
    sentEmails.clear();
    emailStatusMap.clear();
    rateLimits.clear();
    mockProviders[0].send.mockClear();
    mockProviders[1].send.mockClear();
  });

  test('should send email using fallback provider', async () => {
    const res = await request(app).post('/send-email').send({
      id: 'email1',
      to: 'a@example.com',
      subject: 'Hello',
      body: 'This is a test',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(res.body.provider).toBe('ProviderB');
  });

  test('should prevent duplicate email sending', async () => {
    await request(app).post('/send-email').send({
      id: 'email2',
      to: 'a@example.com',
      subject: 'Dup',
      body: 'Body',
    });

    const res = await request(app).post('/send-email').send({
      id: 'email2',
      to: 'a@example.com',
      subject: 'Dup',
      body: 'Body',
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('Duplicate email');
  });

  test('should enforce rate limiting', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post('/send-email').send({
        id: `rate${i}`,
        to: 'rate@example.com',
        subject: 'Test',
        body: 'Body',
      });
    }

    const res = await request(app).post('/send-email').send({
      id: 'rate3',
      to: 'rate@example.com',
      subject: 'Test',
      body: 'Body',
    });

    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe('Rate limit exceeded');
  });

  test('should track email status', async () => {
    const id = 'status1';
    await request(app).post('/send-email').send({
      id,
      to: 'track@example.com',
      subject: 'Status',
      body: 'Testing',
    });

    expect(emailStatusMap.get(id)).toBe('sent');
  });
});
