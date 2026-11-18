/* Kinox — Worker de Cloudflare (claves de un solo uso real).
   Guarda en D1 solo HUELLAS (sha256) de las claves. El primer equipo que usa una
   clave queda registrado; cualquier otro equipo recibe "otro-equipo".
   Secreto necesario: ADMIN_TOKEN (para /v1/admin/*). Base de datos: binding DB. */

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const HEX = /^[a-f0-9]{64}$/;
const DEV = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

let listo = false;
async function iniciar(db) {
  if (listo) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY, h TEXT UNIQUE NOT NULL, device TEXT, note TEXT,
    created TEXT, expires TEXT, claimed_at TEXT)`).run();
  listo = true;
}

/* Comparación en tiempo constante del token de administración. */
function igual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

/* Reclama (o confirma) la clave para un equipo. La UPDATE solo afecta a filas
   sin equipo, así que aunque dos equipos lo intenten a la vez, gana uno solo. */
async function reclamar(db, h, dev) {
  let fila = await db.prepare('SELECT * FROM tokens WHERE h = ?').bind(h).first();
  if (!fila) return { ok: false, motivo: 'revocada' };
  if (fila.expires && Date.now() > Date.parse(fila.expires)) return { ok: false, motivo: 'expirada' };
  if (!fila.device) {
    await db.prepare('UPDATE tokens SET device = ?, claimed_at = ? WHERE h = ? AND device IS NULL')
      .bind(dev, new Date().toISOString(), h).run();
    fila = await db.prepare('SELECT * FROM tokens WHERE h = ?').bind(h).first();
  }
  if (fila.device !== dev) return { ok: false, motivo: 'otro-equipo' };
  return { ok: true };
}

async function leer(request) {
  try { return await request.json(); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.DB) return json({ error: 'Falta el binding DB' }, 500);
    await iniciar(env.DB);

    /* ---- público: usado por la app ---- */
    if (url.pathname === '/v1/claim' && request.method === 'POST') {
      const b = await leer(request);
      if (!b || !HEX.test(String(b.h || '')) || !DEV.test(String(b.device || ''))) return json({ ok: false, motivo: 'peticion' }, 400);
      return json(await reclamar(env.DB, b.h, b.device));
    }

    /* ---- administración ---- */
    if (url.pathname.startsWith('/v1/admin/')) {
      const auth = request.headers.get('authorization') || '';
      if (!env.ADMIN_TOKEN || !auth.startsWith('Bearer ') || !igual(auth.slice(7), env.ADMIN_TOKEN)) return json({ error: 'No autorizado' }, 401);

      if (url.pathname === '/v1/admin/add' && request.method === 'POST') {
        const b = await leer(request);
        const items = b && Array.isArray(b.items) ? b.items.slice(0, 200) : null;
        if (!items) return json({ error: 'items requerido' }, 400);
        const ahora = new Date().toISOString();
        const stmts = [];
        for (const it of items) {
          if (!it || !HEX.test(String(it.h || '')) || !/^[a-z0-9]{4,16}$/.test(String(it.id || ''))) return json({ error: 'item no válido' }, 400);
          const dev = it.device ? String(it.device).toUpperCase() : null;
          if (dev && !DEV.test(dev)) return json({ error: 'device no válido' }, 400);
          stmts.push(env.DB.prepare('INSERT INTO tokens (id, h, device, note, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(it.id, it.h, dev, String(it.note || '').slice(0, 80), ahora, it.expires || null));
        }
        try { await env.DB.batch(stmts); } catch (e) { return json({ error: 'No se pudo guardar (¿clave repetida?)' }, 409); }
        return json({ ok: true, added: stmts.length });
      }
      if (url.pathname === '/v1/admin/list' && request.method === 'GET') {
        const r = await env.DB.prepare('SELECT id, device, note, created, expires, claimed_at FROM tokens ORDER BY created DESC').all();
        return json({ tokens: r.results || [] });
      }
      if (url.pathname === '/v1/admin/remove' && request.method === 'POST') {
        const b = await leer(request);
        if (!b || (!b.id && !b.h)) return json({ error: 'id o h requerido' }, 400);
        const r = b.h ? await env.DB.prepare('DELETE FROM tokens WHERE h = ?').bind(String(b.h)).run()
                      : await env.DB.prepare('DELETE FROM tokens WHERE id = ?').bind(String(b.id)).run();
        const n = (r.meta && r.meta.changes) || 0;
        return json(n ? { ok: true } : { ok: false, error: 'No encontrada' }, n ? 200 : 404);
      }
      /* Libera una clave para que pueda usarse en OTRO equipo (p. ej. cambió de PC). */
      if (url.pathname === '/v1/admin/reset' && request.method === 'POST') {
        const b = await leer(request);
        if (!b || !b.id) return json({ error: 'id requerido' }, 400);
        const r = await env.DB.prepare('UPDATE tokens SET device = NULL, claimed_at = NULL WHERE id = ?').bind(String(b.id)).run();
        const n = (r.meta && r.meta.changes) || 0;
        return json(n ? { ok: true } : { ok: false, error: 'No encontrada' }, n ? 200 : 404);
      }
    }
    return json({ error: 'No encontrado' }, 404);
  }
};
