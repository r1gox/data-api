# Worker de claves (una clave = un solo equipo)

Gratis en Cloudflare (Workers + D1). Una sola vez:

    npm i -g wrangler
    wrangler login
    cd worker
    wrangler d1 create kinox            # copia el "database_id" que imprime dentro de wrangler.toml
    wrangler secret put ADMIN_TOKEN     # escribe una contraseña larga y aleatoria (solo tú la sabes)
    wrangler deploy                     # imprime la URL: https://kinox-acceso.TU-USUARIO.workers.dev

Después:

1. Pon esa URL en `desktop/acceso-config.json`:  `{ "apiUrl": "https://kinox-acceso.TU-USUARIO.workers.dev" }`
   y vuelve a compilar la app. (La tabla se crea sola en la primera petición.)
2. Para administrar, en tu PC:

       set KINOX_ADMIN_URL=https://kinox-acceso.TU-USUARIO.workers.dev
       set KINOX_ADMIN_TOKEN=la-misma-contraseña
       node admin/tokens.cjs add --note "Juan"
       node admin/tokens.cjs list        (EQUIPO "(sin usar)" = nadie la ha usado todavía)
       node admin/tokens.cjs reset <id>  (si la persona cambió de PC: libera la clave)
       node admin/tokens.cjs remove <id>

Los cambios son inmediatos (no hay caché de GitHub). El Worker guarda solo huellas sha256.
Mientras `apiUrl` esté vacío, la app usa el modo antiguo con `tokens.json` de GitHub.
