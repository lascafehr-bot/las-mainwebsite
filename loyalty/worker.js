// Las Cafe loyalty system: one Cloudflare Worker + D1 (binding name: DB).
// Secret required: ADMIN_PASSWORD (also used to sign session cookies).
// Pages: /card (customer), /c/<code>, /staff (cashier), /admin.

import { WALLET_IMG } from './wallet-assets.js';

const RIYADH_OFFSET = 3 * 3600 * 1000; // UTC+3, no daylight saving
const NO_NAME = 'عميل'; // placeholder for imported customers without a name
const DEFAULTS = {
  min_amount: '10',
  cups_per_reward: '5',
  points_per_riyal: '1',
  stamp_cooldown_hours: '0', // 0 = no waiting time between stamps
  points_redemption: '{"enabled":false,"points_needed":null,"value_sar":null}',
  wallet_apple_url: '',
  wallet_google_url: '',
};
const EDITABLE = ['min_amount', 'points_per_riyal', 'stamp_cooldown_hours', 'points_redemption', 'wallet_apple_url', 'wallet_google_url'];
const enc = new TextEncoder();

// ---------- helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (error, status = 400, extra = {}) => json({ error, ...extra }, status);
const html = (body) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// PIN hashing: PBKDF2-SHA256, random salt per staff member (100k = Workers' max iterations).
async function pbkdf2(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256));
}
async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return toHex(salt) + ':' + (await pbkdf2(pin, salt));
}
async function verifyPin(pin, stored) {
  const [saltHex, hash] = stored.split(':');
  return safeEqual(await pbkdf2(pin, fromHex(saltHex)), hash);
}

// Session = signed cookie "base64(payload).hmac". Stateless, so no session table.
async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode('las-session:' + env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function makeSession(env, s) {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ ...s, exp: Date.now() + 12 * 3600 * 1000 }))));
  return payload + '.' + (await hmac(env, payload));
}
async function getSession(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)las=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || !safeEqual(sig, await hmac(env, payload))) return null;
  try {
    const s = JSON.parse(decodeURIComponent(escape(atob(payload))));
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}
const cookie = (v, maxAge) => 'las=' + v + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge;

function normalizePhone(p) {
  let d = String(p || '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? '966' + d : null;
}
const maskPhone = (p) => '0' + p.slice(3);
function newCardCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(8));
  return 'LAS-' + [...b].map((x) => A[x % A.length]).join('');
}
const dayStart = (now) => Math.floor((now + RIYADH_OFFSET) / 86400000) * 86400000 - RIYADH_OFFSET;

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS };
  for (const r of results) s[r.key] = r.value;
  return {
    raw: s,
    minAmount: Number(s.min_amount),
    cups: Number(s.cups_per_reward),
    perRiyal: Number(s.points_per_riyal),
    cooldownMs: Number(s.stamp_cooldown_hours) * 3600 * 1000,
  };
}

async function findCustomer(env, q) {
  q = String(q || '').trim();
  if (/^las-/i.test(q)) return env.DB.prepare('SELECT * FROM customers WHERE card_code = ?').bind(q.toUpperCase()).first();
  const phone = normalizePhone(q);
  return phone ? env.DB.prepare('SELECT * FROM customers WHERE phone = ?').bind(phone).first() : null;
}

const cardView = (c, cfg) => ({
  name: c.name, card_code: c.card_code, cups: c.cups, cups_per_reward: cfg.cups, points: c.points,
  free_drinks: c.cups >= cfg.cups ? 1 : 0, rewards_redeemed: c.rewards_redeemed,
});

function logTx(env, c, s, type, o = {}) {
  return env.DB.prepare(
    'INSERT INTO transactions (customer_id, type, amount, cups_after, points_delta, staff_id, staff_name, branch_id, branch_name, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(c.id, type, o.amount ?? null, o.cups_after ?? c.cups, o.points_delta ?? 0, s.id ?? null, s.name, s.branch_id ?? null, s.branch_name ?? null, o.note ?? null, Date.now());
}

// ---------- Google Wallet ----------
// Needs env.GOOGLE_WALLET_ISSUER_ID (plain var) and env.GOOGLE_SERVICE_ACCOUNT (secret: the service-account JSON key).
// Without them the feature stays off and the button is hidden.
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(enc.encode(s));
const walletReady = (env) => !!(env.GOOGLE_WALLET_ISSUER_ID && env.GOOGLE_SERVICE_ACCOUNT);
const serviceAccount = (env) => { try { return JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch { return null; } };

async function signJwt(sa, claims) {
  const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), body = b64urlStr(JSON.stringify(claims));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return head + '.' + body + '.' + b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + body)));
}

const walletClassId = (env) => env.GOOGLE_WALLET_ISSUER_ID + '.las_loyalty_v1';
const walletClass = (env, origin) => ({
  id: walletClassId(env), issuerName: 'LAS CAFE', programName: 'بطاقة ولاء لاس', countryCode: 'SA', hexBackgroundColor: '#3d4864', reviewStatus: 'UNDER_REVIEW',
  programLogo: { sourceUri: { uri: origin + '/wallet/logo.png' }, contentDescription: { defaultValue: { language: 'ar', value: 'LAS CAFE' } } },
});
// The parts that change with stamps. Sent in the save link and again as a PATCH on every stamp/redeem.
const walletVariable = (c, cfg, origin) => ({
  loyaltyPoints: { label: 'النقاط', balance: { int: c.points } },
  secondaryLoyaltyPoints: { label: 'الأختام', balance: { string: c.cups + ' / ' + cfg.cups } },
  heroImage: { sourceUri: { uri: origin + '/wallet/hero/' + Math.min(c.cups, 5) + '.png' }, contentDescription: { defaultValue: { language: 'ar', value: 'الأختام' } } },
  textModulesData: [{ id: 'status', header: 'المشروب المجاني', body: c.cups >= cfg.cups ? 'جاهز! اطلب من الكاشير' : 'باقي ' + (cfg.cups - c.cups) + ' للحصول عليه' }],
});
const walletObjectId = (env, c) => env.GOOGLE_WALLET_ISSUER_ID + '.' + c.card_code;

async function walletSaveUrl(env, c, cfg, origin) {
  const sa = serviceAccount(env);
  const obj = { id: walletObjectId(env, c), classId: walletClassId(env), state: 'ACTIVE', accountId: c.card_code, accountName: c.name,
    barcode: { type: 'QR_CODE', value: c.card_code, alternateText: c.card_code }, ...walletVariable(c, cfg, origin) };
  const jwt = await signJwt(sa, { iss: sa.client_email, aud: 'google', typ: 'savetowallet', iat: Math.floor(Date.now() / 1000), origins: [origin],
    payload: { loyaltyClasses: [walletClass(env, origin)], loyaltyObjects: [obj] } });
  return 'https://pay.google.com/gp/v/save/' + jwt;
}

// Best effort: if this customer saved the pass, refresh it. A 404 (never saved) or any failure is ignored.
async function walletSync(env, c, cfg, origin) {
  try {
    const sa = serviceAccount(env), now = Math.floor(Date.now() / 1000);
    const assertion = await signJwt(sa, { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + assertion });
    const { access_token } = await t.json();
    if (!access_token) return;
    await fetch('https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/' + encodeURIComponent(walletObjectId(env, c)),
      { method: 'PATCH', headers: { authorization: 'Bearer ' + access_token, 'content-type': 'application/json' }, body: JSON.stringify(walletVariable(c, cfg, origin)) });
  } catch { /* ignore */ }
}
const syncWallet = (env, ctx, c, cfg, origin) => { if (walletReady(env) && ctx) ctx.waitUntil(walletSync(env, c, cfg, origin)); };
const pngResponse = (b64) => new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });

// ---------- guess protection ----------
// A cafe's customers and tills share one Wi-Fi address, so the limits are generous for normal use.
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';
const countHits = async (env, key, windowMs) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND ts > ?').bind(key, Date.now() - windowMs).first()).n;
async function addHit(env, key, windowMs) {
  await env.DB.prepare('INSERT INTO rate_limits (key, ts) VALUES (?, ?)').bind(key, Date.now()).run();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rate_limits WHERE ts < ?').bind(Date.now() - 86400000).run();
  return countHits(env, key, windowMs);
}
const TOO_MANY = 'محاولات كثيرة، حاول بعد قليل';

