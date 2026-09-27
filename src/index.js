/**
 * TMDB Meta API — data-api (Cloudflare Worker) v1.2
 * Películas / series / anime: ficha rica, episodios, especiales (S0), OVA/películas relacionadas
 * Secrets: TMDB_API_KEY (v3) o TMDB_TOKEN (v4)
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
          version: "1.3.0-moviezone",
          has_key: resolved.ok,
          key_source: resolved.source,
          env_keys: Object.keys(env).sort(),
          endpoints: [
            "GET /v1/search?q=&type=multi|movie|tv",
            "GET /v1/items/movie/:id",
            "GET /v1/items/tv/:id",
            "GET /v1/items/tv/:id?episodes=1",
            "GET /v1/items/tv/:id?specials=1",
            "GET /v1/items/tv/:id?related=1",
            "GET /v1/items/tv/:id/season/:n  (0 = especiales)",
            "GET /v1/items/tv/:id/specials",
            "GET /v1/now?type=movie|tv",
          ],
          hint: resolved.ok
            ? null
            : "Falta TMDB_API_KEY en Cloudflare Secrets",
        });
      }

      // Especiales = temporada 0
      let m = path.match(/^\/v1\/items\/tv\/(\d+)\/specials$/);
      if (m) {
        const data = await getSeason(env, m[1], 0);
        data.es_especiales = true;
        data.formato = "Especiales";
        return json({
          success: true,
          fuente: "tmdb",
          source_id: "tmdb",
          tipo: "Especiales",
          tmdb_id: Number(m[1]),
          temporada: 0,
          episodios: data.episode_count,
          lista: (data.episodes || []).map(epToMzLista),
          season: data,
          schema_version: 3,
        }, 200, cacheHeaders(env));
      }

      m = path.match(/^\/v1\/items\/tv\/(\d+)\/season\/(\d+)$/);
      if (m) {
        const data = await getSeason(env, m[1], m[2]);
        if (Number(m[2]) === 0) {
          data.es_especiales = true;
          data.formato = "Especiales";
        }
        return json({
          success: true,
          fuente: "tmdb",
          source_id: "tmdb",
          tipo: Number(m[2]) === 0 ? "Especiales" : "Temporada",
          tmdb_id: Number(m[1]),
          temporada: data.season_number,
          episodios: data.episode_count,
          lista: (data.episodes || []).map(epToMzLista),
          season: data,
          schema_version: 3,
        }, 200, cacheHeaders(env));
      }

      m = path.match(/^\/v1\/items\/(movie|tv)\/(\d+)$/);
      if (m) {
        const withEpisodes =
          url.searchParams.get("episodes") === "1" ||
          url.searchParams.get("episodes") === "true" ||
          url.searchParams.get("full") === "1";
        const withSpecials =
          withEpisodes ||
          url.searchParams.get("specials") === "1" ||
          url.searchParams.get("specials") === "true";
        const withRelated =
          url.searchParams.get("related") === "1" ||
          url.searchParams.get("related") === "true" ||
          withEpisodes;
        const maxSeasons = parseInt(url.searchParams.get("max_seasons") || "30", 10) || 30;
        const data = await getItem(env, m[1], m[2], {
          withEpisodes,
          withSpecials,
          withRelated,
          maxSeasons,
        });
        // Formato compatible con vimeos-resolver / MovieZone
        const mz = toMovieZone(data, m[1], {
          withEpisodes: withEpisodes || withSpecials,
        });
        return json(mz, 200, cacheHeaders(env));
      }

      m = path.match(/^\/v1\/cards\/(movie|tv)\/(\d+)$/);
      if (m) {
        const data = await getItem(env, m[1], m[2], { withEpisodes: false });
        return json({ schema_version: 3, generation: 1, card: data }, 200, cacheHeaders(env));
      }

      if (path === "/v1/search") {
        let q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
        // slug estilo animeav1 → texto buscable
        if (q && /-/.test(q) && !/\s/.test(q)) {
          q = q.replace(/-/g, " ");
        }
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

  // TEMP — quitar cuando Secret CF funcione; regenerar key en TMDB
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
    throw new Error("Falta TMDB_API_KEY. env_keys=" + JSON.stringify(Object.keys(env || {})));
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
  const en = logos.find(function (x) { return x.iso_639_1 === "en"; }) ||
    logos.find(function (x) { return x.iso_639_1 === "ja"; }) ||
    logos[0];
  return en.file_path || null;
}

function pickTrailer(videos) {
  const list = (videos && videos.results) || [];
  const yt = list.filter(function (v) {
    return v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser");
  });
  const pick =
    yt.find(function (v) { return v.type === "Trailer" && v.official; }) ||
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

/** Clasifica tipo anime/serie según TMDB + keywords */
function detectFormato(kind, d, keywords) {
  if (kind === "movie") {
    const rt = d.runtime || 0;
    const kws = (keywords || []).map(function (k) { return (k.name || "").toLowerCase(); }).join(" ");
    if (/ova/.test(kws) || /ova/i.test(d.title || "") || /ova/i.test(d.original_title || "")) return "OVA";
    if (/ona/.test(kws)) return "ONA";
    if (rt > 0 && rt < 45) return "Especial";
    return "Pelicula";
  }
  // tv
  const types = (d.type || "").toLowerCase(); // Scripted, Miniseries, etc.
  const kws = (keywords || []).map(function (k) { return (k.name || "").toLowerCase(); }).join(" ");
  if (/ova/.test(kws)) return "OVA";
  if (/ona/.test(kws)) return "ONA";
  if (types === "miniseries") return "Miniserie";
  if ((d.number_of_episodes || 0) <= 1 && (d.number_of_seasons || 0) <= 1) return "Especial";
  return "TV";
}

