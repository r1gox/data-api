/**
 * TMDB Meta API — data-api (Cloudflare Worker)
 * Secrets: TMDB_API_KEY (v3) o TMDB_TOKEN (Bearer v4)
 */

const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    env = env || {};

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/" || path === "/health") {
        const resolved = resolveTmdbKey(env);
        return json({
          ok: true,
          name: "tmdb-meta-api",
          version: "1.0.3",
          has_key: resolved.ok,
          key_source: resolved.source,
          env_keys: Object.keys(env).sort(),
          hint: resolved.ok
            ? null
            : "No hay TMDB_API_KEY en env. Cloudflare → data-api → Settings → Variables and secrets → Add Secret",
        });
      }

      let m = path.match(/^\/v1\/items\/(movie|tv)\/(\d+)$/);
      if (m) {
        const data = await getItem(env, m[1], m[2]);
        return json({ schema_version: 3, generation: 1, item: data }, 200, cacheHeaders(env));
      }

      m = path.match(/^\/v1\/cards\/(movie|tv)\/(\d+)$/);
      if (m) {
        const data = await getItem(env, m[1], m[2]);
        return json({ schema_version: 3, generation: 1, card: data }, 200, cacheHeaders(env));
      }

      if (path === "/v1/search") {
        const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
        const page = Math.min(Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1), 20);
        const type = (url.searchParams.get("type") || "multi").toLowerCase();
        if (!q) return json({ error: "Falta query q" }, 400);
        const data = await search(env, q, page, type);
        return json(data, 200, cacheHeaders(env, 1800));
      }

      if (path === "/v1/now") {
        const type = (url.searchParams.get("type") || "movie").toLowerCase() === "tv" ? "tv" : "movie";
        const data = await nowPlaying(env, type);
        return json(data, 200, cacheHeaders(env, 3600));
      }

      return json({ error: "Not found", path }, 404);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const status = /api key|unauthorized|401|Falta TMDB/i.test(msg) ? 401 : 502;
      return json({ error: msg }, status);
    }
  },
};

function resolveTmdbKey(env) {
  env = env || {};
  const pairs = Object.entries(env);
  let token = "";
  let key = "";
  let source = null;

  for (const [name, val] of pairs) {
    const n = String(name).trim();
    const v = val == null ? "" : String(val).trim();
    if (!v) continue;
    if (/^TMDB_TOKEN$/i.test(n) || /^TMDB_READ_TOKEN$/i.test(n)) {
      token = v;
      source = n;
      break;
    }
  }
  if (!token) {
    for (const [name, val] of pairs) {
      const n = String(name).trim();
      const v = val == null ? "" : String(val).trim();
      if (!v) continue;
      if (/^TMDB_API_KEY$/i.test(n) || /^TMDB_KEY$/i.test(n) || /^API_KEY$/i.test(n)) {
        key = v;
        source = n;
        break;
      }
    }
  }

  if (!token && !key) {
    token = String(env.TMDB_TOKEN || "").trim();
    key = String(env.TMDB_API_KEY || "").trim();
    if (token) source = "TMDB_TOKEN";
    else if (key) source = "TMDB_API_KEY";
  }

  if (token) return { ok: true, source, token, key: "" };
  if (key) return { ok: true, source, token: "", key };
  return { ok: false, source: null, token: "", key: "" };
}

function authHeaders(env) {
  const { token } = resolveTmdbKey(env);
  if (token) return { Authorization: "Bearer " + token, Accept: "application/json" };
  return { Accept: "application/json" };
}

function withKey(env, pathAndQuery) {
  const u = new URL(pathAndQuery.startsWith("http") ? pathAndQuery : TMDB_API + pathAndQuery);
  const { token, key } = resolveTmdbKey(env);
  if (!token && key) u.searchParams.set("api_key", key);
  if (!u.searchParams.has("language")) u.searchParams.set("language", "es-ES");
  return u.toString();
}

