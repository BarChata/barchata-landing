// BarChata Web Insights collector (Vercel Edge Function) — https://www.barchata.com/api/t
//
// Every BarChata site sends page views and clicks here (see /a.js). This adds
// what only the server knows — IP address and city-level location from Vercel —
// and stores the batch in Supabase with the service key. Nothing here is
// readable by the public; only super admins can read the tables.
//
// Privacy rules enforced here, not in the browser:
//   - Do Not Track / Global Privacy Control, or a declined banner  -> counted only (no IP, no IDs, no city)
//   - Quebec, EU/EEA, UK, Switzerland without an "Accept"          -> counted only, and the
//     response asks the page to show the consent banner.
//
// Needs two Vercel environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

export const config = { runtime: 'edge' };

const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*barchata\.com$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const CONSENT_COUNTRIES = new Set(('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE ' +
  'IS LI NO GB CH').split(' '));
const BOT = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|axios|node-fetch|go-http/i;

function allowed(origin, req) {
  if (!origin) return false;
  if (ORIGIN_OK.test(origin)) return true;
  try { return origin === new URL(req.url).origin; } catch { return false; } // same-site, e.g. a Vercel preview
}

function cors(origin, ok) {
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

function parseUA(ua) {
  const s = ua || '';
  const device = /iPad|Tablet/i.test(s) ? 'tablet' : /Mobi|iPhone|Android/i.test(s) ? 'mobile' : 'desktop';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung'
    : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Other';
  const os = /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS'
    : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'Other';
  return { device, browser, os };
}

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const uuid = (v) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const ok = allowed(origin, req);
  const headers = cors(origin, ok);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return new Response('{"ok":false}', { status: 405, headers });
  if (!ok) return new Response('{"ok":false}', { status: 403, headers });

  const raw = await req.text();
  if (raw.length > 24000) return new Response('{"ok":false}', { status: 413, headers });
  let b;
  try { b = JSON.parse(raw); } catch { return new Response('{"ok":false}', { status: 400, headers }); }
  if (!b || !Array.isArray(b.events) || b.events.length === 0) return new Response('{"ok":false}', { status: 400, headers });

  const country = req.headers.get('x-vercel-ip-country') || null;
  const region = req.headers.get('x-vercel-ip-country-region') || null;
  let city = req.headers.get('x-vercel-ip-city') || null;
  try { if (city) city = decodeURIComponent(city); } catch { /* keep raw */ }
  const ip = (req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || '').trim() || null;
  const ua = req.headers.get('user-agent') || '';

  const consentRegion = (country && CONSENT_COUNTRIES.has(country)) || (country === 'CA' && region === 'QC');
  const consent = b.consent === '1' ? '1' : b.consent === '0' ? '0' : null;
  const anonymous = !!b.dnt || consent === '0' || (consentRegion && consent !== '1');
  const bot = BOT.test(ua) || !!b.webdriver;

  let refHost = null;
  try { if (b.referrer) refHost = new URL(b.referrer).hostname; } catch { /* ignore */ }

  const events = b.events.slice(0, 50).map((e) => ({
    type: clip(e && e.type, 20) || 'event',
    name: clip(e && e.name, 80),
    path: clip(e && e.path, 500),
    label: clip(e && e.label, 200),
    props: e && e.props && typeof e.props === 'object' ? e.props : undefined,
  }));

  const p = {
    site: clip(b.site, 60) || 'web',
    visitor_id: anonymous ? null : uuid(b.vid),
    session_id: anonymous ? null : uuid(b.sid),
    anonymous,
    internal: !!b.internal,
    bot,
    ip: anonymous ? null : ip,
    country, region,
    city: anonymous ? null : city,
    lat: anonymous ? null : req.headers.get('x-vercel-ip-latitude'),
    lng: anonymous ? null : req.headers.get('x-vercel-ip-longitude'),
    referrer: clip(b.referrer, 500),
    referrer_host: refHost,
    landing: clip(b.landing, 500),
    utm: b.utm && typeof b.utm === 'object' ? {
      source: clip(b.utm.source, 120), medium: clip(b.utm.medium, 120), campaign: clip(b.utm.campaign, 120),
    } : null,
    screen: clip(b.screen, 20),
    lang: clip(b.lang, 20),
    ...parseUA(ua),
    events,
  };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      await fetch(url + '/rest/v1/rpc/analytics_ingest', {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p }),
      });
    } catch { /* analytics must never break a page */ }
  }

  return new Response(JSON.stringify({ ok: true, consent: consentRegion && consent === null ? 'required' : 'ok' }), { status: 200, headers });
}