// ---------- backup ----------
function csv(rows, cols) {
  const cell = (v) => {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t; // stop spreadsheet formula injection
    return '"' + t.replace(/"/g, '""') + '"';
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}

// ---------- undo ----------
const UNDO_MS = 5 * 60000;
const LIVE = 't.id NOT IN (SELECT tx_id FROM voided)'; // log rows that still count
const lastStampAt = async (env, id) =>
  (await env.DB.prepare("SELECT MAX(t.created_at) AS at FROM transactions t WHERE t.customer_id = ? AND t.type = 'stamp' AND " + LIVE).bind(id).first()).at;
// A stamp can be undone only if nothing later changed this customer's cups or points.
const NO_LATER = "NOT EXISTS (SELECT 1 FROM transactions x WHERE x.customer_id = t.customer_id AND x.id > t.id AND x.type IN ('stamp','redeem','adjust') AND x.id NOT IN (SELECT tx_id FROM voided))";

// ---------- API ----------
async function api(req, env, url, ctx) {
  const path = url.pathname;
  const method = req.method;
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

  // public: customer card lookup (first name only, no phone returned)
  if (path === '/api/public/card' && method === 'GET') {
    const q = url.searchParams.get('code') || url.searchParams.get('phone');
    const missKey = 'miss:' + clientIp(req);
    if ((await countHits(env, missKey, 600000)) >= 40) return fail(TOO_MANY, 429);
    const c = await findCustomer(env, q);
    if (!c) { await addHit(env, missKey, 600000); return fail('لم نجد بطاقة بهذا الرقم', 404); }
    const cfg = await getSettings(env);
    return json({ ...cardView(c, cfg), name: c.name.split(' ')[0], wallet_apple_url: cfg.raw.wallet_apple_url, wallet_google_url: cfg.raw.wallet_google_url, google_wallet: walletReady(env) });
  }

  // public: a customer creates their own card on /card (name + phone)
  if (path === '/api/public/register' && method === 'POST') {
    const SELF = 'تسجيل ذاتي';
    const name = String(body.name || '').trim().slice(0, 60), phone = normalizePhone(body.phone);
    if (name.length < 2) return fail('اكتب اسمك');
    if (!phone) return fail('رقم الجوال غير صحيح (مثال: 05XXXXXXXX)');
    if (await env.DB.prepare('SELECT 1 FROM customers WHERE phone = ?').bind(phone).first()) return fail('هذا الرقم لديه بطاقة، اعرضها بإدخال الرقم', 409);
    // abuse guard: 20 self-registrations per hour per address, 200 across the whole system
    if ((await addHit(env, 'reg:' + clientIp(req), 3600000)) > 20) return fail(TOO_MANY, 429);
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'register' AND staff_name = ? AND created_at > ?").bind(SELF, Date.now() - 3600000).first();
    if (recent.n >= 200) return fail('محاولات كثيرة الآن، حاول لاحقًا أو سجّل عند الكاشير', 429);
    const r = await env.DB.prepare('INSERT INTO customers (phone, name, card_code, created_at) VALUES (?,?,?,?)').bind(phone, name, newCardCode(), Date.now()).run();
    await logTx(env, { id: r.meta.last_row_id, cups: 0 }, { name: SELF }, 'register', { note: 'تسجيل ذاتي من صفحة البطاقة' }).run();
    const cfg = await getSettings(env);
    const row = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(r.meta.last_row_id).first();
    return json({ ...cardView(row, cfg), name: row.name.split(' ')[0], wallet_apple_url: cfg.raw.wallet_apple_url, wallet_google_url: cfg.raw.wallet_google_url, google_wallet: walletReady(env) });
  }

  if (path === '/api/login' && method === 'POST') {
    const name = String(body.username || '').trim(), pin = String(body.pin || '');
    if (!env.ADMIN_PASSWORD) return fail('ADMIN_PASSWORD غير مضبوط', 500);
    // every attempt is counted first, so parallel guesses cannot slip past; success clears the name counter
    const ip = clientIp(req), nameKey = 'login:' + ip + ':' + name.toLowerCase().slice(0, 40);
    if ((await addHit(env, nameKey, 900000)) > 5 || (await addHit(env, 'loginip:' + ip, 900000)) > 30) return fail(TOO_MANY, 429);
    const cleared = () => env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(nameKey).run();
    if (name.toLowerCase() === 'admin') {
      if (!safeEqual(pin, env.ADMIN_PASSWORD)) return fail('بيانات الدخول غير صحيحة', 401);
      await cleared();
      const t = await makeSession(env, { id: null, name: 'Admin', role: 'admin' });
      return json({ ok: true, role: 'admin' }, 200, { 'set-cookie': cookie(t, 43200) });
    }
    const st = await env.DB.prepare('SELECT s.*, b.name AS branch_name FROM staff s JOIN branches b ON b.id = s.branch_id WHERE s.name = ? AND s.active = 1').bind(name).first();
    if (!st || !(await verifyPin(pin, st.pin_hash))) return fail('بيانات الدخول غير صحيحة', 401);
    await cleared();
    const t = await makeSession(env, { id: st.id, name: st.name, role: 'cashier', branch_id: st.branch_id, branch_name: st.branch_name });
    return json({ ok: true, role: 'cashier' }, 200, { 'set-cookie': cookie(t, 43200) });
  }
  if (path === '/api/logout') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });

  const s = await getSession(req, env);
  if (!s) return fail('يجب تسجيل الدخول', 401);
  if (path === '/api/me') return json(s);

  // ---- cashier ----
  const needCashier = () => (s.role === 'cashier' ? null : fail('هذا الإجراء للكاشير فقط', 403));
  if (path === '/api/customer' && method === 'GET') {
    const c = await findCustomer(env, url.searchParams.get('q'));
    if (!c) return fail('غير مسجل', 404);
    const cfg = await getSettings(env);
    const at = await lastStampAt(env, c.id), mins = at && Date.now() - at < UNDO_MS ? Math.max(1, Math.round((Date.now() - at) / 60000)) : null;
    return json({ ...cardView(c, cfg), phone: maskPhone(c.phone), min_amount: cfg.minAmount, points_per_riyal: cfg.perRiyal, stamped_minutes_ago: mins });
  }

  if (path === '/api/register' && method === 'POST') {
    const deny = needCashier(); if (deny) return deny;
    const name = String(body.name || '').trim().slice(0, 60), phone = normalizePhone(body.phone);
    if (name.length < 2) return fail('الاسم مطلوب');
    if (!phone) return fail('رقم الجوال غير صحيح (مثال: 05XXXXXXXX)');
    if (await env.DB.prepare('SELECT 1 FROM customers WHERE phone = ?').bind(phone).first()) return fail('الرقم مسجل مسبقًا', 409);
    const code = newCardCode();
    const r = await env.DB.prepare('INSERT INTO customers (phone, name, card_code, created_at) VALUES (?,?,?,?)').bind(phone, name, code, Date.now()).run();
    const c = { id: r.meta.last_row_id, cups: 0 };
    await logTx(env, c, s, 'register', { note: 'تسجيل عميل جديد' }).run();
    return json({ ok: true, phone: maskPhone(phone) });
  }

  // imported customers may have no name yet: the cashier adds it once, on their first visit
  if (path === '/api/set-name' && method === 'POST') {
    const deny = needCashier(); if (deny) return deny;
    const name = String(body.name || '').trim().slice(0, 60);
    if (name.length < 2) return fail('الاسم مطلوب');
    const c = await findCustomer(env, body.phone);
    if (!c) return fail('العميل غير مسجل', 404);
    const up = await env.DB.prepare('UPDATE customers SET name = ? WHERE id = ? AND name = ?').bind(name, c.id, NO_NAME).run();
    if (up.meta.changes === 0) return fail('العميل له اسم مسجل', 409);
    await logTx(env, c, s, 'name', { note: 'إضافة الاسم' }).run();
    return json({ ...cardView({ ...c, name }, await getSettings(env)), phone: maskPhone(c.phone) });
  }

  if (path === '/api/stamp' && method === 'POST') {
    const deny = needCashier(); if (deny) return deny;
    const amount = Number(body.amount);
    if (!(amount > 0) || amount > 10000) return fail('أدخل مبلغ الفاتورة');
    const c = await findCustomer(env, body.phone);
    if (!c) return fail('العميل غير مسجل', 404);
    const cfg = await getSettings(env);
    if (amount < cfg.minAmount) {
      // under the minimum nothing is recorded: no cup, no points, no log
      return json({ ok: true, stamped: false, message: 'المبلغ أقل من ' + cfg.minAmount + ' ريال، لا يُضاف ختم ولا نقاط', card: cardView(c, cfg) });
    }
    if (c.cups >= cfg.cups) return fail('البطاقة مكتملة، يجب استبدال المشروب المجاني أولاً', 409);
    // Atomic: the WHERE clause enforces both the 3-hour window and the cup cap, even with two cashiers at once.
    const now = Date.now();
    const earned = Math.floor(amount * cfg.perRiyal); // whole points only
    const up = await env.DB.prepare('UPDATE customers SET cups = cups + 1, points = points + ?, last_stamp_at = ? WHERE id = ? AND cups < ? AND (last_stamp_at IS NULL OR last_stamp_at <= ?)')
      .bind(earned, now, c.id, cfg.cups, now - cfg.cooldownMs).run();
    if (up.meta.changes === 0) {
      if (!cfg.cooldownMs) return fail('البطاقة مكتملة، يجب استبدال المشروب المجاني أولاً', 409);
      const wait = Math.max(1, Math.ceil((c.last_stamp_at + cfg.cooldownMs - now) / 60000));
      return fail('تم إضافة ختم لهذا العميل مؤخرًا. المتبقي ' + wait + ' دقيقة', 429, { wait_minutes: wait });
    }
    const after = c.cups + 1;
    await logTx(env, c, s, 'stamp', { amount, cups_after: after, points_delta: earned, note: after >= cfg.cups ? 'اكتملت البطاقة' : null }).run();
    const fresh = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(c.id).first();
    syncWallet(env, ctx, fresh, cfg, url.origin);
    return json({ ok: true, stamped: true, reward_earned: after >= cfg.cups, card: cardView(fresh, cfg) });
  }

  if (path === '/api/redeem' && method === 'POST') {
    const deny = needCashier(); if (deny) return deny;
    const c = await findCustomer(env, body.phone);
    if (!c) return fail('العميل غير مسجل', 404);
    const cfg = await getSettings(env);
    if (c.cups < cfg.cups) return fail('لا توجد مكافأة متاحة', 409);
    if (String(body.last4 || '') !== c.phone.slice(-4)) {
      await logTx(env, c, s, 'redeem_failed', { note: 'آخر 4 أرقام غير صحيحة' }).run();
      return fail('آخر 4 أرقام من الجوال غير صحيحة', 403);
    }
    const up = await env.DB.prepare('UPDATE customers SET cups = 0, rewards_redeemed = rewards_redeemed + 1 WHERE id = ? AND cups >= ?').bind(c.id, cfg.cups).run();
    if (up.meta.changes === 0) return fail('تم الاستبدال مسبقًا', 409);
    await logTx(env, c, s, 'redeem', { cups_after: 0, note: 'مشروب مجاني' }).run();
    const fresh = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(c.id).first();
    syncWallet(env, ctx, fresh, cfg, url.origin);
    return json({ ok: true, card: cardView(fresh, cfg) });
  }

  // the cashier's own last operations today, with which of them can still be undone
  if (path === '/api/recent' && method === 'GET') {
    const deny = needCashier(); if (deny) return deny;
    const { results } = await env.DB.prepare(
      "SELECT t.id, t.type, t.amount, t.points_delta, t.created_at, c.name AS customer, substr(c.phone, -4) AS last4, " +
      "(t.type = 'stamp' AND t.created_at > ?2 AND " + LIVE + " AND " + NO_LATER + ") AS undoable, (t.id IN (SELECT tx_id FROM voided)) AS undone " +
      "FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE t.staff_id = ?1 AND t.type IN ('stamp','redeem','register') AND t.created_at >= ?3 ORDER BY t.id DESC LIMIT 5"
    ).bind(s.id, Date.now() - UNDO_MS, dayStart(Date.now())).all();
    return json({ items: results });
  }

  if (path === '/api/undo' && method === 'POST') {
    const deny = needCashier(); if (deny) return deny;
    const id = Number(body.id);
    const t = await env.DB.prepare("SELECT t.* FROM transactions t WHERE t.id = ? AND t.type = 'stamp' AND t.staff_id = ? AND t.created_at > ? AND " + NO_LATER).bind(id, s.id, Date.now() - UNDO_MS).first();
    if (!t) return fail('لا يمكن التراجع: مضى أكثر من 5 دقائق أو تغيرت البطاقة بعده. اطلب من المدير', 409);
    // the primary key makes a second undo of the same stamp impossible
    const v = await env.DB.prepare('INSERT OR IGNORE INTO voided (tx_id) VALUES (?)').bind(id).run();
    if (v.meta.changes === 0) return fail('تم التراجع مسبقًا', 409);
    await env.DB.prepare('UPDATE customers SET cups = MAX(cups - 1, 0), points = MAX(points - ?, 0), last_stamp_at = ? WHERE id = ?')
      .bind(t.points_delta, await lastStampAt(env, t.customer_id), t.customer_id).run();
    const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(t.customer_id).first();
    const cfg = await getSettings(env);
    await logTx(env, c, s, 'undo', { amount: t.amount, points_delta: -t.points_delta, note: 'تراجع عن ختم رقم ' + id }).run();
    syncWallet(env, ctx, c, cfg, url.origin);
    return json({ ok: true, card: cardView(c, cfg) });
  }

  // ---- admin ----
  if (!path.startsWith('/api/admin/')) return fail('غير موجود', 404);
  if (s.role !== 'admin') return fail('للمدير فقط', 403);

  if (path === '/api/admin/export' && method === 'GET') {
    const tx = url.searchParams.get('what') === 'transactions';
    const cols = tx
      ? ['id', 'time', 'type', 'customer', 'phone', 'amount', 'cups_after', 'points_delta', 'staff_name', 'branch_name', 'note']
      : ['name', 'phone', 'card_code', 'cups', 'points', 'rewards_redeemed', 'created'];
    const { results } = await env.DB.prepare(tx
      ? "SELECT t.id, datetime(t.created_at/1000, 'unixepoch', '+3 hours') AS time, t.type, c.name AS customer, c.phone, t.amount, t.cups_after, t.points_delta, t.staff_name, t.branch_name, t.note FROM transactions t JOIN customers c ON c.id = t.customer_id ORDER BY t.id"
      : "SELECT name, phone, card_code, cups, points, rewards_redeemed, datetime(created_at/1000, 'unixepoch', '+3 hours') AS created FROM customers ORDER BY id").all();
    const file = 'las-' + (tx ? 'transactions' : 'customers') + '-' + new Date(Date.now() + RIYADH_OFFSET).toISOString().slice(0, 10) + '.csv';
    return new Response(csv(results.map((r) => ({ ...r, phone: maskPhone(r.phone) })), cols),
      { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="' + file + '"', 'cache-control': 'no-store' } });
  }

  // manager corrections: every change needs a reason and is logged with old and new values
  if (path === '/api/admin/customer' && method === 'GET') {
    const c = await findCustomer(env, url.searchParams.get('q'));
    if (!c) return fail('لا يوجد عميل بهذا الرقم', 404);
    return json({ id: c.id, name: c.name, phone: maskPhone(c.phone), cups: c.cups, points: c.points });
  }
  if (path === '/api/admin/adjust' && method === 'POST') {
    const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(Number(body.id)).first();
    if (!c) return fail('العميل غير موجود', 404);
    const cfg = await getSettings(env);
    const name = String(body.name || '').trim().slice(0, 60), phone = normalizePhone(body.phone), reason = String(body.reason || '').trim().slice(0, 200);
    const cups = Number(body.cups), points = Number(body.points);
    if (reason.length < 3) return fail('اكتب سبب التعديل');
    if (name.length < 2) return fail('الاسم مطلوب');
    if (!phone) return fail('رقم الجوال غير صحيح');
    if (!(Number.isInteger(cups) && cups >= 0 && cups <= cfg.cups)) return fail('الأكواب من 0 إلى ' + cfg.cups);
    if (!(Number.isInteger(points) && points >= 0 && points <= 1000000)) return fail('النقاط غير صحيحة');
    if (phone !== c.phone && (await env.DB.prepare('SELECT 1 FROM customers WHERE phone = ?').bind(phone).first())) return fail('الرقم الجديد مسجل لعميل آخر', 409);
    const changes = [];
    if (name !== c.name) changes.push('الاسم: ' + c.name + ' ← ' + name);
    if (phone !== c.phone) changes.push('الجوال: ' + maskPhone(c.phone) + ' ← ' + maskPhone(phone));
    if (cups !== c.cups) changes.push('الأكواب: ' + c.cups + ' ← ' + cups);
    if (points !== c.points) changes.push('النقاط: ' + c.points + ' ← ' + points);
    if (!changes.length) return fail('لا يوجد تغيير');
    await env.DB.prepare('UPDATE customers SET name = ?, phone = ?, cups = ?, points = ? WHERE id = ?').bind(name, phone, cups, points, c.id).run();
    await logTx(env, { id: c.id, cups }, s, 'adjust', { points_delta: points - c.points, note: reason + ' | ' + changes.join('، ') }).run();
    syncWallet(env, ctx, { ...c, name, phone, cups, points }, cfg, url.origin);
    return json({ ok: true });
  }

  if (path === '/api/admin/stats' && method === 'GET') {
    const bp = url.searchParams.get('branch');
    const branch = bp ? Number(bp) : null;
    const today = dayStart(Date.now());
    const F = '(?1 IS NULL OR t.branch_id = ?1)';
    const q = (sql, ...b) => env.DB.prepare(sql).bind(branch, ...b);
    const [cust, visits, stamps, redeems, top, recent, branches, staff] = await Promise.all([
      q("SELECT COUNT(DISTINCT t.customer_id) AS n FROM transactions t WHERE t.type != 'redeem_failed' AND " + F).first(),
      q("SELECT COUNT(*) AS n FROM transactions t WHERE t.type IN ('stamp','visit') AND " + LIVE + " AND t.created_at >= ?2 AND " + F, today).first(),
      q("SELECT COUNT(*) AS n FROM transactions t WHERE t.type = 'stamp' AND " + LIVE + " AND t.created_at >= ?2 AND " + F, today).first(),
      q("SELECT COUNT(*) AS n FROM transactions t WHERE t.type = 'redeem' AND t.created_at >= ?2 AND " + F, today).first(),
      q("SELECT c.name, c.phone, COUNT(*) AS visits, ROUND(SUM(t.amount),2) AS spent, c.cups, c.points FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE t.type IN ('stamp','visit') AND " + LIVE + " AND " + F + ' GROUP BY c.id ORDER BY visits DESC, spent DESC LIMIT 10').all(),
      q('SELECT t.type, t.amount, t.points_delta, t.staff_name, t.branch_name, t.note, t.created_at, c.name AS customer FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE t.type != \'import\' AND ' + F + ' ORDER BY t.id DESC LIMIT 30').all(),
      env.DB.prepare('SELECT id, name FROM branches ORDER BY id').all(),
      env.DB.prepare('SELECT s.id, s.name, s.active, b.name AS branch_name FROM staff s JOIN branches b ON b.id = s.branch_id ORDER BY s.id').all(),
    ]);
    const cfg = await getSettings(env);
    return json({
      customers: cust.n, visits_today: visits.n, stamps_today: stamps.n, redeems_today: redeems.n,
      top: top.results.map((r) => ({ ...r, phone: maskPhone(r.phone) })),
      recent: recent.results, branches: branches.results, staff: staff.results,
      settings: Object.fromEntries(EDITABLE.map((k) => [k, cfg.raw[k]])),
    });
  }

  if (path === '/api/admin/staff' && method === 'POST') {
    const name = String(body.name || '').trim().slice(0, 40), pin = String(body.pin || '');
    if (name.length < 2 || name.toLowerCase() === 'admin') return fail('اسم غير صالح');
    if (!/^\d{4,8}$/.test(pin)) return fail('الرقم السري 4 إلى 8 أرقام');
    if (!(await env.DB.prepare('SELECT 1 FROM branches WHERE id = ?').bind(Number(body.branch_id)).first())) return fail('فرع غير صحيح');
    if (await env.DB.prepare('SELECT 1 FROM staff WHERE name = ?').bind(name).first()) return fail('الاسم مستخدم', 409);
    await env.DB.prepare('INSERT INTO staff (name, pin_hash, branch_id, created_at) VALUES (?,?,?,?)').bind(name, await hashPin(pin), Number(body.branch_id), Date.now()).run();
    return json({ ok: true });
  }
  if (path === '/api/admin/staff/toggle' && method === 'POST') {
    await env.DB.prepare('UPDATE staff SET active = 1 - active WHERE id = ?').bind(Number(body.id)).run();
    return json({ ok: true });
  }
  if (path === '/api/admin/settings' && method === 'POST') {
    const { key } = body, value = String(body.value ?? '');
    if (!EDITABLE.includes(key)) return fail('إعداد غير مسموح');
    if (key === 'points_redemption') { try { JSON.parse(value); } catch { return fail('JSON غير صحيح'); } }
    else if (!key.startsWith('wallet_') && !(Number(value) >= 0)) return fail('قيمة غير صحيحة');
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
    return json({ ok: true });
  }
  return fail('غير موجود', 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url, ctx);
      if (url.pathname === '/wallet/logo.png') return pngResponse(WALLET_IMG.logo);
      const hero = url.pathname.match(/^\/wallet\/hero\/([0-5])\.png$/);
      if (hero) return pngResponse(WALLET_IMG.hero[Number(hero[1])]);
      const gw = url.pathname.match(/^\/wallet\/google\/(LAS-[A-Za-z0-9]+)$/);
      if (gw) {
        if (!walletReady(env)) return new Response('Google Wallet is not configured', { status: 404 });
        const c = await env.DB.prepare('SELECT * FROM customers WHERE card_code = ?').bind(gw[1].toUpperCase()).first();
        if (!c) return new Response('Card not found', { status: 404 });
        return Response.redirect(await walletSaveUrl(env, c, await getSettings(env), url.origin), 302);
      }
      if (url.pathname === '/' ) return Response.redirect(url.origin + '/card', 302);
      if (url.pathname === '/card' || url.pathname.startsWith('/c/')) return html(customerPage());
      if (url.pathname === '/staff') return html(staffPage());
      if (url.pathname === '/admin') return html(adminPage());
      if (url.pathname === '/guide') return html(guidePage());
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return fail('خطأ في الخادم: ' + e.message, 500);
    }
  },
};