async function tmdb(env, pathAndQuery) {
  const resolved = resolveTmdbKey(env);
  if (!resolved.ok) {
    throw new Error(
      "Falta TMDB_API_KEY en el Worker. env_keys=" +
        JSON.stringify(Object.keys(env || {})) +
        ". Cloudflare → data-api → Settings → Variables and secrets → Add Secret TMDB_API_KEY"
    );
  }
  const res = await fetch(withKey(env, pathAndQuery), {
    headers: authHeaders(env),
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("TMDB respuesta no JSON (" + res.status + ")");
  }
  if (!res.ok) {
    throw new Error(data.status_message || (data.errors && data.errors[0]) || "TMDB HTTP " + res.status);
  }
  return data;
}

async function getItem(env, kind, id) {
  const d = await tmdb(
    env,
    "/" + kind + "/" + id + "?append_to_response=images,external_ids&include_image_language=en,null"
  );

  const poster = d.poster_path || null;
  const backdrop = d.backdrop_path || null;
  let logo = null;
  const logos = (d.images && d.images.logos) || [];
  if (logos.length) {
    const en = logos.find(function (x) { return x.iso_639_1 === "en"; }) || logos[0];
    logo = en.file_path || null;
  }

  const year =
    kind === "movie"
      ? (d.release_date || "").slice(0, 4) || null
      : (d.first_air_date || "").slice(0, 4) || null;

  const title = kind === "movie" ? d.title : d.name;
  const original = kind === "movie" ? d.original_title : d.original_name;

  return {
    tmdb_id: d.id,
    kind: kind,
    title: title || original || String(id),
    original_title: original || null,
    slug: slugify(title || original || String(id)),
    poster_path: poster,
    backdrop_path: backdrop,
    logo_path: logo,
    portada: poster ? TMDB_IMG + "/w500" + poster : null,
    backdrop: backdrop ? TMDB_IMG + "/w780" + backdrop : null,
    logo: logo ? TMDB_IMG + "/original" + logo : null,
    year: year,
    runtime: kind === "movie" ? d.runtime || null : (d.episode_run_time && d.episode_run_time[0]) || null,
    vote_average: d.vote_average != null ? d.vote_average : null,
    popularity: d.popularity != null ? d.popularity : null,
    overview: d.overview || null,
    tagline: d.tagline || null,
    release_date: d.release_date || null,
    first_air_date: d.first_air_date || null,
    last_air_date: d.last_air_date || null,
    status: d.status || null,
    original_language: d.original_language || null,
    number_of_seasons: d.number_of_seasons != null ? d.number_of_seasons : null,
    number_of_episodes: d.number_of_episodes != null ? d.number_of_episodes : null,
    imdb_id: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || null,
    genres: (d.genres || []).map(function (g) {
      return { id: g.id, slug: slugify(g.name), title: g.name };
    }),
    countries: (d.production_countries || []).map(function (c) {
      return { id: null, slug: (c.iso_3166_1 || "").toLowerCase(), title: c.name };
    }),
    studios: (d.production_companies || []).slice(0, 12).map(function (c) {
      return { id: c.id, slug: slugify(c.name), title: c.name };
    }),
  };
}

async function search(env, q, page, type) {
  var endpoint = "/search/multi";
  if (type === "movie") endpoint = "/search/movie";
  if (type === "tv") endpoint = "/search/tv";

  const d = await tmdb(
    env,
    endpoint + "?query=" + encodeURIComponent(q) + "&page=" + page + "&include_adult=false"
  );

  const items = (d.results || [])
    .map(function (r) {
      if (r.media_type === "person") return null;
      var kind =
        r.media_type === "tv" || type === "tv"
          ? "tv"
          : r.media_type === "movie" || type === "movie"
            ? "movie"
            : r.title
              ? "movie"
              : "tv";
      if (kind !== "movie" && kind !== "tv") return null;
      var title = kind === "movie" ? r.title : r.name;
      var original = kind === "movie" ? r.original_title : r.original_name;
      var date = kind === "movie" ? r.release_date : r.first_air_date;
      var poster = r.poster_path || null;
      return {
        tmdb_id: r.id,
        kind: kind,
        title: title || original || "",
        original_title: original || null,
        slug: slugify(title || original || String(r.id)),
        poster_path: poster,
        portada: poster ? TMDB_IMG + "/w500" + poster : null,
        year: (date || "").slice(0, 4) || null,
        vote_average: r.vote_average != null ? r.vote_average : null,
        overview: r.overview || null,
      };
    })
    .filter(Boolean);

  return {
    schema_version: 3,
    generation: 1,
    query: q,
    page: d.page || page,
    total: d.total_results != null ? d.total_results : items.length,
    total_pages: d.total_pages != null ? d.total_pages : 1,
    items: items,
  };
}

async function nowPlaying(env, type) {
  var path = type === "tv" ? "/tv/on_the_air?page=1" : "/movie/now_playing?page=1";
  const d = await tmdb(env, path);
  const items = (d.results || []).slice(0, 20).map(function (r) {
    var title = type === "tv" ? r.name : r.title;
    var poster = r.poster_path || null;
    return {
      tmdb_id: r.id,
      kind: type,
      title: title,
      slug: slugify(title || String(r.id)),
      poster_path: poster,
      portada: poster ? TMDB_IMG + "/w500" + poster : null,
      year: ((type === "tv" ? r.first_air_date : r.release_date) || "").slice(0, 4) || null,
      vote_average: r.vote_average != null ? r.vote_average : null,
    };
  });
  return { schema_version: 3, generation: 1, type: type, items: items };
}

function slugify(s) {
  return (
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

function cacheHeaders(env, ttlSec) {
  var ttl = Number(env.CACHE_TTL) || ttlSec || 21600;
  return {
    "Cache-Control": "public, max-age=" + Math.min(ttl, 3600) + ", s-maxage=" + ttl,
  };
}

function json(body, status, extra) {
  status = status || 200;
  extra = extra || {};
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      CORS,
      extra
    ),
  });
}
