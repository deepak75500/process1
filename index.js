const express = require('express');
const app = express();

app.use(express.json());
const sentEmails = new Map(); 
const rateLimits = new Map(); 
const queue = [];
let processingQueue = false;

const RATE_LIMIT_MAX = 5; 
const RATE_LIMIT_WINDOW_MS = 60 * 1000; 

const providers = [
  {
    name: 'ProviderA',
    send: async (email) => {
      console.log(`[ProviderA] Sending email id=${email.id}`);
      if (Math.random() < 0.7) return true;
      throw new Error('ProviderA failed');
    },
    circuitBreaker: { failures: 0, threshold: 3, open: false, resetTimeout: 10_000, lastOpened: null },
  },
  {
    name: 'ProviderB',
    send: async (email) => {
      console.log(`[ProviderB] Sending email id=${email.id}`);
      if (Math.random() < 0.9) return true;
      throw new Error('ProviderB failed');
    },
    circuitBreaker: { failures: 0, threshold: 3, open: false, resetTimeout: 10_000, lastOpened: null },
  },
];


function isCircuitOpen(provider) {
  const cb = provider.circuitBreaker;
  if (!cb.open) return false;
  if (Date.now() - cb.lastOpened > cb.resetTimeout) {
    cb.open = false;
    cb.failures = 0;
    console.log(`[${provider.name}] Circuit breaker reset`);
    return false;
  }
  return true;
}

async function sendWithProvider(email, provider, attempt = 1) {
  if (isCircuitOpen(provider)) {
    throw new Error(`${provider.name} circuit open`);
  }

  try {
    await provider.send(email);
    provider.circuitBreaker.failures = 0;
    return provider.name;
  } catch (err) {
    console.log(`[${provider.name}] Attempt ${attempt} failed: ${err.message}`);
    provider.circuitBreaker.failures++;
    if (provider.circuitBreaker.failures >= provider.circuitBreaker.threshold) {
      provider.circuitBreaker.open = true;
      provider.circuitBreaker.lastOpened = Date.now();
      console.log(`[${provider.name}] Circuit breaker opened`);
    }

    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      return sendWithProvider(email, provider, attempt + 1);
    }
    throw err;
  }
}

async function sendEmail(email) {
  if (sentEmails.has(email.id)) {
    return sentEmails.get(email.id);
  }
  for (const provider of providers) {
    try {
      const providerName = await sendWithProvider(email, provider);
      const status = {
        success: true,
        provider: providerName,
        attempts: provider.circuitBreaker.failures + 1,
      };
      sentEmails.set(email.id, status);
      return status;
    } catch {
    }
  }
  
  const status = { success: false, provider: null, attempts: 3 };
  sentEmails.set(email.id, status);
  return status;
}

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 1, lastReset: now });
    return next();
  }

  const data = rateLimits.get(ip);

  if (now - data.lastReset > RATE_LIMIT_WINDOW_MS) {
    data.count = 1;
    data.lastReset = now;
    return next();
  }

  if (data.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  data.count++;
  next();
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;

  while (queue.length) {
    const { email, res } = queue.shift();
    try {
      const status = await sendEmail(email);
      res.json({ emailId: email.id, status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  processingQueue = false;
}

app.post('/send-email', rateLimiter, (req, res) => {
  const email = req.body;

  if (!email.id || !email.to || !email.subject || !email.body) {
    return res.status(400).json({ error: 'Missing required email fields: id, to, subject, body' });
  }

  queue.push({ email, res });
  processQueue();
});

app.get('/status/:emailId', (req, res) => {
  const emailId = req.params.emailId;
  if (!sentEmails.has(emailId)) {
    return res.status(404).json({ error: 'Email ID not found' });
  }
  res.json({ emailId, status: sentEmails.get(emailId) });
});

app.get('/', (req, res) => {
  res.send('Email service running');
});

const PORT = process.env.PORT || 2999;
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