function mapEpisode(ep, seasonNum) {
  const still = ep.still_path || null;
  const sn = seasonNum != null ? Number(seasonNum) : Number(ep.season_number);
  const en = Number(ep.episode_number);
  const isSpecial = sn === 0;
  const titulo =
    ep.name && String(ep.name).trim() && !/^episodio\s*\d+$/i.test(ep.name)
      ? ep.name
      : isSpecial
        ? "Especial " + en
        : "Episodio " + en;

  return {
    temporada: sn,
    episodio: en,
    season: sn,
    episode: en,
    titulo: titulo,
    name: ep.name || null,
    overview: ep.overview || null,
    air_date: ep.air_date || null,
    runtime: ep.runtime != null ? ep.runtime : null,
    vote_average: ep.vote_average != null ? ep.vote_average : null,
    still_path: still,
    imagen: img(still, "w300"),
    back_img: img(still, "w300"),
    portada_episodio: img(still, "w500"),
    es_especial: isSpecial,
    formato: isSpecial ? "Especial" : "Episodio",
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
    temporada: d.season_number != null ? d.season_number : Number(seasonNum),
    name: d.name || (Number(seasonNum) === 0 ? "Especiales" : "Temporada " + seasonNum),
    overview: d.overview || null,
    air_date: d.air_date || null,
    poster: img(d.poster_path, "w300"),
    poster_path: d.poster_path || null,
    episode_count: episodes.length,
    episodios: episodes.length,
    episodes: episodes,
    lista: episodes,
  };
}

