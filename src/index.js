/**
 * TMDB Meta API — data-api (Cloudflare Worker)
 * Películas / series / anime: ficha rica + episodios (título, imagen, overview)
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
          version: "1.1.0",
          has_key: resolved.ok,
          key_source: resolved.source,
          env_keys: Object.keys(env).sort(),
          endpoints: [
            "GET /v1/search?q=&type=multi|movie|tv",
            "GET /v1/items/movie/:id",
            "GET /v1/items/tv/:id",
            "GET /v1/items/tv/:id?episodes=1",
            "GET /v1/items/tv/:id/season/:n",
            "GET /v1/now?type=movie|tv",
          ],
          hint: resolved.ok
            ? null
            : "Falta TMDB_API_KEY. Cloudflare → data-api → Secrets",
        });
      }

      // Temporada completa: /v1/items/tv/207468/season/1
      let m = path.match(/^\/v1\/items\/tv\/(\d+)\/season\/(\d+)$/);
      if (m) {
        const data = await getSeason(env, m[1], m[2]);
        return json({ schema_version: 3, generation: 1, season: data }, 200, cacheHeaders(env));
      }

      m = path.match(/^\/v1\/items\/(movie|tv)\/(\d+)$/);
      if (m) {
        const withEpisodes =
          url.searchParams.get("episodes") === "1" ||
          url.searchParams.get("episodes") === "true" ||
          url.searchParams.get("full") === "1";
        const maxSeasons = parseInt(url.searchParams.get("max_seasons") || "20", 10) || 20;
        const data = await getItem(env, m[1], m[2], { withEpisodes, maxSeasons });
        return json({ schema_version: 3, generation: 1, item: data }, 200, cacheHeaders(env));
      }

      m = path.match(/^\/v1\/cards\/(movie|tv)\/(\d+)$/);
      if (m) {
        const data = await getItem(env, m[1], m[2], { withEpisodes: false });
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

  // TEMPORAL — borrar cuando el Secret de Cloudflare funcione + regenerar key
  if (!token && !key) {
    key = "f5149878cdff80ef89d0910a73750279";
    source = "HARDCODED_TEMP";
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
        JSON.stringify(Object.keys(env || {}))
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

function img(path, size) {
  if (!path) return null;
  return TMDB_IMG + "/" + (size || "w500") + path;
}

function pickLogo(images) {
  const logos = (images && images.logos) || [];
  if (!logos.length) return null;
  const en = logos.find(function (x) { return x.iso_639_1 === "en"; }) || logos[0];
  return en.file_path || null;
}

function pickTrailer(videos) {
  const list = (videos && videos.results) || [];
  const yt = list.filter(function (v) {
    return v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser");
  });
  const pick = yt.find(function (v) { return v.type === "Trailer" && v.official; }) ||
    yt.find(function (v) { return v.type === "Trailer"; }) ||
    yt[0] ||
    list.find(function (v) { return v.site === "YouTube"; });
  if (!pick) return { trailer: null, trailer_youtube_key: null };
  return {
    trailer: "https://www.youtube.com/watch?v=" + pick.key,
    trailer_youtube_key: pick.key,
  };
}

function mapCast(credits) {
  return ((credits && credits.cast) || []).slice(0, 20).map(function (c) {
    return {
      id: c.id,
      name: c.name,
      character: c.character || null,
      profile: img(c.profile_path, "w185"),
      order: c.order,
    };
  });
}

function mapCrew(credits) {
  const want = /director|writer|creator|screenplay|composer|producer/i;
  return ((credits && credits.crew) || [])
    .filter(function (c) { return want.test(c.job || ""); })
    .slice(0, 15)
    .map(function (c) {
      return { id: c.id, name: c.name, job: c.job, department: c.department || null };
    });
}

function mapEpisode(ep, seasonNum) {
  const still = ep.still_path || null;
  return {
    temporada: seasonNum != null ? seasonNum : ep.season_number,
    episodio: ep.episode_number,
    season: seasonNum != null ? seasonNum : ep.season_number,
    episode: ep.episode_number,
    titulo: ep.name || ("Episodio " + ep.episode_number),
    name: ep.name || null,
    overview: ep.overview || null,
    air_date: ep.air_date || null,
    runtime: ep.runtime != null ? ep.runtime : null,
    vote_average: ep.vote_average != null ? ep.vote_average : null,
    still_path: still,
    imagen: img(still, "w300"),
    back_img: img(still, "w300"),
    portada_episodio: img(still, "w500"),
  };
}

async function getSeason(env, tvId, seasonNum) {
  const d = await tmdb(env, "/tv/" + tvId + "/season/" + seasonNum);
  const episodes = (d.episodes || []).map(function (ep) {
    return mapEpisode(ep, Number(seasonNum));
  });
  return {
    tmdb_id: Number(tvId),
    season_number: d.season_number != null ? d.season_number : Number(seasonNum),
    name: d.name || ("Temporada " + seasonNum),
    overview: d.overview || null,
    air_date: d.air_date || null,
    poster: img(d.poster_path, "w300"),
    poster_path: d.poster_path || null,
    episode_count: episodes.length,
    episodes: episodes,
    lista: episodes,
  };
}

async function getItem(env, kind, id, opts) {
  opts = opts || {};
  const append =
    kind === "movie"
      ? "credits,images,videos,keywords,external_ids,release_dates"
      : "credits,images,videos,keywords,external_ids,content_ratings";

  const d = await tmdb(
    env,
    "/" + kind + "/" + id +
      "?append_to_response=" + append +
      "&include_image_language=en,es,null"
  );

  const poster = d.poster_path || null;
  const backdrop = d.backdrop_path || null;
  const logo = pickLogo(d.images);
  const trail = pickTrailer(d.videos);

  const year =
    kind === "movie"
      ? (d.release_date || "").slice(0, 4) || null
      : (d.first_air_date || "").slice(0, 4) || null;

  const title = kind === "movie" ? d.title : d.name;
  const original = kind === "movie" ? d.original_title : d.original_name;

  // Certification
  let certification = null;
  if (kind === "movie" && d.release_dates && d.release_dates.results) {
    const us = d.release_dates.results.find(function (r) { return r.iso_3166_1 === "US"; });
    const mx = d.release_dates.results.find(function (r) { return r.iso_3166_1 === "MX"; });
    const block = mx || us || d.release_dates.results[0];
    const rel = ((block && block.release_dates) || []).find(function (x) { return x.certification; });
    certification = (rel && rel.certification) || null;
  }
  if (kind === "tv" && d.content_ratings && d.content_ratings.results) {
    const mx = d.content_ratings.results.find(function (r) { return r.iso_3166_1 === "MX"; });
    const us = d.content_ratings.results.find(function (r) { return r.iso_3166_1 === "US"; });
    const block = mx || us || d.content_ratings.results[0];
    certification = (block && block.rating) || null;
  }

  const gallery = ((d.images && d.images.backdrops) || []).slice(0, 12).map(function (b) {
    return { path: b.file_path, url: img(b.file_path, "w780") };
  });

  const item = {
    tmdb_id: d.id,
    kind: kind,
    title: title || original || String(id),
    original_title: original || null,
    slug: slugify(title || original || String(id)),
    poster_path: poster,
    backdrop_path: backdrop,
    logo_path: logo,
    portada: img(poster, "w500"),
    backdrop: img(backdrop, "w780"),
    logo: img(logo, "original"),
    year: year,
    runtime: kind === "movie" ? d.runtime || null : (d.episode_run_time && d.episode_run_time[0]) || null,
    vote_average: d.vote_average != null ? d.vote_average : null,
    vote_count: d.vote_count != null ? d.vote_count : null,
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
    external_ids: d.external_ids || null,
    certification: certification,
    genres: (d.genres || []).map(function (g) {
      return { id: g.id, slug: slugify(g.name), title: g.name };
    }),
    countries: (d.production_countries || []).map(function (c) {
      return { id: null, slug: (c.iso_3166_1 || "").toLowerCase(), title: c.name };
    }),
    studios: (d.production_companies || []).slice(0, 12).map(function (c) {
      return { id: c.id, slug: slugify(c.name), title: c.name };
    }),
    networks: (d.networks || []).map(function (n) {
      return { id: n.id, name: n.name, logo: img(n.logo_path, "w154") };
    }),
    cast: mapCast(d.credits),
    crew: mapCrew(d.credits),
    keywords: ((d.keywords && (d.keywords.keywords || d.keywords.results)) || []).slice(0, 20).map(function (k) {
      return { id: k.id, name: k.name };
    }),
    trailer: trail.trailer,
    trailer_youtube_key: trail.trailer_youtube_key,
    gallery: gallery,
  };

  // Series / anime: lista de temporadas (+ episodios si ?episodes=1)
  if (kind === "tv") {
    const seasonsMeta = (d.seasons || [])
      .filter(function (s) { return s.season_number > 0; })
      .map(function (s) {
        return {
          temporada: s.season_number,
          season_number: s.season_number,
          name: s.name || ("Temporada " + s.season_number),
          episode_count: s.episode_count || 0,
          air_date: s.air_date || null,
          overview: s.overview || null,
          poster: img(s.poster_path, "w300"),
        };
      });
    item.seasons = seasonsMeta;
    item.temporadas_meta = seasonsMeta;

    if (opts.withEpisodes) {
      const maxS = Math.min(opts.maxSeasons || 20, seasonsMeta.length || 0);
      const toFetch = seasonsMeta.slice(0, maxS);
      const seasonsFull = [];
      // Paralelo por lotes de 4 (límite Worker)
      for (let i = 0; i < toFetch.length; i += 4) {
        const batch = toFetch.slice(i, i + 4);
        const parts = await Promise.all(
          batch.map(function (s) {
            return getSeason(env, id, s.season_number).catch(function () {
              return {
                temporada: s.season_number,
                season_number: s.season_number,
                name: s.name,
                episodes: [],
                lista: [],
                episode_count: 0,
              };
            });
          })
        );
        for (let j = 0; j < parts.length; j++) seasonsFull.push(parts[j]);
      }
      item.temporadas = seasonsFull.map(function (s) {
        return {
          temporada: s.season_number,
          episodios: (s.episodes || []).length,
          lista: s.episodes || s.lista || [],
          name: s.name,
          poster: s.poster,
        };
      });
      // Lista plana de episodios
      item.episodios = [];
      seasonsFull.forEach(function (s) {
        (s.episodes || []).forEach(function (ep) {
          item.episodios.push(ep);
        });
      });
      item.total_episodios_listados = item.episodios.length;
    }
  }

  return item;
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
        portada: img(poster, "w500"),
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
      portada: img(poster, "w500"),
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
      {
        "Content-Type": "application/json; charset=utf-8",
      },
      CORS,
      extra
    ),
  });
}
