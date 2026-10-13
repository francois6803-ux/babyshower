// GET /api/guests — admin-only RSVP list from Resend. Gated by ADMIN_TOKEN.
// Header: x-admin-token: <token>   (or ?token=<token>)
// Env: RESEND_API_KEY, ADMIN_TOKEN
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  const supplied = req.headers["x-admin-token"] || (req.query && req.query.token) || "";
  if (!ADMIN_TOKEN || supplied !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: "Server not configured." });
  }
  const authHeaders = { Authorization: `Bearer ${RESEND_API_KEY}` };

  function propVal(props, key) {
    if (!props || !props[key]) return null;
    const p = props[key];
    return (p && typeof p === "object" && "value" in p) ? p.value : p;
  }

  try {
    // List every contact (paged). RSVPs are identified by their rsvp_status
    // property below, not by segment membership: contacts created via the
    // API were not being added to the RSVP segment.
    const rows = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
      const qs = `limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const lr = await fetch(`https://api.resend.com/contacts?${qs}`, { headers: authHeaders });
      if (!lr.ok) {
        console.error("Resend list failed", lr.status, await lr.text().catch(()=>''));
        return res.status(502).json({ ok: false, error: "Could not load guests." });
      }
      const listJson = await lr.json();
      const batch = Array.isArray(listJson.data) ? listJson.data : (Array.isArray(listJson) ? listJson : []);
      rows.push(...batch);
      if (!listJson.has_more || !batch.length) break;
      after = batch[batch.length - 1].id;
    }

    // Fetch each contact's full detail (properties aren't in the list payload).
    const guests = await Promise.all(rows.map(async (c) => {
      const id = c.id;
      let props = c.properties || null;
      if (!props && id) {
        try {
          const gr = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(id)}`, { headers: authHeaders });
          if (gr.ok) { const gj = await gr.json(); props = gj.properties || (gj.data && gj.data.properties) || null; }
        } catch (_) {}
      }
      return {
        id,
        first: c.first_name || "",
        last: c.last_name || "",
        email: c.email || "",
        phone: propVal(props, "phone") || "",
        isRsvp: !!propVal(props, "rsvp_status"),
        status: propVal(props, "rsvp_status") || "pending",
        adults: propVal(props, "adults"),
        children: propVal(props, "children"),
        dietary: propVal(props, "dietary") || "",
        message: propVal(props, "guest_message") || "",
        created: c.created_at || null,
      };
    }));

    // Exclude the internal test record if present.
    const clean = guests
      .filter(g => g.isRsvp && g.email !== "test-rsvp@apexacquisition.co.za")
      .map(({ isRsvp, ...g }) => g);
    clean.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    return res.status(200).json({ ok: true, guests: clean });
  } catch (e) {
    console.error("Resend read error", e);
    return res.status(502).json({ ok: false, error: "Could not load guests." });
  }
};
