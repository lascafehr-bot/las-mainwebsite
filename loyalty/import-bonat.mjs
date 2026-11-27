// Turns a Bonat "branch customers" .xlsx into SQL for D1. Holds no customer data itself.
//   node import-bonat.mjs <customers.xlsx> <out.sql> <branch name, e.g. جدة>
// Needs `unzip` (Git Bash). Safe to run again with a newer export: balances are replaced, not added twice.
// The output contains customer data: keep it outside the repository.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const [file, out, branch] = process.argv.slice(2);
if (!file || !out || !branch) { console.error('usage: node import-bonat.mjs <customers.xlsx> <out.sql> <branch>'); process.exit(1); }

const xml = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], { maxBuffer: 1 << 28 }).toString('utf8');
const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colIdx = (r) => [...r.match(/^[A-Z]+/)[0]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((m) => {
  const cells = [];
  for (const c of m[1].matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    cells[colIdx(c[1])] = dec((c[2] && (c[2].match(/<(?:t|v)(?: [^>]*)?>([\s\S]*?)<\/(?:t|v)>/) || [])[1]) || '');
  }
  return cells;
});
const head = rows.shift();
const col = (n) => { const i = head.indexOf(n); if (i < 0) throw new Error('missing column: ' + n); return i; };
const [iName, iPhone, iPts] = [col('Name'), col('Phone Number'), col('Points Balance')];

const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const code = () => 'LAS-' + [...randomBytes(8)].map((x) => A[x % A.length]).join('');
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const now = Date.now();
const seen = new Set(), rejected = [];
let sql = '', points = 0, named = 0;

rows.forEach((r, n) => {
  let d = String(r[iPhone] || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  const pts = Number(r[iPts] || 0);
  const why = !/^5\d{8}$/.test(d) ? 'phone' : !(Number.isFinite(pts) && pts >= 0) ? 'points' : seen.has(d) ? 'duplicate' : '';
  if (why) { rejected.push('row ' + (n + 2) + ': ' + why); return; }
  seen.add(d);
  const phone = q('966' + d), p = Math.floor(pts), raw = String(r[iName] || '').trim().slice(0, 60);
  const name = raw.length > 1 ? raw : 'عميل';
  points += p; if (raw.length > 1) named++;
  sql += `INSERT OR IGNORE INTO customers (phone, name, card_code, created_at) VALUES (${phone}, ${q(name)}, ${q(code())}, ${now});\n`;
  if (raw.length > 1) sql += `UPDATE customers SET name = ${q(name)} WHERE phone = ${phone} AND name = 'عميل';\n`;
  // log once per customer so they count in the dashboard
  sql += `INSERT INTO transactions (customer_id, type, cups_after, points_delta, staff_name, branch_id, branch_name, note, created_at) SELECT c.id, 'import', c.cups, ${p}, 'استيراد بونات', b.id, b.name, 'رصيد من بونات', ${now} FROM customers c JOIN branches b ON b.name = ${q(branch)} WHERE c.phone = ${phone} AND NOT EXISTS (SELECT 1 FROM bonat_import i WHERE i.phone = c.phone);\n`;
  sql += `UPDATE customers SET points = points - COALESCE((SELECT points FROM bonat_import WHERE phone = ${phone}), 0) + ${p} WHERE phone = ${phone};\n`;
  sql += `INSERT INTO bonat_import (phone, points, imported_at) VALUES (${phone}, ${p}, ${now}) ON CONFLICT(phone) DO UPDATE SET points = excluded.points, imported_at = excluded.imported_at;\n`;
});

writeFileSync(out, sql);
console.log(`rows ${rows.length} | accepted ${seen.size} | rejected ${rejected.length} | with name ${named} | points total ${points}`);
rejected.slice(0, 20).forEach((x) => console.log('  rejected ' + x));