// ---------- pages ----------
const LOGO = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 863" role="img" aria-label="LAS CAFE" fill="currentColor"><path fill-rule="evenodd" d="M 1015 26.6 C 963.0 30.3, 924.6 46.6, 891.6 78.8 C 843.9 125.3, 850.2 205.2, 904.5 241.1 C 925.0 254.7, 924.9 254.7, 1023 285.0 C 1029.8 287.1, 1043.4 291.1, 1053.0 293.9 C 1077.5 300.9, 1086.7 304.2, 1100.1 311.1 C 1144.0 333.7, 1164.6 373.0, 1157.5 420.7 C 1147.7 487.3, 1108.3 512.8, 1018.6 510.7 C 971.6 509.5, 936.0 498.9, 900.9 475.4 C 884.5 464.5, 862.5 444.9, 858.1 437.5 C 857.0 435.6, 856.2 436.3, 846.5 446.5 C 840.7 452.5, 836.0 458.0, 836.0 458.6 C 835.9 460.6, 858.0 480.9, 870.6 490.3 C 906.2 517.1, 944.0 532.5, 990.5 539.1 C 1002.5 540.9, 1047.1 540.9, 1061.5 539.1 C 1110.0 533.3, 1150.3 516.9, 1181 490.7 C 1238.2 441.7, 1233.2 347.0, 1171.2 305.7 C 1145.5 288.5, 1114.4 277.0, 1045 258.9 C 1000.3 247.3, 984.2 240.1, 962.8 222.3 C 937.2 201.0, 926.7 179.6, 926.7 148.5 C 926.6 107.5, 948.0 77.2, 986.0 64.6 C 1041.4 46.1, 1107.5 59.4, 1162 99.8 L 1171.5 106.9 1175.2 102.7 C 1177.3 100.4, 1181.7 95.2, 1185.0 91.2 L 1191.0 84.0 1185.7 79.8 C 1139.5 42.9, 1073.7 22.4, 1015 26.6 M 506.6 36.2 C 505.2 37.4, 493.0 60.5, 479.4 87.5 C 465.8 114.4, 446.3 153.1, 435.9 173.5 C 398.3 247.8, 318 407.7, 318 408.3 C 318 408.7, 398.6 409.0, 497.2 409.0 C 670.1 409.0, 676.6 409.0, 679.5 410.8 C 682.5 412.7, 716.5 478.1, 728.5 505 C 734.5 518.6, 738.2 524.3, 743.7 528.5 C 750.6 533.8, 752.5 534.0, 784.4 533.2 L 813.2 532.5 799.2 505 C 791.5 489.8, 767.3 441.9, 745.5 398.5 C 723.6 355.0, 695.2 298.8, 682.4 273.5 C 669.7 248.2, 646.7 202.7, 631.4 172.5 C 616.2 142.2, 594.7 99.7, 583.7 78 C 572.8 56.2, 562.7 37.4, 561.3 36.2 C 558.9 34.0, 558.4 34, 534 34 C 509.5 34, 509.0 34.0, 506.6 36.2 M 58 284 L 58 533 234.0 533 C 351.9 533, 410.7 532.6, 412.0 531.9 C 413.0 531.4, 417.0 524.8, 420.7 517.4 L 427.6 504 277.3 504 L 127 504 127 269.5 L 127 35 92.5 35 L 58 35 58 284 M 440.1 230.7 C 398.7 313.6, 364.9 381.8, 364.9 382.2 C 364.9 382.6, 432.7 383, 515.5 383 L 666.1 383 665.4 380.8 C 664.6 378.3, 516.2 80, 515.8 80 C 515.6 80, 481.6 147.8, 440.1 230.7 M 370.2 633.9 C 332.5 639.3, 300.4 667.5, 290.8 704 C 287.6 716.1, 287.6 736.8, 290.7 749.3 C 299.1 782.3, 323.3 807.5, 356.5 817.6 C 364.7 820.1, 366.9 820.3, 382.5 820.4 C 401.6 820.5, 407.8 819.3, 420.9 813.3 C 434.9 806.9, 436.1 805.1, 431.1 799.2 L 429.2 797.0 419.7 801.5 C 374.1 823.1, 327.7 803.8, 315.0 758.0 C 308.4 734.2, 310.6 702.7, 320.3 682.5 C 331.7 658.6, 353.6 644.9, 380.4 645.0 C 389.6 645.0, 417.5 650.7, 426.1 654.4 C 427.2 654.9, 428.4 654.1, 430.0 651.9 L 432.3 648.7 429.9 646.6 C 418.9 637.6, 389.3 631.3, 370.2 633.9 M 551.4 637.4 C 548.0 639.2, 548.8 637.6, 515.4 704.1 L 495.0 744.8 487.7 741.5 C 452.8 725.4, 411.6 728.0, 383.7 747.9 C 377.1 752.7, 377.1 752.8, 380.5 756.0 C 383.0 758.3, 383.1 758.3, 385.7 756.6 C 415.5 737.6, 450.6 734.9, 482.2 749.3 C 486.5 751.3, 490 753.3, 490 753.8 C 490 754.3, 483.0 768.6, 474.5 785.6 C 465.9 802.6, 459.0 816.7, 459.0 817.1 C 458.9 818.3, 465.4 818.7, 468.2 817.7 C 470.5 816.9, 472.8 813.1, 483.1 792.6 C 493.3 772.1, 498.1 763.0, 499.6 761.1 C 499.8 760.8, 503.2 762.9, 507.2 765.7 C 537.2 786.4, 570.0 791.3, 605.2 780.3 C 610.0 778.8, 614.1 777.8, 614.3 778.0 C 614.5 778.3, 619.1 786.8, 624.4 797.1 C 631.2 810.1, 634.8 816.1, 636.6 817.0 C 639.2 818.4, 658.2 819.1, 659.4 817.8 C 660.8 816.5, 571.7 640.9, 568.5 638.7 C 564.7 635.9, 555.6 635.3, 551.4 637.4 M 681.2 636.7 L 678.9 637.1 679.2 727.3 L 679.5 817.5 691.7 817.7 L 704 818.0 704 767.0 L 704 716 745.5 716 L 787.1 716 786.8 710.7 L 786.5 705.5 745.2 705.2 L 704 704.9 704 675.9 L 704 647 755 647 L 806 647 805.9 643.7 C 805.9 635.7, 807.8 635.9, 741.8 636.1 C 709.7 636.2, 682.4 636.4, 681.2 636.7 M 838 727 L 838 818 903.9 818 L 969.9 818 970.9 814.2 C 973.1 806.2, 978.5 807, 917.5 807 L 863 807 863 761.5 L 863 716 913.5 716 L 964.1 716 963.8 710.7 L 963.5 705.5 913.2 705.2 L 863 704.9 863 675.9 L 863 647 915 647 L 967 647 967 643.5 C 967 641.0, 966.2 639.5, 964.3 638.0 C 961.7 636.0, 960.9 636, 899.8 636 L 838 636 838 727 M 528.6 701.7 C 515.6 728.0, 504.9 749.9, 504.9 750.5 C 505.1 755.7, 529.1 769.6, 546 774.1 C 557.3 777.1, 583.0 777.5, 592.5 774.6 C 600.9 772.1, 609 768.9, 609 767.9 C 609 767.0, 553.2 654, 552.7 654 C 552.5 654, 541.7 675.4, 528.6 701.7"/></svg>`;

