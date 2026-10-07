// POST /api/rsvp — stores an RSVP as a Resend contact and sends a confirmation email.
// Env: RESEND_API_KEY, RSVP_SEGMENT_ID, MAIL_FROM
const EVENT_LINE = "Sunday, 6 December 2026 · 09:00 · The Millhouse Kitchen (Front Deck), Lourensford, Somerset West";

function esc(s) {
  return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const first = (body.first || "").toString().trim();
  const last = (body.last || "").toString().trim();
  const email = (body.email || "").toString().trim().toLowerCase();
  const phone = (body.phone || "").toString().trim();
  const status = (body.status || "").toString().trim();
  const message = (body.message || "").toString().trim();

  if (!first) return res.status(400).json({ ok: false, error: "First name is required." });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: "A valid email is required." });
  if (status !== "attending" && status !== "not_attending") return res.status(400).json({ ok: false, error: "Please choose whether you'll attend." });

  const attending = status === "attending";
  const adults = attending ? (parseInt(body.adults, 10) || 1) : 0;
  const children = attending ? (parseInt(body.children, 10) || 0) : 0;
  const dietary = attending ? (body.dietary || "").toString().trim() : "";

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SEGMENT_ID = process.env.RSVP_SEGMENT_ID;
  if (!RESEND_API_KEY || !SEGMENT_ID) {
    return res.status(500).json({ ok: false, error: "Server not configured." });
  }

  const properties = {
    rsvp_status: status,
    phone,
    adults,
    children,
    dietary,
    guest_message: message,
  };
  const payload = {
    email,
    first_name: first,
    last_name: last,
    unsubscribed: false,
    segment_ids: [SEGMENT_ID],
    properties,
  };
  const authHeaders = { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" };

  // Upsert: create, and if the contact already exists, update it by email.
  try {
    const cr = await fetch("https://api.resend.com/contacts", {
      method: "POST", headers: authHeaders, body: JSON.stringify(payload),
    });
    if (!cr.ok) {
      const ur = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}`, {
        method: "PATCH", headers: authHeaders,
        body: JSON.stringify({ first_name: first, last_name: last, unsubscribed: false, segment_ids: [SEGMENT_ID], properties }),
      });
      if (!ur.ok) {
        console.error("Resend store failed", cr.status, await cr.text().catch(()=>''), "| update", ur.status, await ur.text().catch(()=>''));
        return res.status(502).json({ ok: false, error: "Could not save your RSVP. Please try again." });
      }
    }
  } catch (e) {
    console.error("Resend store error", e);
    return res.status(502).json({ ok: false, error: "Could not save your RSVP. Please try again." });
  }

  // Confirmation email (best effort — never blocks the RSVP)
  try {
    const MAIL_FROM = process.env.MAIL_FROM || "Reno & Jonel <babyshower@apexacquisition.co.za>";
    const name = esc(first);
    const subject = attending
      ? "Your RSVP is in — Reno & Jonel's Baby Shower 🍋"
      : "Thanks for letting us know — Reno & Jonel's Baby Shower";
    const partyLine = attending
      ? `<p style="margin:0;color:#746F5C;">Party: ${adults} adult(s), ${children} child(ren)${dietary && dietary !== "None" ? ` · Dietary: ${esc(dietary)}` : ""}</p>`
      : "";
    const intro = attending
      ? "We're so excited to celebrate with you! Your RSVP has been received."
      : "We're sorry you can't make it — thank you for letting us know.";
    const ref = (first + " " + last).trim() || first;
    const paymentBlock = attending ? `
        <p style="margin:18px 0 6px;"><strong>To secure your seat, please RSVP &amp; pay by 6 November 2026.</strong></p>
        <p style="margin:0 0 10px;color:#746F5C;">Breakfast is <strong>R195 per person</strong>. Please pay by EFT using the details below and use your name as the reference.</p>
        <div style="background:#fff;border:1px solid #EFE8D4;border-radius:12px;padding:16px;margin:0 0 4px;font-size:14px;line-height:1.7;">
          <strong>Banking details</strong><br>
          Bank: FNB/RMB<br>
          Account holder: Jonel Botha<br>
          Account type: FNB Premier Current Account<br>
          Account number: 62563549876<br>
          Branch code: 250655<br>
          Reference: ${esc(ref)}<br>
          Amount: R195 &times; number of guests
        </div>` : "";
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#3A3A2E;">
        <h2 style="color:#55672E;">Hi ${name},</h2>
        <p>${intro}</p>
        <div style="background:#FBF6E4;border-radius:12px;padding:16px;margin:16px 0;">
          <strong>Reno &amp; Jonel's Baby Shower</strong><br>
          <span style="color:#746F5C;">${EVENT_LINE}</span><br>
          ${partyLine}
        </div>
        ${paymentBlock}
        ${attending ? "<p>Can't wait to see you there. 🍋</p>" : ""}
        <p style="color:#9A9478;font-size:12px;margin-top:24px;">Need to change your RSVP? Just reply to this email.</p>
      </div>`;
    const er = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ from: MAIL_FROM, to: [email], reply_to: "jonel.botha@yahoo.com", subject, html }),
    });
    if (!er.ok) console.error("Resend email failed", er.status, await er.text().catch(()=>''));

    // Host notification — tell Jonel about every RSVP (best effort).
    const HOST_NOTIFY = process.env.HOST_NOTIFY || "jonel.botha@yahoo.com";
    const who = `${esc(first)} ${esc(last)}`.trim();
    const verb = attending ? "is ATTENDING ✅" : "can't make it ❌";
    const details = attending
      ? `${adults} adult(s), ${children} child(ren)`
      : "—";
    const hostHtml = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#3A3A2E;">
        <h2 style="color:#55672E;">New RSVP</h2>
        <p><strong>${who}</strong> ${verb}</p>
        <div style="background:#FBF6E4;border-radius:12px;padding:16px;margin:12px 0;color:#3A3A2E;">
          Email: ${esc(email)}<br>
          ${phone ? `Phone: ${esc(phone)}<br>` : ""}
          Party: ${details}<br>
          ${message ? `Message: "${esc(message)}"` : ""}
        </div>
        <p style="color:#9A9478;font-size:12px;">Full guest list: reno-jonel.vercel.app/#admin</p>
      </div>`;
    const hr = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({
        from: MAIL_FROM, to: [HOST_NOTIFY], reply_to: email,
        subject: `RSVP: ${who} ${attending ? "is coming" : "can't make it"}`,
        html: hostHtml,
      }),
    });
    if (!hr.ok) console.error("Host notify failed", hr.status, await hr.text().catch(()=>''));
  } catch (e) {
    console.error("Resend email error", e);
  }

  return res.status(200).json({ ok: true });
};
