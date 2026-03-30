/**
 * Vercel Serverless Function — Toast POS Waitlist Proxy
 * GET /api/toast-waitlist?clientId=...&clientSecret=...&locationId=...
 *
 * 1. Authenticates with Toast OAuth using client credentials
 * 2. Fetches live waitlist entries for the given location
 * 3. Returns normalized { totalWaiting, avgWait, nextInLine[] }
 */

const TOAST_AUTH_URL = "https://ws-api.toasttab.com/authentication/v1/authentication/login";
const TOAST_WAITLIST_URL = (locationId) =>
  `https://ws-api.toasttab.com/waitlist/v1/locations/${locationId}/entries`;

export default async function handler(req, res) {
  // CORS — allow the lobby display page to call this from any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { clientId, clientSecret, locationId } = req.query;

  if (!clientId || !clientSecret || !locationId) {
    return res.status(400).json({ error: "Missing clientId, clientSecret or locationId" });
  }

  try {
    // ── Step 1: Authenticate ──────────────────────────────────────────
    const authRes = await fetch(TOAST_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        userAccessType: "TOAST_MACHINE_CLIENT",
      }),
    });

    if (!authRes.ok) {
      const txt = await authRes.text();
      return res.status(401).json({ error: "Toast auth failed", detail: txt });
    }

    const authData = await authRes.json();
    const accessToken = authData?.token?.accessToken;

    if (!accessToken) {
      return res.status(401).json({ error: "No access token returned by Toast" });
    }

    // ── Step 2: Fetch waitlist entries ────────────────────────────────
    const wlRes = await fetch(TOAST_WAITLIST_URL(locationId), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Toast-Restaurant-External-ID": locationId,
      },
    });

    if (!wlRes.ok) {
      const txt = await wlRes.text();
      return res.status(wlRes.status).json({ error: "Toast waitlist fetch failed", detail: txt });
    }

    const wlData = await wlRes.json();

    // Toast returns either { entries: [...] } or an array directly
    const raw = Array.isArray(wlData) ? wlData : (wlData.entries || wlData.waitlistEntries || []);

    // ── Step 3: Normalise to our UI format ────────────────────────────
    const entries = raw
      .filter((e) => e.status !== "SEATED" && e.status !== "REMOVED")
      .map((e) => ({
        id: e.guid || e.id || String(Math.random()),
        name: e.partyName || e.name || "Guest",
        size: e.partySize || e.size || 1,
        // quotedTime is minutes from now; fallback to waitMinutes or estimatedWaitMinutes
        waitTime:
          e.quotedTime ??
          e.waitMinutes ??
          e.estimatedWaitMinutes ??
          0,
      }));

    const totalWaiting = entries.length;
    const avgWait =
      totalWaiting > 0
        ? Math.round(entries.reduce((s, e) => s + e.waitTime, 0) / totalWaiting)
        : 0;

    return res.status(200).json({
      totalWaiting,
      avgWait,
      nextInLine: entries.slice(0, 6),
      source: "toast_live",
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
}