const CSS = String.raw`
:root{--teal:#3d4864;--teal2:#4a5778;--sand:#f8f4ec;--copper:#a58670;--ink:#232b3d;--mut:#6f7686;--line:#e6dfd3;--ok:#1b7f4b;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--sand);color:var(--ink);font-family:"IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif;line-height:1.5}
.wrap{max-width:460px;margin:0 auto;padding:16px}.wide{max-width:1000px}
header.top{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--teal);color:#fff}
header.top svg{width:48px;height:32px}header.top b{flex:1}
header.top button{background:transparent;border:1px solid #fff6;color:#fff;border-radius:8px;padding:4px 10px;font:inherit;cursor:pointer}
h2{font-size:1.05rem;margin:0 0 10px}
.box{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
label{display:block;font-size:.85rem;color:var(--mut);margin:8px 0 3px}
input,select{width:100%;padding:11px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff}
input.num,.ltr{direction:ltr;text-align:left}
button.pri{width:100%;margin-top:10px;padding:12px;border:0;border-radius:10px;background:var(--teal);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.pri:disabled{opacity:.5}button.alt{background:var(--copper)}
.msg{padding:10px;border-radius:10px;margin:10px 0;font-size:.95rem}.msg.ok{background:#e6f4ec;color:var(--ok)}.msg.err{background:#fbe9e7;color:var(--bad)}
.hide{display:none}
.card{--bg:#3d4864;--fg:#f8f4ec;--mo:#a58670;background:var(--bg);color:var(--fg);border-radius:20px;padding:16px 18px;box-shadow:0 8px 24px #3d486433;transition:background .6s,color .6s}
.card.done{--bg:#f8f4ec;--fg:#3d4864;border:1px solid var(--mo)}
.card .hd{display:flex;align-items:center;justify-content:space-between}.card .hd svg{width:60px;height:40px}.card .hd small{color:var(--mo)}
.card .mid{display:flex;align-items:center;gap:6px;margin:4px 0}.card .mid svg.v60{width:178px;height:176px;flex:none;overflow:visible}
.card .info{flex:1;text-align:center}.card .big{font-size:2.8rem;font-weight:600;line-height:1}.card .big span{font-size:1.2rem;color:var(--mo)}
.card .lbl{color:var(--mo);font-size:.8rem}.card .left{font-size:.95rem;margin-top:10px;line-height:1.6}
.card .band{background:var(--mo);color:#f8f4ec;border-radius:10px;padding:8px;font-weight:600;margin-top:8px}
.card .row{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;border-top:1px solid #a5867066;padding-top:10px}
.card .nm{font-size:1.1rem;font-weight:600}.card .pts b{font-size:1.1rem}
.card .qr{background:#f8f4ec;border-radius:10px;padding:6px;width:84px;flex:none;margin:0}.card.done .qr{background:#fff;border:1px solid var(--mo)}
.card .qr small{font-size:9px;color:#3d4864}
.v60 .wave{animation:wv 3s linear infinite}.v60 .lvl{transition:transform 1.6s cubic-bezier(.3,1.2,.4,1)}
.v60 .drop{animation:dp 1.8s ease-in infinite;opacity:0}.v60 .drop.d2{animation-delay:.9s}
.v60 .steam{animation:st 3s ease-in-out infinite;opacity:0}.v60 .steam.s2{animation-delay:1s}.v60 .steam.s3{animation-delay:2s}
@keyframes wv{to{transform:translateX(-48px)}}
@keyframes dp{0%{transform:translateY(0);opacity:0}15%{opacity:1}85%{opacity:1}100%{transform:translateY(var(--fall,40px));opacity:0}}
@keyframes st{0%{transform:translateY(0);opacity:0}30%{opacity:.8}100%{transform:translateY(-16px);opacity:0}}
@media (prefers-reduced-motion:reduce){.v60 *{animation:none!important;transition:none!important}.v60 .steam{opacity:.7}}
.cups{display:flex;gap:6px;justify-content:center;margin:14px 0;flex-wrap:wrap}
.cup{width:52px;height:52px;border-radius:50%;background:#ffffff1f;display:flex;align-items:center;justify-content:center}
.cup{color:#ffffffaa}.box .cup{background:#eef2f3;color:#9aa8ad}.box .cup.on{background:var(--copper);color:#fff}.cup svg{width:30px;height:30px}.cup.on{background:var(--copper)}.cup.gift{background:#fff;border:2px dashed var(--copper)}
.qr{text-align:center}.qr svg{width:100%;height:auto;display:block}.qr small{font-family:monospace;display:block;margin-top:2px}
.who{display:flex;justify-content:space-between;align-items:center}.who b{font-size:1.15rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px}.stat b{font-size:1.6rem;display:block;color:var(--teal)}
table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{padding:7px 6px;text-align:start;border-bottom:1px solid var(--line)}.scroll{overflow-x:auto}
.tag{padding:2px 8px;border-radius:99px;background:#eef2f3;font-size:.78rem}
`;

