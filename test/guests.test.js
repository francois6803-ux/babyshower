// Run with: node --test
process.env.ADMIN_TOKEN = "secret";
process.env.RESEND_API_KEY = "key";
process.env.RESEND_RETRY_BASE_MS = "1";

const test = require("node:test");
const assert = require("node:assert");
const handler = require("../api/guests.js");

// Fake Resend: contacts listed 2 per page; `fail` maps contact id -> responses to give before success.
function fakeResend(contacts, fail = {}) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/contacts") {
      const ids = Object.keys(contacts);
      const start = u.searchParams.get("after") ? ids.indexOf(u.searchParams.get("after")) + 1 : 0;
      const page = ids.slice(start, start + 2);
      return resp(200, { has_more: start + 2 < ids.length, data: page.map(id => ({ id, ...contacts[id].row })) });
    }
    const id = decodeURIComponent(u.pathname.split("/").pop());
    if (fail[id] && fail[id].length) return resp(fail[id].shift(), {});
    return resp(200, { properties: contacts[id].props });
  };
  return calls;
}
function resp(status, body) {
  return { ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => "" };
}
function rsvp(status, extra = {}) {
  return { rsvp_status: { value: status }, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }])) };
}
async function call(token = "secret") {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler({ method: "GET", headers: { "x-admin-token": token }, query: {} }, res);
  return res;
}

test("rejects a wrong admin code", async () => {
  fakeResend({});
  assert.strictEqual((await call("wrong")).code, 401);
});

test("lists every RSVP across pages, newest first, without relying on segments", async () => {
  const calls = fakeResend({
    a: { row: { email: "a@x.com", first_name: "A", created_at: "2026-10-06" }, props: rsvp("attending", { adults: 2, children: 1 }) },
    b: { row: { email: "b@x.com", first_name: "B", created_at: "2026-10-09" }, props: rsvp("not_attending") },
    c: { row: { email: "c@x.com", first_name: "C", created_at: "2026-10-07" }, props: rsvp("attending") },
  });
  const res = await call();
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(res.body.guests.map(g => g.email), ["b@x.com", "c@x.com", "a@x.com"]);
  assert.deepStrictEqual(res.body.guests.find(g => g.email === "a@x.com").adults, 2);
  assert.strictEqual(res.body.incomplete, 0);
  assert.ok(calls.every(u => !u.includes("segment")), "admin list must not filter by segment");
});

test("hides the test record and contacts that are not RSVPs", async () => {
  fakeResend({
    a: { row: { email: "a@x.com" }, props: rsvp("attending") },
    n: { row: { email: "newsletter@x.com" }, props: {} },
    t: { row: { email: "test-rsvp@apexacquisition.co.za" }, props: rsvp("attending") },
  });
  assert.deepStrictEqual((await call()).body.guests.map(g => g.email), ["a@x.com"]);
});

test("retries when Resend rate-limits instead of dropping the guest", async () => {
  fakeResend({ a: { row: { email: "a@x.com" }, props: rsvp("attending") } }, { a: [429, 429] });
  const res = await call();
  assert.deepStrictEqual(res.body.guests.map(g => [g.email, g.status]), [["a@x.com", "attending"]]);
  assert.strictEqual(res.body.incomplete, 0);
});

test("a guest whose details never load is shown as unknown, not hidden", async () => {
  fakeResend({ a: { row: { email: "a@x.com" }, props: rsvp("attending") } }, { a: [500, 500, 500, 500] });
  const res = await call();
  assert.deepStrictEqual(res.body.guests.map(g => [g.email, g.status]), [["a@x.com", "unknown"]]);
  assert.strictEqual(res.body.incomplete, 1);
});
