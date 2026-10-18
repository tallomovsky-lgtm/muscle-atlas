// Bis food-recognition server (Cloudflare Worker).
// Holds the Anthropic API key so app users don't need their own.
// Key:      set from the app (Settings → owner) and kept in KV; the ANTHROPIC_API_KEY
//           secret is used only when no key was set from the app
// Binding:  LIMITS           KV namespace for the key, the owner code and the daily counters
// Optional: ALLOWED_ORIGINS  comma-separated, default the GitHub Pages site
//           MODEL            default claude-opus-5-5 (claude-haiku-5-5 is much cheaper)
//           DAILY_PER_USER   requests per phone per day, default 6
//           DAILY_PER_IP     requests per network address per day, default 20
//           DAILY_TOTAL      requests for everyone together per day, default 30

const VERSION = 8;
const DEFAULT_ORIGINS = 'https://tallomovsky-lgtm.github.io';
const MAX_IMAGE_B64 = 3_000_000; // ~2.2 MB jpeg; the app sends ~100-300 KB
const MAX_DESC = 600;

// Daily quotas, reset at midnight Israel time. With the LIMITS KV binding the counters
// survive restarts and are shared by every Worker instance; without it they live in
// memory and only slow abuse down. The prepaid credit in the Anthropic console is the
// hard ceiling either way.
const mem = new Map();
// 'q4:' namespace: counters from older versions (which counted failed calls) are left behind
const today = () => 'q4:' + new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const DEVICE_RE = /^[a-z0-9]{8,40}$/;

// Account-level problems (no credit, bad key) are remembered for 30 minutes so the app can say
// so before anyone wastes a photo; the next successful call clears it.
const PROBLEM_KEY = 'status:problem';
const ACCOUNT_PROBLEMS = ['no_credit', 'bad_key', 'forbidden', 'model'];
async function getProblem(env) {
  try {
    const v = env.LIMITS ? await env.LIMITS.get(PROBLEM_KEY) : mem.get(PROBLEM_KEY);
    const p = v ? JSON.parse(v) : null;
    return p && Date.now() - p.at < 1800_000 ? p : null;
  } catch { return null; }
}
async function setProblem(env, code) {
  const v = JSON.stringify({ code, at: Date.now() });
  try { env.LIMITS ? await env.LIMITS.put(PROBLEM_KEY, v, { expirationTtl: 1800 }) : mem.set(PROBLEM_KEY, v); } catch { /* best effort */ }
}
async function clearProblem(env) {
  try {
    if (env.LIMITS) { if (await env.LIMITS.get(PROBLEM_KEY)) await env.LIMITS.delete(PROBLEM_KEY); }
    else mem.delete(PROBLEM_KEY);
  } catch { /* best effort */ }
}
async function getCount(env, key) {
  if (env.LIMITS) return Number(await env.LIMITS.get(key)) || 0;
  return mem.get(key) || 0;
}
async function setCount(env, key, n) {
  if (env.LIMITS) return env.LIMITS.put(key, String(Math.max(0, n)), { expirationTtl: 172800 });
  if (mem.size > 5000) mem.clear();
  mem.set(key, Math.max(0, n));
}
function limitsOf(env) {
  return {
    user: Number(env.DAILY_PER_USER) || 6,
    ip: Number(env.DAILY_PER_IP) || 20,
    total: Number(env.DAILY_TOTAL) || 30,
  };
}
// Reserves one request before calling Claude. Released again when Claude never answered
// (error status or network failure), because those calls aren't billed. Answers that came back
// but couldn't be used still count, since they were billed.
async function takeQuota(env, device, ip) {
  const d = today(), lim = limitsOf(env);
  const keys = [`${d}:all`, `${d}:u:${device || ip}`, `${d}:ip:${ip}`];
  const [total, user, byIp] = await Promise.all(keys.map(k => getCount(env, k)));
  if (total >= lim.total) return { ok: false, scope: 'all', limit: lim.total };
  if (user >= lim.user || byIp >= lim.ip) return { ok: false, scope: 'user', limit: lim.user };
  await Promise.all([setCount(env, keys[0], total + 1), setCount(env, keys[1], user + 1), setCount(env, keys[2], byIp + 1)]);
  return { ok: true, keys, left: Math.max(0, Math.min(lim.user - user - 1, lim.total - total - 1)), limit: lim.user };
}
async function releaseQuota(env, keys) {
  try { await Promise.all(keys.map(async k => setCount(env, k, (await getCount(env, k)) - 1))); } catch { /* counters are best effort */ }
}