const CUP_JS = String.raw`
function cupSvg(c){return '<svg viewBox="0 0 24 24" fill="none" stroke="'+c+'" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c0 1.5 1.5 1.5 1.5 3M12 3c0 1.5 1.5 1.5 1.5 3"/></svg>'}
function giftSvg(){return '<svg viewBox="0 0 24 24" fill="none" stroke="#c68e65" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M12 8c-2-4-6-3-5 0M12 8c2-4 6-3 5 0"/></svg>'}
function cupsHtml(n,total){var h='';for(var i=0;i<total;i++)h+='<div class="cup'+(i<n?' on':'')+'">'+cupSvg(i<n?'#fff':'currentColor')+'</div>';return h+'<div class="cup gift">'+giftSvg()+'</div>'}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function $(id){return document.getElementById(id)}
async function call(path,opts){var r=await fetch(path,opts);var d=await r.json().catch(function(){return{error:'خطأ'}});if(!r.ok){var e=new Error(d.error||'خطأ');e.status=r.status;throw e}return d}
function post(path,data){return call(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})}
function qrSvg(text){try{var q=qrcode(0,'M');q.addData(text);q.make();return q.createSvgTag({cellSize:4,margin:0,scalable:true})}catch(e){return ''}}
`;

const head = (title) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap" rel="stylesheet"><style>${CSS}</style></head><body>`;
const QR_LIB = '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>';

function customerPage() {
  return head('بطاقة ولاء لاس') + `<div class="wrap">
<div id="lookup" class="box"><h2>تحقق من بطاقتك</h2><label>رقم الجوال</label><input id="ph" class="num" inputmode="tel" placeholder="05XXXXXXXX" autocomplete="tel"><button class="pri" id="go">عرض البطاقة</button><div id="err" class="msg err hide"></div></div>
<div id="reg" class="box hide"><h2>لا توجد بطاقة لهذا الرقم</h2><p style="margin:0 0 6px;color:var(--mut)">أنشئ بطاقتك الآن، نحتاج اسمك فقط.</p><label>الاسم</label><input id="nm" autocomplete="name"><button class="pri" id="mk">إنشاء بطاقتي</button><div id="rerr" class="msg err hide"></div><p style="text-align:center;margin:10px 0 0"><a href="/card">رجوع</a></p></div>
<div id="out"></div></div>${QR_LIB}<script>${CUP_JS}
var LOGO_SVG=${JSON.stringify(LOGO)};
function v60(f,done,total){
 var body='M40 78H128V136a28 28 0 0 1-28 28H68a28 28 0 0 1-28-28Z',surf=82+(1-f)*86,fall=Math.max(0,Math.round(surf-92));
 var s='<svg class="v60" viewBox="0 0 178 176" role="img" aria-label="'+Math.round(f*total)+' / '+total+'" style="--fall:'+fall+'px"><defs><clipPath id="cl"><path d="'+body+'"/></clipPath></defs>';
 s+='<path d="'+body+'" fill="#a5867014" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M128 92h8a16 16 0 0 1 0 38h-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
 s+='<g clip-path="url(#cl)"><g class="lvl" style="transform:translateY(86px)"><rect x="30" y="85" width="110" height="90" fill="#a58670"/><path class="wave" d="M-24 82q12-5 24 0t24 0t24 0t24 0t24 0t24 0t24 0t24 0t24 0t24 0V92H-24Z" fill="#a58670"/></g></g>';
 s+=LOGO_SVG.replace('<svg ','<svg x="62" y="122" width="44" height="30" opacity=".9" ');
 for(var i=1;i<=total;i++){var y=164-i*(82/total);s+='<line x1="40" y1="'+y+'" x2="47" y2="'+y+'" stroke="currentColor" stroke-opacity=".7"/><text x="32" y="'+(y+4)+'" text-anchor="end" font-size="11" fill="#a58670">'+i+'</text>'}
 s+='<path d="M34 18H134L102 70V84H66V70Z" fill="#a5867033" stroke="#a58670" stroke-width="2" stroke-linejoin="round"/>';
 [[54,73],[74,80],[94,88],[114,95]].forEach(function(p){s+='<line x1="'+p[0]+'" y1="22" x2="'+p[1]+'" y2="68" stroke="#a58670" stroke-opacity=".6"/>'});
 s+='<rect x="28" y="13" width="112" height="7" rx="3.5" fill="#a58670"/>';
 if(!done)s+='<circle class="drop" cx="84" cy="88" r="2.8" fill="#a58670"/><circle class="drop d2" cx="84" cy="88" r="2.8" fill="#a58670"/>';
 else s+='<g fill="none" stroke="#a58670" stroke-width="2" stroke-linecap="round"><path class="steam" d="M70 10q-5-5 0-10t0-9"/><path class="steam s2" d="M84 10q-5-5 0-10t0-9"/><path class="steam s3" d="M98 10q-5-5 0-10t0-9"/></g>';
 return s+'</svg>'}
function remember(v){try{if(v)localStorage.setItem('las_card',v);else localStorage.removeItem('las_card')}catch(e){}}
function recall(){try{return localStorage.getItem('las_card')}catch(e){return null}}
function leftText(n){return 'باقي لك '+(n===1?'كوب واحد':n===2?'كوبين':n+' أكواب')+' للحصول على مشروب مجاني'}
function show(c){
 remember(c.card_code);
 $('lookup').classList.add('hide');
 var f=Math.min(1,c.cups/c.cups_per_reward),done=c.free_drinks>0;
 var h='<div class="card'+(done?' done':'')+'"><div class="hd">'+LOGO_SVG+'<small>بطاقة الولاء</small></div>'
 +'<div class="mid">'+v60(f,done,c.cups_per_reward)+'<div class="info"><div class="big">'+c.cups+'<span> / '+c.cups_per_reward+'</span></div>'
 +(done?'<div class="band">مشروبك القادم علينا</div>':'<div class="left">'+leftText(c.cups_per_reward-c.cups)+'</div>')+'</div></div>'
 +'<div class="row"><div><div class="lbl">الاسم</div><div class="nm">'+esc(c.name)+'</div><div class="lbl" style="margin-top:6px">النقاط <b style="color:var(--fg);font-size:1.1rem">'+c.points+'</b></div></div>'
 +'<div class="qr">'+qrSvg(c.card_code)+'<small>'+esc(c.card_code)+'</small></div></div></div>';
 setTimeout(function(){var l=document.querySelector('.v60 .lvl');if(l)l.style.transform='translateY('+((1-f)*86)+'px)'},150);
 var w='';if(c.wallet_apple_url)w+='<a class="pri" style="display:block;text-align:center;text-decoration:none;margin-top:10px;padding:12px;border-radius:10px;background:#000;color:#fff" href="'+esc(c.wallet_apple_url)+'">إضافة إلى Apple Wallet</a>';
 var gurl=c.google_wallet?'/wallet/google/'+c.card_code:c.wallet_google_url;
 if(gurl)w+='<a class="pri" style="display:block;text-align:center;text-decoration:none;margin-top:10px;padding:12px;border-radius:10px;background:#1a73e8;color:#fff" href="'+esc(gurl)+'">إضافة إلى Google Wallet</a>';
 $('out').innerHTML=h+w+'<p style="text-align:center"><a href="/card" id="other">بحث برقم آخر</a></p>';
 $('other').onclick=function(){remember(null)};
}
async function find(q){try{show(await call('/api/public/card?'+q))}catch(e){
 if(e.status===404&&q.indexOf('phone=')===0){$('lookup').classList.add('hide');$('reg').classList.remove('hide');$('nm').focus();return}
 $('err').textContent=e.message;$('err').classList.remove('hide');$('lookup').classList.remove('hide')}}
$('mk').onclick=async function(){$('mk').disabled=true;try{var r=await post('/api/public/register',{name:$('nm').value,phone:$('ph').value});$('reg').classList.add('hide');show(r)}catch(e){$('rerr').textContent=e.message;$('rerr').classList.remove('hide');$('mk').disabled=false}};
$('nm').onkeydown=function(e){if(e.key==='Enter')$('mk').click()};
$('go').onclick=function(){find('phone='+encodeURIComponent($('ph').value))};
$('ph').onkeydown=function(e){if(e.key==='Enter')$('go').click()};
if(location.pathname.indexOf('/c/')===0){$('lookup').classList.add('hide');find('code='+encodeURIComponent(location.pathname.slice(3)))}
else if(recall()){$('lookup').classList.add('hide');find('code='+encodeURIComponent(recall()))}
</script></body></html>`;
}

