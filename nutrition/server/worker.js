// Bis food-recognition server (Cloudflare Worker).
// Holds the Anthropic API key so app users don't need their own.
// Secret:   ANTHROPIC_API_KEY
// Binding:  LIMITS           KV namespace that keeps the daily counters (recommended)
// Optional: ALLOWED_ORIGINS  comma-separated, default the GitHub Pages site
//           MODEL            default claude-opus-5-5 (claude-haiku-5-5 is much cheaper)
//           DAILY_PER_USER   requests per phone per day, default 6
//           DAILY_PER_IP     requests per network address per day, default 20
//           DAILY_TOTAL      requests for everyone together per day, default 12

const DEFAULT_ORIGINS = 'https://tallomovsky-lgtm.github.io';
const MAX_IMAGE_B64 = 2_000_000; // ~1.5 MB jpeg; the app sends ~200-400 KB
const MAX_DESC = 600;

// Daily quotas, reset at midnight Israel time. With the LIMITS KV binding the counters
// survive restarts and are shared by every Worker instance; without it they live in
// memory and only slow abuse down. The monthly spend limit in the Anthropic console
// is the hard ceiling either way.
const mem = new Map();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
async function getCount(env, key) {
  if (env.LIMITS) return Number(await env.LIMITS.get(key)) || 0;
  return mem.get(key) || 0;
}
async function setCount(env, key, n) {
  if (env.LIMITS) return env.LIMITS.put(key, String(n), { expirationTtl: 172800 });
  if (mem.size > 5000) mem.clear();
  mem.set(key, n);
}
function limitsOf(env) {
  return {
    user: Number(env.DAILY_PER_USER) || 6,
    ip: Number(env.DAILY_PER_IP) || 20,
    total: Number(env.DAILY_TOTAL) || 12,
  };
}
// Reserves one request before calling Claude, so a failed call can't be retried for free.
async function takeQuota(env, device, ip) {
  const d = today(), lim = limitsOf(env);
  const keys = { total: `${d}:all`, user: `${d}:u:${device || ip}`, ip: `${d}:ip:${ip}` };
  const [total, user, byIp] = await Promise.all([getCount(env, keys.total), getCount(env, keys.user), getCount(env, keys.ip)]);
  if (total >= lim.total) return { ok: false, scope: 'all', limit: lim.total };
  if (user >= lim.user) return { ok: false, scope: 'user', limit: lim.user };
  if (byIp >= lim.ip) return { ok: false, scope: 'user', limit: lim.user };
  await Promise.all([setCount(env, keys.total, total + 1), setCount(env, keys.user, user + 1), setCount(env, keys.ip, byIp + 1)]);
  return { ok: true, left: Math.max(0, Math.min(lim.user - user - 1, lim.total - total - 1)), limit: lim.user };
}

function cors(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function prompt(desc, hasImg) {
  return `You are a precise nutrition estimator. ${hasImg ? 'Look at the attached food photo.' : ''}
${desc ? `The user describes the food as: """${desc}""" — trust this description for food identity and quantities when it conflicts with the photo.` : ''}
Identify each distinct food item, estimate the eaten portion in grams, and estimate calories (kcal), protein, fat and carbohydrates in grams for that portion. Account for visible oil, sauces and dressings. Typical Israeli foods are common (pita, hummus, schnitzel, shakshuka, salads, tahini, bourekas).
Reply with ONLY a JSON object, no other text:
{"title":"<short Hebrew name for the whole meal>","items":[{"name":"<Hebrew name>","grams":<number>,"kcal":<number>,"protein":<number>,"fat":<number>,"carbs":<number>}],"note":"<one short Hebrew sentence on the main assumption, e.g. portion size or cooking oil>"}
If there is no food, return {"title":"","items":[],"note":"<Hebrew explanation>"}.`;
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, allowed);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method === 'GET') {
      const lim = limitsOf(env);
      return reply(200, { ok: true, service: 'bis', key: !!env.ANTHROPIC_API_KEY, limits: env.LIMITS ? 'kv' : 'memory',
        perUser: lim.user, total: lim.total, usedToday: await getCount(env, `${today()}:all`) });
    }
    if (request.method !== 'POST') return reply(405, { error: 'method' });
    if (!allowed.includes(origin)) return reply(403, { error: 'origin' });
    if (!env.ANTHROPIC_API_KEY) return reply(500, { error: 'no_key' });

    let body;
    try { body = await request.json(); } catch { return reply(400, { error: 'bad_json' }); }
    const desc = typeof body.desc === 'string' ? body.desc.trim().slice(0, MAX_DESC) : '';
    const image = typeof body.image === 'string' ? body.image : '';
    const device = typeof body.device === 'string' && /^[a-z0-9]{8,40}$/.test(body.device) ? body.device : '';
    if (!desc && !image) return reply(400, { error: 'empty' });
    if (image && (image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(image))) return reply(413, { error: 'image' });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const quota = await takeQuota(env, device, ip);
    if (!quota.ok) return reply(429, { error: 'rate_limited', scope: quota.scope, limit: quota.limit });

    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
    content.push({ type: 'text', text: prompt(desc, !!image) });

    // Raw fetch: a Worker pasted into the Cloudflare dashboard has no npm bundler for the SDK.
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: env.MODEL || 'claude-opus-5-5',
        max_tokens: 8000,
        output_config: { effort: 'low' },
        fallbacks: 'default',
        messages: [{ role: 'user', content }],
      }),
    });
    if (!r.ok) return reply(502, { error: 'upstream', status: r.status });
    const msg = await r.json();
    if (msg.stop_reason === 'refusal') return reply(422, { error: 'refusal' });

    const text = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) return reply(502, { error: 'parse' });
    try {
      const out = JSON.parse(text.slice(a, b + 1));
      const num = v => Math.max(0, Number(v) || 0);
      return reply(200, {
        quota: { left: quota.left, limit: quota.limit },
        title: String(out.title || '').slice(0, 80),
        note: String(out.note || '').slice(0, 300),
        items: (Array.isArray(out.items) ? out.items : []).slice(0, 20).map(x => ({
          name: String(x.name || '').slice(0, 60), grams: num(x.grams), kcal: num(x.kcal),
          protein: num(x.protein), fat: num(x.fat), carbs: num(x.carbs),
        })),
      });
    } catch { return reply(502, { error: 'parse' }); }
  },
};