async function fetchRelatedMovies(env, tvId, title) {
  const out = [];
  const seen = {};

  function pushMovie(r, source) {
    if (!r || !r.id || seen[r.id]) return;
    seen[r.id] = true;
    const poster = r.poster_path || null;
    out.push({
      tmdb_id: r.id,
      kind: "movie",
      title: r.title || r.original_title || "",
      original_title: r.original_title || null,
      slug: slugify(r.title || r.original_title || String(r.id)),
      portada: img(poster, "w500"),
      poster_path: poster,
      year: (r.release_date || "").slice(0, 4) || null,
      vote_average: r.vote_average != null ? r.vote_average : null,
      overview: r.overview || null,
      source: source,
      formato: detectFormato("movie", r, []),
    });
  }

  try {
    const rec = await tmdb(env, "/tv/" + tvId + "/recommendations?page=1");
    (rec.results || []).slice(0, 8).forEach(function (r) {
      // recommendations for TV returns TV mostly — skip non-movie
      if (r.media_type === "movie" || r.title) pushMovie(r, "recommendations");
    });
  } catch (_) {}

  // Búsqueda por título + palabras clave de película/OVA
  if (title) {
    const base = String(title).replace(/:.*$/, "").trim();
    const queries = [base + " movie", base + " film", base + " OVA"];
    for (let i = 0; i < queries.length; i++) {
      try {
        const s = await tmdb(
          env,
          "/search/movie?query=" + encodeURIComponent(queries[i]) + "&page=1&include_adult=false"
        );
        (s.results || []).slice(0, 5).forEach(function (r) {
          // filtrar por similitud simple del título
          const t = (r.title || "").toLowerCase();
          const b = base.toLowerCase();
          if (t.indexOf(b.slice(0, Math.min(8, b.length))) >= 0 || b.indexOf(t.slice(0, 8)) >= 0) {
            pushMovie(r, "search");
          }
        });
      } catch (_) {}
    }
  }

  return out.slice(0, 12);
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
      "&include_image_language=en,es,ja,null"
  );

  const poster = d.poster_path || null;
  const backdrop = d.backdrop_path || null;
  const logo = pickLogo(d.images);
  const trail = pickTrailer(d.videos);
  const keywordsList = (d.keywords && (d.keywords.keywords || d.keywords.results)) || [];

  const year =
    kind === "movie"
      ? (d.release_date || "").slice(0, 4) || null
      : (d.first_air_date || "").slice(0, 4) || null;

  const title = kind === "movie" ? d.title : d.name;
  const original = kind === "movie" ? d.original_title : d.original_name;
  const formato = detectFormato(kind, d, keywordsList);

  let certification = null;
  if (kind === "movie" && d.release_dates && d.release_dates.results) {
    const mx = d.release_dates.results.find(function (r) { return r.iso_3166_1 === "MX"; });
    const us = d.release_dates.results.find(function (r) { return r.iso_3166_1 === "US"; });
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
    formato: formato,
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
    keywords: keywordsList.slice(0, 20).map(function (k) {
      return { id: k.id, name: k.name };
    }),
    trailer: trail.trailer,
    trailer_youtube_key: trail.trailer_youtube_key,
    gallery: gallery,
  };

  if (kind === "tv") {
    const allSeasons = d.seasons || [];
    const specialsMeta = allSeasons
      .filter(function (s) { return s.season_number === 0; })
      .map(function (s) {
        return {
          temporada: 0,
          season_number: 0,
          name: s.name || "Especiales",
          episode_count: s.episode_count || 0,
          air_date: s.air_date || null,
          overview: s.overview || null,
          poster: img(s.poster_path, "w300"),
          es_especiales: true,
          formato: "Especiales",
        };
      });

    const seasonsMeta = allSeasons
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
          es_especiales: false,
          formato: "TV",
        };
      });

    item.seasons = seasonsMeta;
    item.temporadas_meta = seasonsMeta;
    item.specials_meta = specialsMeta;
    item.tiene_especiales = specialsMeta.length > 0 && (specialsMeta[0].episode_count || 0) > 0;

    // Cargar especiales (S0)
    if (opts.withSpecials && item.tiene_especiales) {
      try {
        const sp = await getSeason(env, id, 0);
        item.especiales = sp;
        item.specials = sp.episodes || [];
      } catch (_) {
        item.especiales = null;
        item.specials = [];
      }
    }

    // Episodios de temporadas regulares
    if (opts.withEpisodes) {
      const maxS = Math.min(opts.maxSeasons || 30, seasonsMeta.length || 0);
      const toFetch = seasonsMeta.slice(0, maxS);
      const seasonsFull = [];
      for (let i = 0; i < toFetch.length; i += 4) {
        const batch = toFetch.slice(i, i + 4);
        const parts = await Promise.all(
          batch.map(function (s) {
            return getSeason(env, id, s.season_number).catch(function () {
              return {
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
      item.episodios = [];
      seasonsFull.forEach(function (s) {
        (s.episodes || []).forEach(function (ep) {
          item.episodios.push(ep);
        });
      });
      // Especiales al inicio de la lista plana si se pidieron
      if (item.specials && item.specials.length) {
        item.episodios = item.specials.concat(item.episodios);
      }
      item.total_episodios_listados = item.episodios.length;
    }

    // Películas / OVA relacionados
    if (opts.withRelated) {
      try {
        item.related_movies = await fetchRelatedMovies(env, id, title || original);
        item.ovas_peliculas = item.related_movies;
      } catch (_) {
        item.related_movies = [];
        item.ovas_peliculas = [];
      }
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
      var rt = r.runtime || 0;
      var formato = kind === "movie" ? (rt > 0 && rt < 45 ? "Especial" : "Pelicula") : "TV";
      return {
        tmdb_id: r.id,
        kind: kind,
        formato: formato,
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


/** Episodio → shape MovieZone / vimeos lista[] */
function epToMzLista(ep) {
  return {
    temporada: ep.temporada != null ? ep.temporada : ep.season,
    episodio: ep.episodio != null ? ep.episodio : ep.episode,
    titulo: ep.titulo || ep.name || null,
    slug: null,
    link: null,
    back_img: ep.back_img || ep.imagen || ep.portada_episodio || null,
    imagen: ep.imagen || ep.back_img || null,
    overview: ep.overview || null,
    air_date: ep.air_date || null,
    runtime: ep.runtime != null ? ep.runtime : null,
    es_especial: !!ep.es_especial,
  };
}

function mapEstadoTmdb(status) {
  const s = String(status || "").toLowerCase();
  if (s === "returning series" || s === "in production") return "En emisión";
  if (s === "ended") return "Finalizado";
  if (s === "canceled" || s === "cancelled") return "Cancelado";
  if (s === "planned") return "Próximamente";
  if (s === "rumored") return "Rumoreado";
  return status || null;
}

function mapTipoMovieZone(kind, item) {
  if (kind === "movie") return "Pelicula";
  const gens = (item.genres || []).map(function (g) {
    return String(g.title || g.name || "").toLowerCase();
  }).join(" ");
  const kws = (item.keywords || []).map(function (k) {
    return String(k.name || "").toLowerCase();
  }).join(" ");
  const lang = String(item.original_language || "");
  if (
    /animaci[oó]n|animation/.test(gens) ||
    /anime/.test(kws) ||
    lang === "ja"
  ) {
    return "Anime";
  }
  return "Serie";
}

/**
 * Convierte item TMDB rico → JSON compatible con vimeos-resolver / MovieZone
 */
function toMovieZone(item, kind, opts) {
  opts = opts || {};
  const tipo = mapTipoMovieZone(kind, item);
  const generos = (item.genres || []).map(function (g) {
    return g.title || g.name || "";
  }).filter(Boolean);

  const rating =
    item.vote_average != null ? Math.round(Number(item.vote_average) * 10) / 10 : null;

  const fecha =
    item.release_date || item.first_air_date || null;

  const dur =
    item.runtime != null
      ? item.runtime + (kind === "tv" ? " min. por episodio" : " min")
      : null;

  const out = {
    success: true,
    fuente: "tmdb",
    source_id: "tmdb",
    tipo: tipo,
    formato: item.formato || (kind === "movie" ? "Pelicula" : "TV"),
    link: null,
    slug: item.slug || null,
    tmdb_id: item.tmdb_id,
    titulo: item.title || null,
    titulo_original: item.original_title || null,
    portada: item.portada || null,
    portada_imdb: item.portada || null,
    logo: item.logo || null,
    logo_imdb: item.logo || null,
    backdrop: item.backdrop || null,
    portada_fuente_raw: item.portada || null,
    descripcion: item.overview || null,
    year: item.year || null,
    fecha_estreno: fecha,
    rating: rating,
    rating_source: "imdb",
    rating_imdb: rating,
    generos: generos,
    duracion_texto: dur,
    estado: kind === "tv" ? mapEstadoTmdb(item.status) : null,
    imdb_id: item.imdb_id || null,
    poster_source: "tmdb",
    url_extract: null,
    certification: item.certification || null,
    trailer: item.trailer || null,
    trailer_youtube_key: item.trailer_youtube_key || null,
    actores: (item.cast || []).slice(0, 15).map(function (c) {
      return c.name;
    }),
    cast: item.cast || [],
    studios: (item.studios || []).map(function (s) {
      return s.title || s.name;
    }),
    // extras TMDB (MovieZone puede ignorarlos)
    gallery: item.gallery || [],
    keywords: item.keywords || [],
    external_ids: item.external_ids || null,
    schema_version: 3,
    generation: 1,
  };

  if (kind === "movie") {
    out.total = 0;
    out.reproductores = [];
  }

  if (kind === "tv") {
    const temporadas = [];

    // Especiales S0 primero si hay
    if (item.especiales && (item.especiales.episodes || []).length) {
      const lista = (item.especiales.episodes || []).map(epToMzLista);
      temporadas.push({
        temporada: 0,
        episodios: lista.length,
        lista: lista,
        name: "Especiales",
        formato: "Especiales",
      });
    }

    if (item.temporadas && item.temporadas.length) {
      item.temporadas.forEach(function (t) {
        const lista = (t.lista || []).map(epToMzLista);
        temporadas.push({
          temporada: t.temporada,
          episodios: lista.length || t.episodios || 0,
          lista: lista,
          name: t.name || ("Temporada " + t.temporada),
        });
      });
    } else if (item.temporadas_meta && item.temporadas_meta.length) {
      // Sin ?episodes=1: solo meta (conteos), lista vacía
      item.temporadas_meta.forEach(function (t) {
        temporadas.push({
          temporada: t.temporada,
          episodios: t.episode_count || 0,
          lista: [],
          name: t.name || ("Temporada " + t.temporada),
        });
      });
    }

    out.temporadas = temporadas;
    out.total_temporadas =
      item.number_of_seasons != null
        ? item.number_of_seasons
        : temporadas.filter(function (t) { return t.temporada > 0; }).length;
    out.total_episodios =
      item.number_of_episodes != null
        ? item.number_of_episodes
        : temporadas.reduce(function (a, t) {
            return a + (t.episodios || 0);
          }, 0);

    // related OVA / movies
    if (item.related_movies && item.related_movies.length) {
      out.ovas_peliculas = item.related_movies.map(function (m) {
        return {
          tmdb_id: m.tmdb_id,
          tipo: "Pelicula",
          formato: m.formato || "Pelicula",
          titulo: m.title,
          titulo_original: m.original_title,
          slug: m.slug,
          portada: m.portada,
          year: m.year,
          rating: m.vote_average,
          descripcion: m.overview,
        };
      });
    }

    if (item.tiene_especiales != null) {
      out.tiene_especiales = item.tiene_especiales;
    }
  }

  // item rico por si se necesita
  out.item = item;
  return out;
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