function staffPage() {
  return head('الكاشير · لاس') + `<style>.big{font-size:1.5rem;padding:14px}#q{font-size:1.7rem;letter-spacing:1px}.done{background:var(--ok);color:#fff;border-radius:14px;padding:18px;text-align:center;margin-bottom:12px}.done b{display:block;font-size:1.6rem}.done span{display:block;font-size:1.1rem;margin-top:4px}.done.gold{background:var(--copper)}.done.hide{display:none}.pv{color:var(--mut);margin:6px 0 0;min-height:1.5em}</style>
<header class="top">${LOGO}<b id="who">الكاشير</b><button id="out" class="hide">خروج</button></header><div class="wrap">
<div id="login" class="box hide"><h2>تسجيل دخول الموظف</h2><label>اسم الموظف</label><input id="u" autocomplete="username"><label>الرقم السري</label><input id="p" type="password" class="num" inputmode="numeric" autocomplete="current-password"><button class="pri" id="lg">دخول</button><div id="lerr" class="msg err hide"></div></div>
<div id="app" class="hide">
 <div id="done" class="done hide" role="status"></div>
 <div class="box"><label style="margin-top:0">جوال العميل (أو امسح بطاقته)</label><input id="q" class="num" inputmode="numeric" placeholder="05XXXXXXXX" autocomplete="off"><button class="pri alt big" id="scan">📷 مسح بطاقة العميل</button>
 <div id="cam" class="hide"><video id="vid" playsinline muted style="width:100%;border-radius:12px;margin-top:10px;background:#000"></video><div style="display:flex;gap:8px"><button class="pri" id="flip">تبديل الكاميرا</button><button class="pri" id="stop">إلغاء</button></div></div></div>
 <div id="msg" class="msg hide" role="alert"></div>
 <div id="reg" class="box hide"><h2>عميل جديد</h2><label>الاسم</label><input id="rn" class="big" autocomplete="off"><label>مبلغ الفاتورة (ريال)</label><input id="ra" class="num big" inputmode="decimal" autocomplete="off"><button class="pri alt big" id="rg">سجّل وأضف الختم</button></div>
 <div id="cust" class="box hide"></div>
 <div class="box"><h2>آخر عملياتك</h2><div id="recent" class="pv">لا يوجد بعد</div><p style="text-align:center;margin:8px 0 0"><a href="/guide" target="_blank">دليل الكاشير</a></p></div>
</div></div><script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"></script><script>${CUP_JS}
var cur=null,busy=false,seq=0,pending=false,newPhone='';
function msg(t,ok){var m=$('msg');m.textContent=t||'';m.className='msg '+(ok?'ok':'err')+(t?'':' hide')}
function digits(s){s=String(s).trim();if(/^las-/i.test(s))return s.toUpperCase();return s.replace(/[٠-٩]/g,function(c){return c.charCodeAt(0)-1632}).replace(/[\\s-]/g,'')}
function amt(s){return digits(s).replace(/[٫,]/g,'.')}
function complete(s){return /^(05\\d{8}|5\\d{8}|(\\+|00)?9665\\d{8}|LAS-[A-Z0-9]{8})$/i.test(s)}
function clearPanels(){cur=null;$('cust').classList.add('hide');$('cust').innerHTML='';$('reg').classList.add('hide')}
function banner(title,sub,gold){var d=$('done');d.innerHTML='<b>'+esc(title)+'</b><span>'+esc(sub)+'</span>';d.className='done'+(gold?' gold':'')}
function hideBanner(){$('done').className='done hide'}
function next(){seq++;clearPanels();$('q').value='';$('q').focus()}
function bigOk(a){return Number(a)<=500||confirm('المبلغ '+a+' ريال، هل هو صحيح؟')}
async function boot(){try{var me=await call('/api/me');if(me.role!=='cashier'){location.href='/admin';return}
 $('who').textContent=me.name+' · فرع '+me.branch_name;$('out').classList.remove('hide');$('app').classList.remove('hide');$('login').classList.add('hide');$('q').focus();loadRecent()}
 catch(e){$('app').classList.add('hide');$('out').classList.add('hide');$('login').classList.remove('hide')}}
function fail(e){if(e.status===401){boot();return}msg(e.message)}
async function lookup(){var s=digits($('q').value);if(!s)return;var my=++seq;clearPanels();pending=true;
 try{var c=await call('/api/customer?q='+encodeURIComponent(s));if(my===seq)render(c)}
 catch(e){if(my!==seq)return;if(e.status!==404)fail(e);else if(/^las-/i.test(s))msg('رمز البطاقة غير معروف');else if(complete(s)){newPhone=s;$('rn').value='';$('ra').value='';$('reg').classList.remove('hide');$('rn').focus()}else msg('رقم الجوال غير صحيح')}
 finally{if(my===seq)pending=false}}
function render(c){cur=c;
 var h='<div class="who"><b>'+esc(c.name)+'</b><span class="tag ltr">'+esc(c.phone)+'</span></div><div class="cups">'+cupsHtml(c.cups,c.cups_per_reward)+'</div>'
 +'<p style="margin:0 0 8px">الأختام <b>'+c.cups+' / '+c.cups_per_reward+'</b> · النقاط <b>'+c.points+'</b></p>';
 if(c.name==='عميل')h+='<div class="msg err">العميل بدون اسم، اسأله عن اسمه</div><input id="nn" placeholder="اسم العميل" autocomplete="off"><button class="pri alt" id="sn">حفظ الاسم</button>';
 if(c.free_drinks)h+='<div class="msg ok">🎉 المشروب التالي مجاني</div><label>آخر 4 أرقام من جوال العميل</label><input id="l4" class="num big" inputmode="numeric" maxlength="4" autocomplete="off"><button class="pri alt big" id="rd">استبدال المشروب المجاني</button>';
 else h+='<label>مبلغ الفاتورة (ريال)</label><input id="am" class="num big" inputmode="decimal" autocomplete="off"><p class="pv" id="pv"></p><button class="pri big" id="st">إضافة ختم</button>';
 $('cust').innerHTML=h;$('cust').classList.remove('hide');$('reg').classList.add('hide');
 if($('sn')){$('sn').onclick=saveName;$('nn').onkeydown=function(e){if(e.key==='Enter')saveName()}}
 if($('st')){$('st').onclick=stamp;$('am').onkeydown=function(e){if(e.key==='Enter')stamp()};$('am').oninput=preview;$('am').focus()}
 if($('rd')){$('rd').onclick=redeem;$('l4').onkeydown=function(e){if(e.key==='Enter')redeem()};$('l4').focus()}}
function preview(){var a=Number(amt($('am').value));$('pv').textContent=!(a>0)?'':a<cur.min_amount?'أقل من '+cur.min_amount+' ريال: لا ختم ولا نقاط':'+'+Math.floor(a*cur.points_per_riyal)+' نقطة وختم واحد'}
async function saveName(){if(busy||!cur)return;busy=true;try{var c=await post('/api/set-name',{phone:cur.card_code,name:$('nn').value});c.stamped_minutes_ago=cur.stamped_minutes_ago;c.min_amount=cur.min_amount;c.points_per_riyal=cur.points_per_riyal;render(c);msg('تم حفظ الاسم ✔',true)}catch(e){fail(e)}busy=false}
var OPS={stamp:'ختم',redeem:'مشروب مجاني',register:'تسجيل'};
async function loadRecent(){try{var d=await call('/api/recent');
 $('recent').innerHTML=d.items.length?d.items.map(function(t){
  var time=new Date(t.created_at).toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});
  return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);color:var(--ink)'+(t.undone?';text-decoration:line-through;opacity:.5':'')+'"><span>'+esc(time)+' · '+esc(t.customer)+' (…'+esc(t.last4)+') · '+OPS[t.type]+(t.amount?' · '+t.amount+' ريال':'')+'</span>'
   +(t.undoable?'<button class="pri alt un" data-id="'+t.id+'" data-who="'+esc(t.customer)+'" data-am="'+t.amount+'" style="width:auto;margin:0;padding:6px 12px">تراجع</button>':'')+'</div>'}).join(''):'لا يوجد بعد';
 document.querySelectorAll('.un').forEach(function(b){b.onclick=function(){undo(b)}})}catch(e){if(e.status===401)boot()}}
async function undo(b){if(busy||!confirm('التراجع عن ختم '+b.dataset.who+' بمبلغ '+b.dataset.am+' ريال؟'))return;busy=true;hideBanner();
 try{var r=await post('/api/undo',{id:b.dataset.id});banner('تم التراجع',r.card.name+' · الأختام '+r.card.cups+' / '+r.card.cups_per_reward+' · النقاط '+r.card.points,true);next();msg('')}catch(e){fail(e)}busy=false;loadRecent()}
function stamped(before,r){if(!r.stamped){msg(r.message);return false}
 banner(r.card.name+' ✔','الأختام '+r.card.cups+' / '+r.card.cups_per_reward+' · +'+(r.card.points-before)+' نقطة'+(r.reward_earned?' · المشروب القادم مجاني 🎉':''),r.reward_earned);next();msg('');loadRecent();return true}
async function stamp(){if(busy||!cur)return;var a=amt($('am').value),c=cur;if(!(Number(a)>0)){msg('أدخل مبلغ الفاتورة');return}if(!bigOk(a))return;
 if(c.stamped_minutes_ago&&!confirm('هذا العميل أخذ ختم قبل '+c.stamped_minutes_ago+' دقيقة. هل هذه فاتورة جديدة؟'))return;
 busy=true;$('st').disabled=true;try{stamped(c.points,await post('/api/stamp',{phone:c.card_code,amount:a}))}catch(e){fail(e)}busy=false;if($('st'))$('st').disabled=false}
async function redeem(){if(busy||!cur)return;busy=true;try{var r=await post('/api/redeem',{phone:cur.card_code,last4:digits($('l4').value)});banner(r.card.name+' ✔','تم المشروب المجاني، البطاقة بدأت من جديد',true);next();msg('');loadRecent()}catch(e){fail(e)}busy=false}
async function register(){if(busy)return;var name=$('rn').value.trim(),a=amt($('ra').value),phone=newPhone;
 if(name.length<2){msg('اكتب اسم العميل');$('rn').focus();return}if(a&&!(Number(a)>0)){msg('المبلغ غير صحيح');return}if(a&&!bigOk(a))return;
 busy=true;$('rg').disabled=true;
 try{await post('/api/register',{name:name,phone:phone});
  try{if(!a){banner(name+' ✔','تم التسجيل');next();msg('');loadRecent()}else{var r=await post('/api/stamp',{phone:phone,amount:a});if(!stamped(0,r)){await lookup();msg('تم التسجيل. '+r.message)}}}
  catch(e){await lookup();msg('تم التسجيل لكن الختم لم يُضف: '+e.message)}}
 catch(e){fail(e)}busy=false;$('rg').disabled=false}
var stream=null,facing='environment',canvas=document.createElement('canvas'),lastScan=0;
function stopScan(){if(stream)stream.getTracks().forEach(function(t){t.stop()});stream=null;$('cam').classList.add('hide');$('scan').classList.remove('hide')}
async function startScan(){msg('');hideBanner();seq++;clearPanels();$('q').value='';
 if(typeof jsQR!=='function'||!navigator.mediaDevices){msg('المسح غير متاح، اكتب رقم الجوال');return}
 try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing},audio:false})}catch(e){msg('لم يُسمح باستخدام الكاميرا. اسمح بها من الإعدادات أو اكتب رقم الجوال');return}
 $('cam').classList.remove('hide');$('scan').classList.add('hide');var v=$('vid');v.srcObject=stream;await v.play().catch(function(){});requestAnimationFrame(tick)}
function tick(t){if(!stream)return;var v=$('vid');
 if(v.videoWidth&&t-lastScan>150){lastScan=t;var w=Math.min(640,v.videoWidth),h=Math.round(v.videoHeight*w/v.videoWidth);canvas.width=w;canvas.height=h;var x=canvas.getContext('2d',{willReadFrequently:true});x.drawImage(v,0,0,w,h);
  var r=jsQR(x.getImageData(0,0,w,h).data,w,h);
  if(r&&/^LAS-[A-Z0-9]{8}$/i.test(r.data.trim())){stopScan();$('q').value=r.data.trim().toUpperCase();if(navigator.vibrate)navigator.vibrate(80);lookup();return}}
 requestAnimationFrame(tick)}
$('scan').onclick=startScan;$('stop').onclick=function(){stopScan();$('q').focus()};
$('flip').onclick=function(){facing=facing==='environment'?'user':'environment';stopScan();startScan()};
document.addEventListener('visibilitychange',function(){if(document.hidden)stopScan()});
$('q').oninput=function(){if(stream)stopScan();msg('');seq++;pending=false;clearPanels();var s=digits($('q').value);if(s)hideBanner();if(complete(s))lookup()};
$('q').onkeydown=function(e){if(e.key!=='Enter')return;if(cur){var f=$('am')||$('l4');if(f)f.focus()}else if(!pending)lookup()};
$('rg').onclick=register;$('ra').onkeydown=function(e){if(e.key==='Enter')register()};$('rn').onkeydown=function(e){if(e.key==='Enter')$('ra').focus()};
$('lg').onclick=async function(){try{await post('/api/login',{username:$('u').value,pin:$('p').value});$('p').value='';$('lerr').classList.add('hide');boot()}catch(e){$('lerr').textContent=e.message;$('lerr').classList.remove('hide')}};
$('p').onkeydown=function(e){if(e.key==='Enter')$('lg').click()};
$('out').onclick=async function(){await post('/api/logout',{});location.reload()};
boot();
</script></body></html>`;
}

