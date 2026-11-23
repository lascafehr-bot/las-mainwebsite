// Las Cafe loyalty system: one Cloudflare Worker + D1 (binding name: DB).
// Secret required: ADMIN_PASSWORD (also used to sign session cookies).
// Pages: /card (customer), /c/<code>, /staff (cashier), /admin.

const RIYADH_OFFSET = 3 * 3600 * 1000; // UTC+3, no daylight saving
const DEFAULTS = {
  min_amount: '20',
  cups_per_reward: '5',
  points_per_order: '20',
  stamp_cooldown_hours: '3',
  points_redemption: '{"enabled":false,"points_needed":null,"value_sar":null}',
  wallet_apple_url: '',
  wallet_google_url: '',
};
const EDITABLE = ['min_amount', 'points_per_order', 'stamp_cooldown_hours', 'points_redemption', 'wallet_apple_url', 'wallet_google_url'];
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
    points: Number(s.points_per_order),
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

// ---------- API ----------
async function api(req, env, url) {
  const path = url.pathname;
  const method = req.method;
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

  // public: customer card lookup (first name only, no phone returned)
  if (path === '/api/public/card' && method === 'GET') {
    const q = url.searchParams.get('code') || url.searchParams.get('phone');
    const c = await findCustomer(env, q);
    if (!c) return fail('لم نجد بطاقة بهذا الرقم', 404);
    const cfg = await getSettings(env);
    return json({ ...cardView(c, cfg), name: c.name.split(' ')[0], wallet_apple_url: cfg.raw.wallet_apple_url, wallet_google_url: cfg.raw.wallet_google_url });
  }

  if (path === '/api/login' && method === 'POST') {
    const name = String(body.username || '').trim(), pin = String(body.pin || '');
    if (!env.ADMIN_PASSWORD) return fail('ADMIN_PASSWORD غير مضبوط', 500);
    if (name.toLowerCase() === 'admin') {
      if (!safeEqual(pin, env.ADMIN_PASSWORD)) return fail('بيانات الدخول غير صحيحة', 401);
      const t = await makeSession(env, { id: null, name: 'Admin', role: 'admin' });
      return json({ ok: true, role: 'admin' }, 200, { 'set-cookie': cookie(t, 43200) });
    }
    const st = await env.DB.prepare('SELECT s.*, b.name AS branch_name FROM staff s JOIN branches b ON b.id = s.branch_id WHERE s.name = ? AND s.active = 1').bind(name).first();
    if (!st || !(await verifyPin(pin, st.pin_hash))) return fail('بيانات الدخول غير صحيحة', 401);
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
    return json({ ...cardView(c, await getSettings(env)), phone: maskPhone(c.phone) });
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

  if (path === '/api/stamp' && method === 'POST') {
    const deny = needCashier(); if (deny) return deny;
    const amount = Number(body.amount);
    if (!(amount > 0) || amount > 10000) return fail('أدخل مبلغ الفاتورة');
    const c = await findCustomer(env, body.phone);
    if (!c) return fail('العميل غير مسجل', 404);
    const cfg = await getSettings(env);
    if (amount < cfg.minAmount) {
      await logTx(env, c, s, 'visit', { amount, note: 'أقل من الحد الأدنى' }).run();
      return json({ ok: true, stamped: false, message: 'المبلغ أقل من ' + cfg.minAmount + ' ريال، لا تُضاف أكواب', card: cardView(c, cfg) });
    }
    if (c.cups >= cfg.cups) return fail('البطاقة مكتملة، يجب استبدال المشروب المجاني أولاً', 409);
    // Atomic: the WHERE clause enforces both the 3-hour window and the cup cap, even with two cashiers at once.
    const now = Date.now();
    const up = await env.DB.prepare('UPDATE customers SET cups = cups + 1, points = points + ?, last_stamp_at = ? WHERE id = ? AND cups < ? AND (last_stamp_at IS NULL OR last_stamp_at <= ?)')
      .bind(cfg.points, now, c.id, cfg.cups, now - cfg.cooldownMs).run();
    if (up.meta.changes === 0) {
      const wait = Math.max(1, Math.ceil((c.last_stamp_at + cfg.cooldownMs - now) / 60000));
      return fail('تم إضافة ختم لهذا العميل مؤخرًا. المتبقي ' + wait + ' دقيقة', 429, { wait_minutes: wait });
    }
    const after = c.cups + 1;
    await logTx(env, c, s, 'stamp', { amount, cups_after: after, points_delta: cfg.points, note: after >= cfg.cups ? 'اكتملت البطاقة' : null }).run();
    const fresh = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(c.id).first();
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
    return json({ ok: true, card: cardView(fresh, cfg) });
  }

  // ---- admin ----
  if (!path.startsWith('/api/admin/')) return fail('غير موجود', 404);
  if (s.role !== 'admin') return fail('للمدير فقط', 403);

  if (path === '/api/admin/stats' && method === 'GET') {
    const bp = url.searchParams.get('branch');
    const branch = bp ? Number(bp) : null;
    const today = dayStart(Date.now());
    const F = '(?1 IS NULL OR t.branch_id = ?1)';
    const q = (sql, ...b) => env.DB.prepare(sql).bind(branch, ...b);
    const [cust, visits, stamps, redeems, top, recent, branches, staff] = await Promise.all([
      q("SELECT COUNT(DISTINCT t.customer_id) AS n FROM transactions t WHERE t.type != 'redeem_failed' AND " + F).first(),
      q("SELECT COUNT(*) AS n FROM transactions t WHERE t.type IN ('stamp','visit') AND t.created_at >= ?2 AND " + F, today).first(),
      q("SELECT COUNT(*) AS n FROM transactions t WHERE t.type = 'stamp' AND t.created_at >= ?2 AND " + F, today).first(),
      q("SELECT COUNT(*) AS n FROM transactions t WHERE t.type = 'redeem' AND t.created_at >= ?2 AND " + F, today).first(),
      q("SELECT c.name, c.phone, COUNT(*) AS visits, ROUND(SUM(t.amount),2) AS spent, c.cups, c.points FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE t.type IN ('stamp','visit') AND " + F + ' GROUP BY c.id ORDER BY visits DESC, spent DESC LIMIT 10').all(),
      q('SELECT t.type, t.amount, t.points_delta, t.staff_name, t.branch_name, t.note, t.created_at, c.name AS customer FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE ' + F + ' ORDER BY t.id DESC LIMIT 30').all(),
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
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname === '/' ) return Response.redirect(url.origin + '/card', 302);
      if (url.pathname === '/card' || url.pathname.startsWith('/c/')) return html(customerPage());
      if (url.pathname === '/staff') return html(staffPage());
      if (url.pathname === '/admin') return html(adminPage());
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return fail('خطأ في الخادم: ' + e.message, 500);
    }
  },
};

// ---------- pages ----------
const LOGO = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 64" role="img" aria-label="LAS CAFE" fill="currentColor"><text x="60" y="38" text-anchor="middle" font-family="Georgia,serif" font-size="38" letter-spacing="5">LAS</text><text x="60" y="58" text-anchor="middle" font-family="Georgia,serif" font-size="14" letter-spacing="6">CAFE</text></svg>`;

const CSS = String.raw`
:root{--teal:#3d4864;--teal2:#4a5778;--sand:#f8f4ec;--copper:#a58670;--ink:#232b3d;--mut:#6f7686;--line:#e6dfd3;--ok:#1b7f4b;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--sand);color:var(--ink);font-family:"IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif;line-height:1.5}
.wrap{max-width:460px;margin:0 auto;padding:16px}.wide{max-width:1000px}
header.top{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--teal);color:#fff}
header.top svg{width:62px;height:33px}header.top b{flex:1}
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
.card .hd{display:flex;align-items:center;justify-content:space-between}.card .hd svg{width:64px;height:34px}.card .hd small{color:var(--mo)}
.card .mid{display:flex;align-items:center;gap:6px;margin:4px 0}.card .mid svg.v60{width:178px;height:176px;flex:none;overflow:visible}
.card .info{flex:1;text-align:center}.card .big{font-size:2.8rem;font-weight:600;line-height:1}.card .big span{font-size:1.2rem;color:var(--mo)}
.card .lbl{color:var(--mo);font-size:.8rem}.card .left{font-size:.95rem;margin-top:8px}
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
<div id="out"></div></div>${QR_LIB}<script>${CUP_JS}
function v60(f,done,total){
 var body='M40 78H128V136a28 28 0 0 1-28 28H68a28 28 0 0 1-28-28Z',surf=82+(1-f)*86,fall=Math.max(0,Math.round(surf-92));
 var s='<svg class="v60" viewBox="0 0 178 176" role="img" aria-label="'+Math.round(f*total)+' / '+total+'" style="--fall:'+fall+'px"><defs><clipPath id="cl"><path d="'+body+'"/></clipPath></defs>';
 s+='<path d="'+body+'" fill="#a5867014" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M128 92h8a16 16 0 0 1 0 38h-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
 s+='<g clip-path="url(#cl)"><g class="lvl" style="transform:translateY(86px)"><rect x="30" y="85" width="110" height="90" fill="#a58670"/><path class="wave" d="M-24 82q12-5 24 0t24 0t24 0t24 0t24 0t24 0t24 0t24 0t24 0t24 0V92H-24Z" fill="#a58670"/></g></g>';
 s+='<text x="84" y="154" text-anchor="middle" font-family="Georgia,serif" font-size="16" letter-spacing="4" fill="currentColor" opacity=".9">LAS</text>';
 for(var i=1;i<=total;i++){var y=164-i*(82/total);s+='<line x1="40" y1="'+y+'" x2="47" y2="'+y+'" stroke="currentColor" stroke-opacity=".7"/><text x="32" y="'+(y+4)+'" text-anchor="end" font-size="11" fill="#a58670">'+i+'</text>'}
 s+='<path d="M34 18H134L102 70V84H66V70Z" fill="#a5867033" stroke="#a58670" stroke-width="2" stroke-linejoin="round"/>';
 [[54,73],[74,80],[94,88],[114,95]].forEach(function(p){s+='<line x1="'+p[0]+'" y1="22" x2="'+p[1]+'" y2="68" stroke="#a58670" stroke-opacity=".6"/>'});
 s+='<rect x="28" y="13" width="112" height="7" rx="3.5" fill="#a58670"/>';
 if(!done)s+='<circle class="drop" cx="84" cy="88" r="2.8" fill="#a58670"/><circle class="drop d2" cx="84" cy="88" r="2.8" fill="#a58670"/>';
 else s+='<g fill="none" stroke="#a58670" stroke-width="2" stroke-linecap="round"><path class="steam" d="M70 10q-5-5 0-10t0-9"/><path class="steam s2" d="M84 10q-5-5 0-10t0-9"/><path class="steam s3" d="M98 10q-5-5 0-10t0-9"/></g>';
 return s+'</svg>'}
function show(c){
 $('lookup').classList.add('hide');
 var f=Math.min(1,c.cups/c.cups_per_reward),done=c.free_drinks>0,rem=c.cups_per_reward-c.cups;
 var left=rem===1?'باقي ختم واحد وتاخذ مشروبك المجاني':rem===2?'باقي ختمان وتاخذ مشروبك المجاني':'باقي '+rem+' أختام وتاخذ مشروبك المجاني';
 var h='<div class="card'+(done?' done':'')+'"><div class="hd">'+${JSON.stringify(LOGO)}+'<small>بطاقة الولاء</small></div>'
 +'<div class="mid">'+v60(f,done,c.cups_per_reward)+'<div class="info"><div class="big">'+c.cups+'<span> / '+c.cups_per_reward+'</span></div><div class="lbl">الأختام</div>'
 +(done?'<div class="band">مشروبك القادم علينا</div>':'<div class="left">'+left+'</div>')+'</div></div>'
 +'<div class="row"><div><div class="lbl">الاسم</div><div class="nm">'+esc(c.name)+'</div><div class="lbl" style="margin-top:6px">النقاط <b style="color:var(--fg);font-size:1.1rem">'+c.points+'</b></div></div>'
 +'<div class="qr">'+qrSvg(c.card_code)+'<small>'+esc(c.card_code)+'</small></div></div></div>';
 setTimeout(function(){var l=document.querySelector('.v60 .lvl');if(l)l.style.transform='translateY('+((1-f)*86)+'px)'},150);
 var w='';if(c.wallet_apple_url)w+='<a class="pri" style="display:block;text-align:center;text-decoration:none;margin-top:10px;padding:12px;border-radius:10px;background:#000;color:#fff" href="'+esc(c.wallet_apple_url)+'">إضافة إلى Apple Wallet</a>';
 if(c.wallet_google_url)w+='<a class="pri" style="display:block;text-align:center;text-decoration:none;margin-top:10px;padding:12px;border-radius:10px;background:#1a73e8;color:#fff" href="'+esc(c.wallet_google_url)+'">إضافة إلى Google Wallet</a>';
 $('out').innerHTML=h+w+'<p style="text-align:center"><a href="/card">بحث برقم آخر</a></p>';
}
async function find(q){try{show(await call('/api/public/card?'+q))}catch(e){$('err').textContent=e.message;$('err').classList.remove('hide');$('lookup').classList.remove('hide')}}
$('go').onclick=function(){find('phone='+encodeURIComponent($('ph').value))};
$('ph').onkeydown=function(e){if(e.key==='Enter')$('go').click()};
if(location.pathname.indexOf('/c/')===0){$('lookup').classList.add('hide');find('code='+encodeURIComponent(location.pathname.slice(3)))}
</script></body></html>`;
}