function cors(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function prompt(desc, hasImg) {
  return `You are an experienced dietitian estimating the nutrition of a meal ${hasImg ? 'from the attached photo' : 'from a description'}.
${desc ? `The user says: """${desc}""". Trust this for what the food is and how much of it there is when it conflicts with the photo.` : ''}
Think it through before answering:
1. List every food and drink, including liquids (milk, juice, soup), toppings, spreads, cooking oil, sauces and dressings. In Israel milk is usually 3% fat.
2. Estimate the whole portion shown and assume all of it is eaten. Judge size from the dish (dinner plate about 26 cm, cereal bowl about 15 cm, glass about 250 ml), cutlery and hands. When unsure, use the typical adult serving rather than the smallest plausible one: photo estimates usually come out too low, not too high.
3. Use standard nutrition tables (USDA, Israeli food composition tables) with cooked or ready-to-eat weights.
Typical servings for reference: a bowl of breakfast cereal 50-60 g with about 200 ml milk; a plate of cooked pasta or rice 200-250 g; a schnitzel 150-180 g; a pita 90-110 g; a plate of hummus 150-250 g; a shakshuka with 2 eggs and about 150 g sauce; 1 tablespoon of oil 13 g = 117 kcal.
Typical Israeli foods are common (pita, hummus, schnitzel, shakshuka, salads, tahini, bourekas, sushi).
Then reply with ONLY a JSON object, no other text:
{"title":"<short Hebrew name for the whole meal>","items":[{"name":"<Hebrew name>","grams":<number>,"kcal":<number>,"protein":<number>,"fat":<number>,"carbs":<number>}],"note":"<one short Hebrew sentence with the portion sizes you assumed, so the user can correct them>"}
If there is no food, return {"title":"","items":[],"note":"<Hebrew explanation>"}.`;
}

// Raw fetch: a Worker pasted into the Cloudflare dashboard has no npm bundler for the SDK.
// The first attempt asks for medium effort (portion estimates need the reasoning) and
// server-side refusal fallbacks; if the API rejects
// the request shape (400 that isn't about credit), it retries once with only the basics.
// Pasting easily adds spaces, a newline or quotes around the key.
const cleanKey = k => String(k || '').trim().replace(/^["']+|["']+$/g, '').trim();
const keyFormat = k => (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k) ? 'ok' : 'bad');
const KEY_KV = 'cfg:apikey', PIN_KV = 'cfg:pinhash';
async function storedKey(env) {
  if (!env.LIMITS) return '';
  try { return cleanKey(await env.LIMITS.get(KEY_KV)); } catch { return ''; }
}
async function apiKey(env) { return (await storedKey(env)) || cleanKey(env.ANTHROPIC_API_KEY); }

// Checks a key with a tiny request (a few tokens, a fraction of a cent): 401 means the key
// is wrong, a credit error means it is right but the account has no credit.
async function testKey(key) {
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK' }] }),
    });
  } catch { return 'unknown'; }
  if (r.ok) return 'ok';
  const err = await errorOf(r);
  if (r.status === 401) return 'bad_key';
  if (r.status === 403) return 'forbidden';
  if (codeFor(r.status, err) === 'no_credit') return 'no_credit';
  if (r.status === 529 || r.status >= 500) return 'unknown';
  return 'ok'; // authenticated; other 4xx are about this tiny request, not the key
}
async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bis-owner:' + text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Owner actions from the app. The first owner code ever sent becomes the code; after that
// every action needs it. Attempts are limited per network address per day.
async function admin(env, body, ip, reply) {
  if (!env.LIMITS) return reply(400, { error: 'no_kv' });
  const attemptsKey = `${today()}:admin:${ip}`;
  const attempts = await getCount(env, attemptsKey);
  if (attempts >= 10) return reply(429, { error: 'rate_limited' });
  await setCount(env, attemptsKey, attempts + 1);

  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  if (pin.length < 6 || pin.length > 64) return reply(400, { error: 'pin_short' });
  const saved = await env.LIMITS.get(PIN_KV);
  const hash = await sha(pin);
  if (saved && saved !== hash) return reply(403, { error: 'bad_pin' });

  if (body.action === 'setkey') {
    const key = cleanKey(body.key);
    if (keyFormat(key) !== 'ok') return reply(400, { error: 'key_format', length: key.length });
    const result = await testKey(key);
    if (result === 'bad_key' || result === 'forbidden') return reply(400, { error: result });
    if (!saved) await env.LIMITS.put(PIN_KV, hash);
    await env.LIMITS.put(KEY_KV, key);
    if (result === 'ok') await clearProblem(env); else if (result === 'no_credit') await setProblem(env, 'no_credit');
    return reply(200, { ok: true, result });
  }
  if (body.action === 'testkey') {
    if (!saved) return reply(400, { error: 'no_owner' });
    const key = await apiKey(env);
    if (!key) return reply(400, { error: 'no_key' });
    const result = await testKey(key);
    if (result === 'ok') await clearProblem(env); else if (['bad_key', 'forbidden', 'no_credit'].includes(result)) await setProblem(env, result);
    return reply(200, { ok: true, result });
  }
  return reply(400, { error: 'action' });
}

