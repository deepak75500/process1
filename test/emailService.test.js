class EmailService {
  constructor() {
    this.providers = [this.provider1, this.provider2];
    this.statusMap = new Map();
    this.sentEmails = new Set();
    this.timestamps = [];
    this.MAX_EMAILS = 3;
    this.WINDOW_MS = 10000;
  }

  async provider1() {
    throw new Error("Provider1 failed");
  }

  async provider2() {
    return { success: true };
  }

  isRateLimited() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(ts => now - ts < this.WINDOW_MS);
    if (this.timestamps.length >= this.MAX_EMAILS) return true;
    this.timestamps.push(now);
    return false;
  }

  async retrySend(provider, email, retries = 3) {
    for (let i = 0; i <= retries; i++) {
      try {
        return await provider(email);
      } catch {
        if (i === retries) throw new Error("Retries exhausted");
        await new Promise(res => setTimeout(res, 2 ** i * 100));
      }
    }
  }

  async sendEmail(email) {
    const { id } = email;
    if (this.sentEmails.has(id)) return { status: "duplicate" };
    if (this.isRateLimited()) return { status: "rate_limited" };

    for (const provider of this.providers) {
      try {
        const result = await this.retrySend(provider.bind(this), email);
        if (result.success) {
          this.sentEmails.add(id);
          this.statusMap.set(id, "sent");
          return { status: "sent" };
        }
      } catch {}
    }

    this.statusMap.set(id, "failed");
    return { status: "failed" };
  }

  getStatus(id) {
    return this.statusMap.get(id) || "unknown";
  }
}

// --------------------
//  Jest Unit Tests
// --------------------

describe("EmailService", () => {
  let service;

  beforeEach(() => {
    service = new EmailService();
  });

  test("should send email successfully via fallback", async () => {
    const email = { id: "1", to: "a@b.com", subject: "Hi", body: "Hello" };
    const result = await service.sendEmail(email);
    expect(result.status).toBe("sent");
  });

  test("should prevent duplicate emails", async () => {
    const email = { id: "2", to: "x@y.com", subject: "Test", body: "Body" };
    await service.sendEmail(email);
    const result = await service.sendEmail(email);
    expect(result.status).toBe("duplicate");
  });

  test("should enforce rate limiting", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      const res = await service.sendEmail({
        id: `email${i}`,
        to: "user@example.com",
        subject: "A",
        body: "B",
      });
      results.push(res.status);
    }
    expect(results.includes("rate_limited")).toBe(true);
  });

  test("should track email status", async () => {
    const email = { id: "track1", to: "abc@x.com", subject: "Track", body: "Me" };
    await service.sendEmail(email);
    const status = service.getStatus("track1");
    expect(status).toBe("sent");
  });
});
