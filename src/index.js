
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const HEX = /^[a-f0-9]{64}$/;
const DEV = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

let listo = false;

async function iniciar(db) {
  if (listo) return;

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      h TEXT UNIQUE NOT NULL,
      device TEXT,
      note TEXT,
      created TEXT,
      expires TEXT,
      claimed_at TEXT
    )
  `).run();

  listo = true;
}

function igual(a, b) {
  a = String(a);
  b = String(b);

  let d = a.length ^ b.length;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return d === 0;
}

async function reclamar(db, h, dev) {
  let fila = await db.prepare(
    "SELECT * FROM tokens WHERE h = ?"
  ).bind(h).first();

  if (!fila) return { ok: false, motivo: "revocada" };

  if (fila.expires && Date.now() > Date.parse(fila.expires)) {
    return { ok: false, motivo: "expirada" };
  }

  if (!fila.device) {
    await db.prepare(`
      UPDATE tokens
      SET device = ?, claimed_at = ?
      WHERE h = ? AND device IS NULL
    `).bind(dev, new Date().toISOString(), h).run();

    fila = await db.prepare(
      "SELECT * FROM tokens WHERE h = ?"
    ).bind(h).first();
  }

  if (fila.device !== dev) {
    return { ok: false, motivo: "otro-equipo" };
  }

  return { ok: true };
}

async function leer(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* PANEL WEB DE ADMINISTRACIÓN */

const PANEL_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1019">
<title>Kinox Admin</title>

<style>
*{box-sizing:border-box}
body{
 margin:0;background:#0b1019;color:#e8edf5;
 font-family:Arial,sans-serif
}
main{max-width:1050px;margin:35px auto;padding:18px}
h1{color:#42d6c5;letter-spacing:2px}
h2{font-size:19px}
.card{
 background:#141e2c;border:1px solid #27364a;
 border-radius:14px;padding:22px;margin:18px 0
}
input,button,textarea{
 padding:12px;border-radius:8px;
 border:1px solid #34445a;
 background:#0c1522;color:white;font-size:14px
}
input,textarea{width:100%;margin:8px 0 15px}
button{cursor:pointer;background:#147f78;border:0;font-weight:bold}
button:hover{opacity:.85}
.danger{background:#a83e4b}
.secondary{background:#34445a}
.grid{
 display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
 gap:12px
}
table{width:100%;border-collapse:collapse;margin-top:15px}
th,td{
 text-align:left;padding:12px;
 border-bottom:1px solid #29384b;font-size:13px
}
th{color:#42d6c5}
small{color:#94a3b8}
.hidden{display:none}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.actions button{font-size:12px;padding:9px}
#message{white-space:pre-wrap;color:#42d6c5}
textarea{min-height:110px;font-family:monospace}
.stats{
 display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
 gap:12px
}
.stat{background:#0c1522;border-radius:10px;padding:15px}
.stat strong{display:block;font-size:25px;color:#42d6c5}
@media(max-width:600px){
 main{padding:12px;margin:15px auto}
 .card{padding:15px}
 th,td{padding:8px;font-size:12px}
}
</style>
</head>

<body>
<main>

<h1>KINOX ADMIN</h1>
<p><small>GESTIÓN DE LICENCIAS Y DISPOSITIVOS</small></p>

<section class="card" id="login">
<h2>Acceso administrativo</h2>
<label>Contraseña administrativa</label>
<input id="adminToken" type="password"
 placeholder="Introduce tu ADMIN_TOKEN">
<button id="loginBtn">Iniciar sesión</button>
<p id="loginMsg"></p>
</section>

<section id="dashboard" class="hidden">

<div class="stats">
 <div class="stat">
  <small>Total de licencias</small>
  <strong id="total">0</strong>
 </div>
 <div class="stat">
  <small>Activadas</small>
  <strong id="activated">0</strong>
 </div>
 <div class="stat">
  <small>Sin activar</small>
  <strong id="unused">0</strong>
 </div>
</div>

<div class="card">
<h2>Crear licencias</h2>

<div class="grid">
 <div>
  <label>Cliente / Nota</label>
  <input id="note" placeholder="Cliente 1">
 </div>
 <div>
  <label>Cantidad</label>
  <input id="count" type="number" min="1" max="200" value="1">
 </div>
 <div>
  <label>Duración (días)</label>
  <input id="days" type="number" min="1" value="30">
 </div>
</div>

<button id="createBtn">Generar tokens</button>

<div id="generated" class="hidden">
<h3>Tokens generados</h3>
<textarea id="keys" readonly></textarea>
<button id="copyBtn" class="secondary">Copiar tokens</button>
</div>
</div>

<div class="card">
<div class="grid">
 <h2>Licencias registradas</h2>
 <button id="refreshBtn" class="secondary">Actualizar lista</button>
</div>

<div style="overflow-x:auto">
<table>
<thead>
<tr>
 <th>ID</th>
 <th>Cliente</th>
 <th>Dispositivo</th>
 <th>Vencimiento</th>
 <th>Estado</th>
 <th>Acciones</th>
</tr>
</thead>
<tbody id="tokenRows"></tbody>
</table>
</div>
</div>

<button id="logoutBtn" class="danger">Cerrar sesión</button>
</section>

<p id="message"></p>

</main>

<script>
let adminToken = "";
const el = id => document.getElementById(id);
const message = text => el("message").textContent = text;

async function api(path, method = "GET", body) {
  const options = {
    method,
    headers: {
      "Authorization": "Bearer " + adminToken
    }
  };

  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Error de servidor");
  }

  return data;
}

function randomKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let chars = "";

  for (const b of bytes) {
    chars += alphabet[b % alphabet.length];
  }

  return chars.slice(0,4) + "-" +
         chars.slice(4,8) + "-" +
         chars.slice(8,12);
}


async function hashKey(key) {
  const normalized = String(key || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const data = new TextEncoder().encode("kinox|" + normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}


el("loginBtn").onclick = async () => {
  adminToken = el("adminToken").value.trim();

  if (!adminToken) {
    el("loginMsg").textContent = "Introduce tu contraseña.";
    return;
  }

  try {
    await loadTokens();
    el("login").classList.add("hidden");
    el("dashboard").classList.remove("hidden");
    el("adminToken").value = "";
    el("loginMsg").textContent = "";
    message("Sesión iniciada correctamente.");
  } catch (e) {
    adminToken = "";
    el("loginMsg").textContent = e.message;
  }
};

async function loadTokens() {
  const data = await api("/v1/admin/list");
  const tokens = data.tokens || [];
  const tbody = el("tokenRows");

  tbody.replaceChildren();

  let activated = 0;

  for (const token of tokens) {
    if (token.device) activated++;

    const expired = token.expires &&
      Date.now() > Date.parse(token.expires);

    const tr = document.createElement("tr");

    const values = [
      token.id,
      token.note || "-",
      token.device || "Sin activar",
      token.expires
        ? new Date(token.expires).toLocaleDateString()
        : "Sin vencimiento",
      expired ? "Expirada" :
        token.device ? "Activada" : "Disponible"
    ];

    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }

    const actions = document.createElement("td");
    const group = document.createElement("div");
    group.className = "actions";

    const reset = document.createElement("button");
    reset.textContent = "Liberar";
    reset.className = "secondary";

    reset.onclick = async () => {
      if (!confirm("¿Liberar esta licencia para otro dispositivo?")) return;

      try {
        await api("/v1/admin/reset", "POST", {id:token.id});
        message("Licencia restablecida.");
        await loadTokens();
      } catch(e) {
        message(e.message);
      }
    };

    const remove = document.createElement("button");
    remove.textContent = "Eliminar";
    remove.className = "danger";

    remove.onclick = async () => {
      if (!confirm("¿Eliminar definitivamente esta licencia?")) return;

      try {
        await api("/v1/admin/remove", "POST", {id:token.id});
        message("Licencia eliminada.");
        await loadTokens();
      } catch(e) {
        message(e.message);
      }
    };

    group.append(reset, remove);
    actions.appendChild(group);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }

  el("total").textContent = tokens.length;
  el("activated").textContent = activated;
  el("unused").textContent = tokens.length - activated;
}

el("createBtn").onclick = async () => {
  const count = Number(el("count").value);
  const days = Number(el("days").value);
  const note = el("note").value.trim();

  if (!Number.isInteger(count) || count < 1 || count > 200 ||
      !Number.isInteger(days) || days < 1) {
    return message("Cantidad o duración no válida.");
  }

  const btn = el("createBtn");
  btn.disabled = true;

  try {
    const keys = [];
    const items = [];

    for (let i = 0; i < count; i++) {
      const key = randomKey();
      keys.push(key);

      items.push({
        id: crypto.randomUUID().replace(/-/g,"").slice(0,12),
        h: await hashKey(key),
        note,
        device: null,
        expires: new Date(
          Date.now() + days * 86400000
        ).toISOString()
      });
    }

    await api("/v1/admin/add", "POST", {items});

    el("keys").value = keys.join("\\n");
    el("generated").classList.remove("hidden");

    message("Se generaron " + count + " licencia(s). Guarda las claves.");
    await loadTokens();

  } catch(e) {
    message(e.message);
  } finally {
    btn.disabled = false;
  }
};

el("copyBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(el("keys").value);
    message("Tokens copiados.");
  } catch {
    el("keys").select();
    message("Selecciona y copia las claves manualmente.");
  }
};

el("refreshBtn").onclick = async () => {
  try {
    await loadTokens();
    message("Lista actualizada.");
  } catch(e) {
    message(e.message);
  }
};

el("logoutBtn").onclick = () => {
  adminToken = "";
  el("dashboard").classList.add("hidden");
  el("login").classList.remove("hidden");
  el("loginMsg").textContent = "";
  el("generated").classList.add("hidden");
  el("keys").value = "";
  message("Sesión cerrada.");
};
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.DB) {
      return json({ error: "Falta el binding DB" }, 500);
    }

    await iniciar(env.DB);

    // PANEL WEB
    if (
      (url.pathname === "/" || url.pathname === "/admin") &&
      request.method === "GET"
    ) {
      return new Response(PANEL_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    // RECLAMAR LICENCIA
    if (url.pathname === "/v1/claim" && request.method === "POST") {
      const b = await leer(request);

      if (
        !b ||
        !HEX.test(String(b.h || "")) ||
        !DEV.test(String(b.device || ""))
      ) {
        return json({ ok: false, motivo: "peticion" }, 400);
      }

      return json(await reclamar(env.DB, b.h, b.device));
    }

    // ADMINISTRACIÓN
    if (url.pathname.startsWith("/v1/admin/")) {
      const auth = request.headers.get("authorization") || "";

const adminSecret = env.ADMIN_TOKEN;

if (!adminSecret) {
  return json({
    error: "ADMIN_TOKEN no está disponible en el entorno del Worker",
    diagnostic: "SECRET_MISSING"
  }, 500);
}

if (!auth.startsWith("Bearer ")) {
  return json({
    error: "No llegó el encabezado Authorization",
    diagnostic: "AUTH_HEADER_MISSING"
  }, 401);
}

if (!igual(auth.slice(7).trim(), String(adminSecret).trim())) {
  return json({
    error: "La contraseña recibida no coincide con ADMIN_TOKEN",
    diagnostic: "TOKEN_MISMATCH"
  }, 401);
}
      

      // CREAR TOKENS
      if (
        url.pathname === "/v1/admin/add" &&
        request.method === "POST"
      ) {
        const b = await leer(request);
        const items = b && Array.isArray(b.items)
          ? b.items.slice(0, 200)
          : null;

        if (!items || items.length === 0) {
          return json({ error: "items requerido" }, 400);
        }

        const ahora = new Date().toISOString();
        const stmts = [];

        for (const it of items) {
          if (
            !it ||
            !HEX.test(String(it.h || "")) ||
            !/^[a-z0-9]{4,16}$/.test(String(it.id || ""))
          ) {
            return json({ error: "item no válido" }, 400);
          }

          const dev = it.device
            ? String(it.device).toUpperCase()
            : null;

          if (dev && !DEV.test(dev)) {
            return json({ error: "device no válido" }, 400);
          }

          stmts.push(
            env.DB.prepare(`
              INSERT INTO tokens
              (id, h, device, note, created, expires)
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(
              it.id,
              it.h,
              dev,
              String(it.note || "").slice(0, 80),
              ahora,
              it.expires || null
            )
          );
        }

        try {
          await env.DB.batch(stmts);
        } catch (e) {
          return json({
            error: "No se pudo guardar (¿clave o ID repetido?)"
          }, 409);
        }

        return json({ ok: true, added: stmts.length });
      }

      // LISTAR
      if (
        url.pathname === "/v1/admin/list" &&
        request.method === "GET"
      ) {
        const r = await env.DB.prepare(`
          SELECT id, device, note, created, expires, claimed_at
          FROM tokens ORDER BY created DESC
        `).all();

        return json({ tokens: r.results || [] });
      }

      // ELIMINAR
      if (
        url.pathname === "/v1/admin/remove" &&
        request.method === "POST"
      ) {
        const b = await leer(request);

        if (!b || (!b.id && !b.h)) {
          return json({ error: "id o h requerido" }, 400);
        }

        const r = b.h
          ? await env.DB.prepare(
              "DELETE FROM tokens WHERE h = ?"
            ).bind(String(b.h)).run()
          : await env.DB.prepare(
              "DELETE FROM tokens WHERE id = ?"
            ).bind(String(b.id)).run();

        const n = r.meta && r.meta.changes || 0;

        return json(
          n ? { ok: true } : { ok: false, error: "No encontrada" },
          n ? 200 : 404
        );
      }

      // RESTABLECER
      if (
        url.pathname === "/v1/admin/reset" &&
        request.method === "POST"
      ) {
        const b = await leer(request);

        if (!b || !b.id) {
          return json({ error: "id requerido" }, 400);
        }

        const r = await env.DB.prepare(`
          UPDATE tokens
          SET device = NULL, claimed_at = NULL
          WHERE id = ?
        `).bind(String(b.id)).run();

        const n = r.meta && r.meta.changes || 0;

        return json(
          n ? { ok: true } : { ok: false, error: "No encontrada" },
          n ? 200 : 404
        );
      }
    }

    return json({ error: "No encontrado" }, 404);
  }
};