async function callClaude(env, content, basic) {
  const headers = { 'content-type': 'application/json', 'x-api-key': await apiKey(env), 'anthropic-version': '2023-06-01' };
  const body = { model: env.MODEL || 'claude-opus-5-5', max_tokens: 16000, messages: [{ role: 'user', content }] };
  if (!basic) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.output_config = { effort: 'medium' };
    body.fallbacks = 'default';
  }
  return fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function errorOf(r) {
  const j = await r.json().catch(() => null);
  return { type: j?.error?.type || '', message: String(j?.error?.message || '').slice(0, 240) };
}
function codeFor(status, err) {
  if (/credit balance|billing|purchase credits/i.test(err.message)) return 'no_credit';
  if (status === 401) return 'bad_key';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'model';
  if (status === 429) return 'busy';
  if (status === 529 || status >= 500) return 'overloaded';
  return 'upstream';
}

async function handle(request, env, reply) {
  const lim = limitsOf(env);
  if (request.method === 'GET') {
    const device = new URL(request.url).searchParams.get('device') || '';
    const d = today();
    const fromApp = await storedKey(env), k = fromApp || cleanKey(env.ANTHROPIC_API_KEY);
    return reply(200, { ok: true, service: 'bis', version: VERSION, key: !!k, keyFormat: k ? keyFormat(k) : null, keyLength: k.length,
      keySource: fromApp ? 'app' : k ? 'cloudflare' : null, ownerSet: env.LIMITS ? !!(await env.LIMITS.get(PIN_KV)) : false, limits: env.LIMITS ? 'kv' : 'memory',
      perUser: lim.user, total: lim.total, usedToday: await getCount(env, `${d}:all`),
      userToday: DEVICE_RE.test(device) ? await getCount(env, `${d}:u:${device}`) : null,
      problem: await getProblem(env) });
  }
  if (request.method !== 'POST') return reply(405, { error: 'method' });

  let body;
  try { body = await request.json(); } catch { return reply(400, { error: 'bad_json' }); }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (new URL(request.url).pathname === '/admin') return admin(env, body, ip, reply);
  if (!(await apiKey(env))) return reply(500, { error: 'no_key' });
  const desc = typeof body.desc === 'string' ? body.desc.trim().slice(0, MAX_DESC) : '';
  const image = typeof body.image === 'string' ? body.image : '';
  const device = typeof body.device === 'string' && DEVICE_RE.test(body.device) ? body.device : '';
  if (!desc && !image) return reply(400, { error: 'empty' });
  // cheap sanity check; scanning the whole base64 string costs CPU time on the free plan
  if (image && (image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]{16}/.test(image))) return reply(413, { error: 'image' });

  const quota = await takeQuota(env, device, ip);
  if (!quota.ok) return reply(429, { error: 'rate_limited', scope: quota.scope, limit: quota.limit });

  const state = { answered: false };
  try { return await analyze(env, content(image, desc), quota, reply, state); }
  catch (e) { if (!state.answered) await releaseQuota(env, quota.keys); throw e; }
}

function content(image, desc) {
  const c = [];
  if (image) c.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  c.push({ type: 'text', text: prompt(desc, !!image) });
  return c;
}

async function analyze(env, content, quota, reply, state) {
  let r = await callClaude(env, content, false);
  if (r.status === 400) {
    const err = await errorOf(r.clone());
    if (codeFor(400, err) !== 'no_credit') r = await callClaude(env, content, true);
  }
  if (r.status === 529 || r.status === 500 || r.status === 503) { await sleep(1500); r = await callClaude(env, content, true); }
  if (!r.ok) {
    const err = await errorOf(r);
    const code = codeFor(r.status, err);
    await releaseQuota(env, quota.keys);
    if (ACCOUNT_PROBLEMS.includes(code)) await setProblem(env, code);
    return reply(502, { error: code, status: r.status, message: err.message });
  }
  state.answered = true;
  await clearProblem(env);

  const msg = await r.json();
  if (msg.stop_reason === 'refusal') return reply(422, { error: 'refusal' });
  const text = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  let out = null;
  if (a >= 0 && b > a) { try { out = JSON.parse(text.slice(a, b + 1)); } catch { out = null; } }
  if (!out) return reply(502, { error: 'parse', stop: msg.stop_reason || '' });
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
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, allowed);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method === 'POST' && !allowed.includes(origin)) return reply(403, { error: 'origin' });
    // Any unexpected failure still answers with CORS headers, so the app can show the reason.
    try { return await handle(request, env, reply); }
    catch (e) { return reply(500, { error: 'crash', message: String(e && e.message || e).slice(0, 240) }); }
  },
};
