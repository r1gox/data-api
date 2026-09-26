# tmdb-meta-api

API de metadatos estilo Hackstore (`/v1/items/...`) usando **solo TMDB oficial**.

## Desplegar (Cloudflare Worker)

```bash
cd tmdb-meta-api
npm i -g wrangler   # si no lo tienes
wrangler login
wrangler secret put TMDB_API_KEY
# pega tu key NUEVA (no la que filtraste en el chat)
wrangler deploy
```

## Endpoints

| Ruta | Descripción |
|------|-------------|
| `GET /health` | Estado |
| `GET /v1/items/movie/:id` | Ficha película (TMDB id) |
| `GET /v1/items/tv/:id` | Ficha serie |
| `GET /v1/cards/movie/:id` | Misma ficha como `card` |
| `GET /v1/search?q=matrix&type=multi` | Búsqueda |
| `GET /v1/now?type=movie` | Estrenos / al aire |

## Ejemplo

```bash
curl "https://tmdb-meta-api.<tu-subdomain>.workers.dev/v1/items/movie/1419406"
```

Portada lista en el JSON: `portada`, `backdrop`, `logo`.

## Seguridad

- Nunca pongas la API key en el frontend ni en GitHub.
- Si ya pegaste una key en un chat, **regenerala** en TMDB.