function staffPage() {
  return head('الكاشير · لاس') + `<header class="top">${LOGO}<b id="who">الكاشير</b><button id="out" class="hide">خروج</button></header><div class="wrap">
<div id="login" class="box hide"><h2>تسجيل دخول الموظف</h2><label>اسم الموظف</label><input id="u" autocomplete="username"><label>الرقم السري</label><input id="p" type="password" class="num" inputmode="numeric" autocomplete="current-password"><button class="pri" id="lg">دخول</button><div id="lerr" class="msg err hide"></div></div>
<div id="app" class="hide">
 <div class="box"><h2>بحث عن عميل</h2><label>رقم الجوال (أو رمز البطاقة LAS-…)</label><input id="q" class="num" inputmode="tel" placeholder="05XXXXXXXX"><button class="pri" id="find">بحث</button></div>
 <div id="msg" class="msg hide"></div>
 <div id="reg" class="box hide"><h2>عميل جديد: تسجيل</h2><label>الاسم</label><input id="rn"><label>الجوال</label><input id="rp" class="num" readonly><button class="pri alt" id="rg">تسجيل العميل</button></div>
 <div id="cust" class="box hide"></div>
</div></div><script>${CUP_JS}
var cur=null;
function msg(t,ok){var m=$('msg');m.textContent=t||'';m.className='msg '+(ok?'ok':'err')+(t?'':' hide')}
async function boot(){try{var me=await call('/api/me');if(me.role!=='cashier'){location.href='/admin';return}
 $('who').textContent=me.name+' · فرع '+me.branch_name;$('out').classList.remove('hide');$('app').classList.remove('hide');$('login').classList.add('hide')}
 catch(e){$('login').classList.remove('hide')}}
$('lg').onclick=async function(){try{await post('/api/login',{username:$('u').value,pin:$('p').value});boot()}catch(e){$('lerr').textContent=e.message;$('lerr').classList.remove('hide')}};
$('out').onclick=async function(){await post('/api/logout',{});location.reload()};
function render(c){cur=c;var h='<div class="who"><b>'+esc(c.name)+'</b><span class="tag">'+esc(c.phone)+'</span></div><div class="cups" style="filter:none">'+cupsHtml(c.cups,c.cups_per_reward)+'</div>'
 +'<p style="margin:0 0 8px">الأكواب <b>'+c.cups+'/'+c.cups_per_reward+'</b> · النقاط <b>'+c.points+'</b></p>';
 if(c.free_drinks){h+='<div class="msg ok">🎉 البطاقة مكتملة: المشروب التالي مجاني</div><label>اطلب من العميل آخر 4 أرقام من جواله</label><input id="l4" class="num" inputmode="numeric" maxlength="4"><button class="pri alt" id="rd">استبدال المشروب المجاني</button>'}
 else{h+='<label>مبلغ الفاتورة (ريال)</label><input id="am" class="num" inputmode="decimal" placeholder="0.00"><button class="pri" id="st">إضافة ختم</button>'}
 $('cust').innerHTML=h;$('cust').classList.remove('hide');$('reg').classList.add('hide');
 if($('st'))$('st').onclick=stamp;if($('rd'))$('rd').onclick=redeem}
async function lookup(){msg('');var q=$('q').value.trim();$('cust').classList.add('hide');$('reg').classList.add('hide');
 try{render(await call('/api/customer?q='+encodeURIComponent(q)))}catch(e){if(e.status===404){$('rp').value=q;$('rn').value='';$('reg').classList.remove('hide');msg('العميل غير مسجل، سجله الآن',true)}else msg(e.message)}}
async function stamp(){$('st').disabled=true;try{var r=await post('/api/stamp',{phone:$('q').value,amount:$('am').value});msg(r.stamped?(r.reward_earned?'تمت إضافة الختم 🎉 اكتملت البطاقة':'تمت إضافة الختم ✔'):r.message,true);render(r.card)}catch(e){msg(e.message);if($('st'))$('st').disabled=false}}
async function redeem(){try{var r=await post('/api/redeem',{phone:$('q').value,last4:$('l4').value});msg('تم استبدال المشروب المجاني، البطاقة بدأت من جديد ✔',true);render(r.card)}catch(e){msg(e.message)}}
$('rg').onclick=async function(){try{await post('/api/register',{name:$('rn').value,phone:$('rp').value});msg('تم تسجيل العميل ✔',true);lookup()}catch(e){msg(e.message)}};
$('find').onclick=lookup;$('q').onkeydown=function(e){if(e.key==='Enter')lookup()};
boot();
</script></body></html>`;
}