function guidePage() {
  return head('دليل الكاشير · لاس') + `<style>.g{max-width:720px;margin:auto;padding:16px}.g h1{font-size:1.4rem;margin:0 0 8px}.g h2{margin:14px 0 4px}.g ol,.g ul{margin:0;padding-inline-start:22px}.g table td,.g table th{border:1px solid #ccc;padding:5px 8px}@media print{body{background:#fff}.g{padding:0;font-size:12px}button{display:none}}</style>
<div class="g"><h1>دليل الكاشير: بطاقة ولاء لاس</h1><p>قل للعميل: <b>«عندك بطاقة لاس؟ عطني رقمك»</b></p>
<h2>إضافة ختم</h2><ol><li>اكتب رقم الجوال، أو اضغط «مسح بطاقة العميل».</li><li>تأكد من اسم العميل.</li><li>اكتب مبلغ الفاتورة واضغط «إضافة ختم».</li><li>انتظر المربع الأخضر.</li></ol>
<h2>عميل جديد</h2><ul><li>اكتب رقمه، ثم اسمه والمبلغ، واضغط «سجّل وأضف الختم».</li></ul>
<h2>المشروب المجاني</h2><ul><li>بعد 5 أختام يصير المشروب التالي مجاني.</li><li>اطلب <b>آخر 4 أرقام</b> من جواله، ثم «استبدال المشروب المجاني».</li></ul>
<h2>القواعد</h2><ul><li>فاتورة 10 ريال أو أكثر = كوب واحد، مهما كان عدد المشروبات.</li><li>كل ريال = نقطة.</li><li>أقل من 10 ريال: لا ختم ولا نقاط.</li><li><b>طلب واحد = إدخال واحد.</b> لا تقسّم الفاتورة.</li></ul>
<h2>إذا حصلت مشكلة</h2><table><tr><th>المشكلة</th><th>الحل</th></tr>
<tr><td>غلطت في الرقم أو المبلغ</td><td>«آخر عملياتك» ← «تراجع» خلال 5 دقائق</td></tr>
<tr><td>مضت 5 دقائق، أو غلط في المشروب المجاني</td><td>بلّغ المدير</td></tr>
<tr><td>العميل غيّر رقمه</td><td>بلّغ المدير</td></tr>
<tr><td>عميل بدون اسم</td><td>اسأله واكتب اسمه واضغط «حفظ الاسم»</td></tr>
<tr><td>ما فيه إنترنت</td><td>سجّل الرقم والمبلغ والوقت في ورقة، وأدخلها لاحقًا</td></tr></table>
<h2>أول الشفت وآخره</h2><ul><li>ادخل باسمك ورقمك السري، ولا تشاركه.</li><li>اضغط «خروج» إذا انتهى دوامك.</li></ul>
<p><button class="pri" onclick="print()">طباعة</button></p></div></body></html>`;
}

