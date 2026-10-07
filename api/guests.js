// GET /api/guests — admin-only RSVP list from Resend. Gated by ADMIN_TOKEN.
// Header: x-admin-token: <token>   (or ?token=<token>)
// Env: RESEND_API_KEY, RSVP_SEGMENT_ID, ADMIN_TOKEN
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
  const SEGMENT_ID = process.env.RSVP_SEGMENT_ID;
  if (!RESEND_API_KEY || !SEGMENT_ID) {
    return res.status(500).json({ ok: false, error: "Server not configured." });
  }
  const authHeaders = { Authorization: `Bearer ${RESEND_API_KEY}` };

  function propVal(props, key) {
    if (!props || !props[key]) return null;
    const p = props[key];
    return (p && typeof p === "object" && "value" in p) ? p.value : p;
  }

  try {
    const lr = await fetch(`https://api.resend.com/contacts?segment_id=${encodeURIComponent(SEGMENT_ID)}`, { headers: authHeaders });
    if (!lr.ok) {
      console.error("Resend list failed", lr.status, await lr.text().catch(()=>''));
      return res.status(502).json({ ok: false, error: "Could not load guests." });
    }
    const listJson = await lr.json();
    const rows = Array.isArray(listJson.data) ? listJson.data : (Array.isArray(listJson) ? listJson : []);

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
        status: propVal(props, "rsvp_status") || "pending",
        adults: propVal(props, "adults"),
        children: propVal(props, "children"),
        dietary: propVal(props, "dietary") || "",
        message: propVal(props, "guest_message") || "",
        created: c.created_at || null,
      };
    }));

    // Exclude the internal test record if present.
    const clean = guests.filter(g => g.email !== "test-rsvp@apexacquisition.co.za");
    clean.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    return res.status(200).json({ ok: true, guests: clean });
  } catch (e) {
    console.error("Resend read error", e);
    return res.status(502).json({ ok: false, error: "Could not load guests." });
  }
};