function adminPage() {
  return head('لوحة الإدارة · لاس') + `<header class="top">${LOGO}<b>لوحة الإدارة</b><button id="out" class="hide">خروج</button></header><div class="wrap wide">
<div id="login" class="box hide" style="max-width:420px;margin:auto"><h2>دخول المدير</h2><label>اسم المستخدم</label><input id="u" value="admin" class="ltr"><label>كلمة المرور</label><input id="p" type="password" class="num"><button class="pri" id="lg">دخول</button><div id="lerr" class="msg err hide"></div></div>
<div id="app" class="hide">
 <div class="box"><label style="margin:0 0 4px">الفرع</label><select id="br"></select></div>
 <div class="grid" id="stats"></div>
 <div class="box" style="margin-top:12px"><h2>أفضل العملاء</h2><div class="scroll"><table id="top"></table></div></div>
 <div class="box"><h2>آخر النشاطات</h2><div class="scroll"><table id="rec"></table></div></div>
 <div class="box"><h2>الموظفون</h2><div class="scroll"><table id="stf"></table></div>
  <label>اسم موظف جديد</label><input id="sn"><label>الفرع</label><select id="sb"></select><label>الرقم السري (4-8 أرقام)</label><input id="sp" class="num" inputmode="numeric"><button class="pri" id="sa">إضافة موظف</button><div id="smsg" class="msg hide"></div></div>
 <div class="box"><h2>الإعدادات</h2><div id="set"></div></div>
 <div class="box" style="text-align:center"><h2>QR الطاولة (صفحة البطاقة)</h2><div class="qr" style="width:170px;margin:auto;background:#fff;padding:10px;border:1px solid var(--line);border-radius:10px" id="tq"></div><small class="ltr" id="tu"></small></div>
</div></div>${QR_LIB}<script>${CUP_JS}
var LBL={register:'تسجيل',stamp:'ختم',visit:'زيارة (بدون كوب)',redeem:'استبدال',redeem_failed:'محاولة استبدال فاشلة'};
function fmt(ms){return new Date(ms).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh',dateStyle:'short',timeStyle:'short'})}
var SL={min_amount:'الحد الأدنى للفاتورة (ريال)',points_per_order:'نقاط كل طلب',stamp_cooldown_hours:'ساعات بين الأختام',points_redemption:'قاعدة استبدال النقاط (JSON)',wallet_apple_url:'رابط Apple Wallet',wallet_google_url:'رابط Google Wallet'};
async function load(){
 var b=$('br').value;var d;
 try{d=await call('/api/admin/stats'+(b?'?branch='+b:''))}catch(e){$('login').classList.remove('hide');$('app').classList.add('hide');return}
 $('login').classList.add('hide');$('app').classList.remove('hide');$('out').classList.remove('hide');
 if(!$('br').options.length){$('br').innerHTML='<option value="">كل الفروع</option>'+d.branches.map(function(x){return '<option value="'+x.id+'">'+esc(x.name)+'</option>'}).join('');$('br').value=b;$('sb').innerHTML=d.branches.map(function(x){return '<option value="'+x.id+'">'+esc(x.name)+'</option>'}).join('')}
 $('stats').innerHTML=[['إجمالي العملاء',d.customers],['زيارات اليوم',d.visits_today],['أختام اليوم',d.stamps_today],['استبدالات اليوم',d.redeems_today]].map(function(x){return '<div class="stat"><b>'+x[1]+'</b>'+x[0]+'</div>'}).join('');
 $('top').innerHTML='<tr><th>العميل</th><th>الجوال</th><th>الزيارات</th><th>الإنفاق</th><th>الأكواب</th><th>النقاط</th></tr>'+d.top.map(function(r){return '<tr><td>'+esc(r.name)+'</td><td class="ltr">'+esc(r.phone)+'</td><td>'+r.visits+'</td><td>'+(r.spent||0)+'</td><td>'+r.cups+'</td><td>'+r.points+'</td></tr>'}).join('');
 $('rec').innerHTML='<tr><th>الوقت</th><th>النوع</th><th>العميل</th><th>المبلغ</th><th>الموظف</th><th>الفرع</th></tr>'+d.recent.map(function(r){return '<tr><td>'+fmt(r.created_at)+'</td><td><span class="tag">'+(LBL[r.type]||r.type)+'</span></td><td>'+esc(r.customer)+'</td><td>'+(r.amount==null?'':r.amount)+'</td><td>'+esc(r.staff_name)+'</td><td>'+esc(r.branch_name||'')+'</td></tr>'}).join('');
 $('stf').innerHTML='<tr><th>الموظف</th><th>الفرع</th><th>الحالة</th><th></th></tr>'+d.staff.map(function(s){return '<tr><td>'+esc(s.name)+'</td><td>'+esc(s.branch_name)+'</td><td>'+(s.active?'فعال':'موقوف')+'</td><td><a href="#" data-id="'+s.id+'" class="tg">'+(s.active?'إيقاف':'تفعيل')+'</a></td></tr>'}).join('');
 document.querySelectorAll('.tg').forEach(function(a){a.onclick=async function(e){e.preventDefault();await post('/api/admin/staff/toggle',{id:a.dataset.id});load()}});
 $('set').innerHTML=Object.keys(d.settings).map(function(k){return '<label>'+SL[k]+'</label><div style="display:flex;gap:6px"><input class="ltr" data-k="'+k+'" value="'+esc(d.settings[k])+'"><button class="pri sv" style="width:auto;margin:0;padding:0 16px">حفظ</button></div>'}).join('');
 document.querySelectorAll('.sv').forEach(function(btn){btn.onclick=async function(){var i=btn.previousElementSibling;try{await post('/api/admin/settings',{key:i.dataset.k,value:i.value});btn.textContent='✔'}catch(e){btn.textContent='✖';alert(e.message)}setTimeout(function(){btn.textContent='حفظ'},1200)}});
 var u=location.origin+'/card';$('tq').innerHTML=qrSvg(u);$('tu').textContent=u;
}
$('br').onchange=load;
$('lg').onclick=async function(){try{await post('/api/login',{username:$('u').value,pin:$('p').value});load()}catch(e){$('lerr').textContent=e.message;$('lerr').classList.remove('hide')}};
$('out').onclick=async function(){await post('/api/logout',{});location.reload()};
$('sa').onclick=async function(){var m=$('smsg');try{await post('/api/admin/staff',{name:$('sn').value,pin:$('sp').value,branch_id:$('sb').value});m.className='msg ok';m.textContent='تمت الإضافة';$('sn').value=$('sp').value='';load()}catch(e){m.className='msg err';m.textContent=e.message}};
load();
</script></body></html>`;
}