function adminPage() {
  return head('لوحة الإدارة · لاس') + `<header class="top">${LOGO}<b>لوحة الإدارة</b><button id="out" class="hide">خروج</button></header><div class="wrap wide">
<div id="login" class="box hide" style="max-width:420px;margin:auto"><h2>دخول المدير</h2><label>اسم المستخدم</label><input id="u" value="admin" class="ltr"><label>كلمة المرور</label><input id="p" type="password" class="num"><button class="pri" id="lg">دخول</button><div id="lerr" class="msg err hide"></div></div>
<div id="app" class="hide">
 <div class="box"><label style="margin:0 0 4px">الفرع</label><select id="br"></select></div>
 <div class="grid" id="stats"></div>
 <div class="box" style="margin-top:12px"><h2>أفضل العملاء</h2><div class="scroll"><table id="top"></table></div></div>
 <div class="box"><h2>تصحيح بيانات عميل</h2>
  <label>جوال العميل</label><div style="display:flex;gap:6px"><input id="cq" class="num" inputmode="numeric" placeholder="05XXXXXXXX"><button class="pri" id="cfind" style="width:auto;margin:0;padding:0 18px">بحث</button></div>
  <div id="cedit" class="hide"><label>الاسم</label><input id="en"><label>الجوال</label><input id="eph" class="num" inputmode="numeric"><label>الأكواب</label><input id="ecu" class="num" inputmode="numeric"><label>النقاط</label><input id="ept" class="num" inputmode="numeric"><label>سبب التعديل (إلزامي)</label><input id="ere" placeholder="مثال: ختم انضاف لرقم غلط"><button class="pri alt" id="esave">حفظ التعديل</button></div>
  <div id="cmsg" class="msg hide"></div></div>
 <div class="box"><h2>آخر النشاطات</h2><div class="scroll"><table id="rec"></table></div></div>
 <div class="box"><h2>الموظفون</h2><div class="scroll"><table id="stf"></table></div>
  <label>اسم موظف جديد</label><input id="sn"><label>الفرع</label><select id="sb"></select><label>الرقم السري (4-8 أرقام)</label><input id="sp" class="num" inputmode="numeric"><button class="pri" id="sa">إضافة موظف</button><div id="smsg" class="msg hide"></div></div>
 <div class="box"><h2>الإعدادات</h2><div id="set"></div></div>
 <div class="box"><h2>نسخة احتياطية (Excel / CSV)</h2><p style="margin:0"><a href="/api/admin/export?what=customers">تنزيل العملاء</a> · <a href="/api/admin/export?what=transactions">تنزيل السجل</a></p></div>
 <div class="box" style="text-align:center"><h2>QR الطاولة (صفحة البطاقة)</h2><div class="qr" style="width:170px;margin:auto;background:#fff;padding:10px;border:1px solid var(--line);border-radius:10px" id="tq"></div><small class="ltr" id="tu"></small></div>
</div></div>${QR_LIB}<script>${CUP_JS}
var LBL={undo:'تراجع',adjust:'تعديل مدير',name:'إضافة اسم',import:'من بونات',register:'تسجيل',stamp:'ختم',visit:'زيارة (بدون كوب)',redeem:'استبدال',redeem_failed:'محاولة استبدال فاشلة'};
function fmt(ms){return new Date(ms).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh',dateStyle:'short',timeStyle:'short'})}
var SL={min_amount:'الحد الأدنى للفاتورة (ريال)',points_per_riyal:'نقاط لكل ريال',stamp_cooldown_hours:'ساعات بين الأختام (0 = بدون حد)',points_redemption:'قاعدة استبدال النقاط (JSON)',wallet_apple_url:'رابط Apple Wallet',wallet_google_url:'رابط Google Wallet'};
async function load(){
 var b=$('br').value;var d;
 try{d=await call('/api/admin/stats'+(b?'?branch='+b:''))}catch(e){$('login').classList.remove('hide');$('app').classList.add('hide');return}
 $('login').classList.add('hide');$('app').classList.remove('hide');$('out').classList.remove('hide');
 if(!$('br').options.length){$('br').innerHTML='<option value="">كل الفروع</option>'+d.branches.map(function(x){return '<option value="'+x.id+'">'+esc(x.name)+'</option>'}).join('');$('br').value=b;$('sb').innerHTML=d.branches.map(function(x){return '<option value="'+x.id+'">'+esc(x.name)+'</option>'}).join('')}
 $('stats').innerHTML=[['إجمالي العملاء',d.customers],['زيارات اليوم',d.visits_today],['أختام اليوم',d.stamps_today],['استبدالات اليوم',d.redeems_today]].map(function(x){return '<div class="stat"><b>'+x[1]+'</b>'+x[0]+'</div>'}).join('');
 $('top').innerHTML='<tr><th>العميل</th><th>الجوال</th><th>الزيارات</th><th>الإنفاق</th><th>الأكواب</th><th>النقاط</th></tr>'+d.top.map(function(r){return '<tr><td>'+esc(r.name)+'</td><td class="ltr">'+esc(r.phone)+'</td><td>'+r.visits+'</td><td>'+(r.spent||0)+'</td><td>'+r.cups+'</td><td>'+r.points+'</td></tr>'}).join('');
 $('rec').innerHTML='<tr><th>الوقت</th><th>النوع</th><th>العميل</th><th>المبلغ</th><th>الموظف</th><th>الفرع</th><th>ملاحظة</th></tr>'+d.recent.map(function(r){return '<tr><td>'+fmt(r.created_at)+'</td><td><span class="tag">'+(LBL[r.type]||r.type)+'</span></td><td>'+esc(r.customer)+'</td><td>'+(r.amount==null?'':r.amount)+'</td><td>'+esc(r.staff_name)+'</td><td>'+esc(r.branch_name||'')+'</td><td>'+esc(r.note||'')+'</td></tr>'}).join('');
 $('stf').innerHTML='<tr><th>الموظف</th><th>الفرع</th><th>الحالة</th><th></th></tr>'+d.staff.map(function(s){return '<tr><td>'+esc(s.name)+'</td><td>'+esc(s.branch_name)+'</td><td>'+(s.active?'فعال':'موقوف')+'</td><td><a href="#" data-id="'+s.id+'" class="tg">'+(s.active?'إيقاف':'تفعيل')+'</a></td></tr>'}).join('');
 document.querySelectorAll('.tg').forEach(function(a){a.onclick=async function(e){e.preventDefault();await post('/api/admin/staff/toggle',{id:a.dataset.id});load()}});
 $('set').innerHTML=Object.keys(d.settings).map(function(k){return '<label>'+SL[k]+'</label><div style="display:flex;gap:6px"><input class="ltr" data-k="'+k+'" value="'+esc(d.settings[k])+'"><button class="pri sv" style="width:auto;margin:0;padding:0 16px">حفظ</button></div>'}).join('');
 document.querySelectorAll('.sv').forEach(function(btn){btn.onclick=async function(){var i=btn.previousElementSibling;try{await post('/api/admin/settings',{key:i.dataset.k,value:i.value});btn.textContent='✔'}catch(e){btn.textContent='✖';alert(e.message)}setTimeout(function(){btn.textContent='حفظ'},1200)}});
 var u=location.origin+'/card';$('tq').innerHTML=qrSvg(u);$('tu').textContent=u;
}
$('br').onchange=load;
var editId=null;
function cmsg(t,ok){var m=$('cmsg');m.textContent=t||'';m.className='msg '+(ok?'ok':'err')+(t?'':' hide')}
async function findCust(){cmsg('');$('cedit').classList.add('hide');editId=null;
 try{var c=await call('/api/admin/customer?q='+encodeURIComponent($('cq').value));editId=c.id;$('en').value=c.name;$('eph').value=c.phone;$('ecu').value=c.cups;$('ept').value=c.points;$('ere').value='';$('cedit').classList.remove('hide')}catch(e){cmsg(e.message)}}
$('cfind').onclick=findCust;$('cq').onkeydown=function(e){if(e.key==='Enter')findCust()};
$('cq').oninput=function(){editId=null;$('cedit').classList.add('hide');cmsg('')};
$('esave').onclick=async function(){if(!editId||!confirm('حفظ التعديل على بيانات العميل؟'))return;
 try{await post('/api/admin/adjust',{id:editId,name:$('en').value,phone:$('eph').value,cups:Number($('ecu').value),points:Number($('ept').value),reason:$('ere').value});$('cedit').classList.add('hide');editId=null;cmsg('تم حفظ التعديل ✔',true);load()}catch(e){cmsg(e.message)}};
$('lg').onclick=async function(){try{await post('/api/login',{username:$('u').value,pin:$('p').value});load()}catch(e){$('lerr').textContent=e.message;$('lerr').classList.remove('hide')}};
$('out').onclick=async function(){await post('/api/logout',{});location.reload()};
$('sa').onclick=async function(){var m=$('smsg');try{await post('/api/admin/staff',{name:$('sn').value,pin:$('sp').value,branch_id:$('sb').value});m.className='msg ok';m.textContent='تمت الإضافة';$('sn').value=$('sp').value='';load()}catch(e){m.className='msg err';m.textContent=e.message}};
load();
</script></body></html>`;
}
