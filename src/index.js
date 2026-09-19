/**
 * MovieZone Data API — IDs y meta (anime / series / películas)
 * Deploy: Cloudflare Worker
 *
 * Env opcional: TMDB_API_KEY
 */

const CINEMETA = 'https://v3-cinemeta.strem.io';
const ANIZIP = 'https://api.ani.zip/mappings';
const JIKAN = 'https://api.jikan.moe/v4';
const TMDB = 'https://api.themoviedb.org/3';
const METAHUB = 'https://images.metahub.space';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    },
  });
}

function metahubImages(imdbId) {
  if (!imdbId || !/^tt\d+$/i.test(imdbId)) return null;
  return {
    poster: `${METAHUB}/poster/medium/${imdbId}/img`,
    backdrop: `${METAHUB}/background/medium/${imdbId}/img`,
    logo: `${METAHUB}/logo/medium/${imdbId}/img`,
  };
}

async function fromAnizipMal(malId) {
  const res = await fetch(`${ANIZIP}?mal_id=${encodeURIComponent(malId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const m = data.mappings || data;
  if (!m) return null;

  let imdb_season = null;
  const eps = data.episodes;
  if (eps && typeof eps === 'object') {
    for (const k of Object.keys(eps)) {
      if (eps[k]?.seasonNumber != null) {
        imdb_season = Number(eps[k].seasonNumber);
        break;
      }
    }
  }

  return {
    mal_id: m.mal_id || Number(malId),
    imdb_id: m.imdb_id && /^tt\d+$/i.test(m.imdb_id) ? m.imdb_id : null,
    tmdb_id: m.themoviedb_id || null,
    tvdb_id: m.thetvdb_id || null,
    anilist_id: m.anilist_id || null,
    kitsu_id: m.kitsu_id || null,
    anidb_id: m.anidb_id || null,
    imdb_season,
    type: (m.type || 'TV').toLowerCase() === 'movie' ? 'movie' : 'anime',
  };
}

async function malFromTitle(q, year) {
  const url = `${JIKAN}/anime?q=${encodeURIComponent(q)}&limit=8`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const list = data.data || [];
  if (!list.length) return null;

  const qn = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let best = null;
  let bestScore = -1;

  for (const a of list) {
    const names = [a.title, a.title_english, a.title_japanese]
      .filter(Boolean)
      .map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    let sc = 0;
    for (const n of names) {
      if (n === qn) sc = Math.max(sc, 100);
      else if (n.includes(qn) || qn.includes(n)) sc = Math.max(sc, 55);
    }
    const ay = a.year ? String(a.year) : a.aired?.from?.slice?.(0, 4);
    if (year && ay && String(year) === ay) sc += 25;
    if (year && ay && String(year) !== ay) sc -= 40;
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  if (!best || bestScore < 40) return null;
  return {
    mal_id: best.mal_id,
    title: best.title_english || best.title,
    year: best.year || null,
  };
}

async function fromTmdbSearch(q, type, apiKey) {
  if (!apiKey) return null;
  const kind = type === 'movie' ? 'movie' : 'tv';
  const searchUrl =
    `${TMDB}/search/${kind}?api_key=${apiKey}&query=${encodeURIComponent(q)}&language=es-ES`;
  const sRes = await fetch(searchUrl);
  if (!sRes.ok) return null;
  const sData = await sRes.json();
  const hit = (sData.results || [])[0];
  if (!hit) return null;

  const extUrl = `${TMDB}/${kind}/${hit.id}/external_ids?api_key=${apiKey}`;
  const eRes = await fetch(extUrl);
  if (!eRes.ok) return null;
  const ext = await eRes.json();

  return {
    tmdb_id: hit.id,
    imdb_id: ext.imdb_id || null,
    tvdb_id: ext.tvdb_id || null,
    title: hit.title || hit.name,
    year: (hit.release_date || hit.first_air_date || '').slice(0, 4) || null,
    type: kind === 'movie' ? 'movie' : 'series',
  };
}

async function fromCinemetaImdb(imdbId, typeHint) {
  const kinds =
    typeHint === 'movie' ? ['movie', 'series'] : ['series', 'movie'];
  for (const kind of kinds) {
    try {
      const res = await fetch(`${CINEMETA}/meta/${kind}/${imdbId}.json`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data.meta;
      if (!meta) continue;
      return {
        imdb_id: meta.imdb_id || imdbId,
        title: meta.name,
        type: meta.type === 'movie' ? 'movie' : 'series',
        year: meta.year || (meta.releaseInfo || '').slice(0, 4) || null,
        rating: meta.imdbRating || null,
      };
    } catch (_) {}
  }
  return { imdb_id: imdbId };
}

async function resolveIds(params, env) {
  const mal = params.get('mal') || params.get('mal_id');
  const imdb = params.get('imdb') || params.get('imdb_id');
  const q = (params.get('q') || params.get('query') || '').trim();
  const type = (params.get('type') || 'anime').toLowerCase(); // anime | series | movie
  const year = params.get('year');

  // 1) Por MAL
  if (mal) {
    const map = await fromAnizipMal(mal);
    if (!map) return { ok: false, error: 'mal_not_found', query: { mal: Number(mal) } };
    const images = metahubImages(map.imdb_id);
    let title = null;
    if (map.imdb_id) {
      const cm = await fromCinemetaImdb(map.imdb_id, map.type);
      title = cm.title || null;
    }
    return {
      ok: true,
      query: { mal: Number(mal) },
      ids: {
        mal_id: map.mal_id,
        imdb_id: map.imdb_id,
        tmdb_id: map.tmdb_id,
        tvdb_id: map.tvdb_id,
        anilist_id: map.anilist_id,
        kitsu_id: map.kitsu_id,
        anidb_id: map.anidb_id,
        imdb_season: map.imdb_season,
      },
      title,
      type: map.type,
      images,
    };
  }

  // 2) Por IMDb
  if (imdb && /^tt\d+$/i.test(imdb)) {
    const cm = await fromCinemetaImdb(imdb, type === 'movie' ? 'movie' : 'series');
    return {
      ok: true,
      query: { imdb },
      ids: { imdb_id: cm.imdb_id || imdb },
      title: cm.title || null,
      type: cm.type || type,
      year: cm.year || null,
      rating: cm.rating || null,
      images: metahubImages(imdb),
    };
  }

  // 3) Por texto
  if (q) {
    if (type === 'anime') {
      const malHit = await malFromTitle(q, year);
      if (malHit?.mal_id) {
        const map = await fromAnizipMal(malHit.mal_id);
        if (map) {
          return {
            ok: true,
            query: { q, type: 'anime' },
            ids: {
              mal_id: map.mal_id,
              imdb_id: map.imdb_id,
              tmdb_id: map.tmdb_id,
              tvdb_id: map.tvdb_id,
              anilist_id: map.anilist_id,
              imdb_season: map.imdb_season,
            },
            title: malHit.title,
            type: 'anime',
            images: metahubImages(map.imdb_id),
          };
        }
      }
    }

    // movie / series → TMDB
    const tmdb = await fromTmdbSearch(
      q,
      type === 'movie' ? 'movie' : 'series',
      env.TMDB_API_KEY
    );
    if (tmdb?.imdb_id) {
      return {
        ok: true,
        query: { q, type },
        ids: {
          imdb_id: tmdb.imdb_id,
          tmdb_id: tmdb.tmdb_id,
          tvdb_id: tmdb.tvdb_id,
        },
        title: tmdb.title,
        type: tmdb.type,
        year: tmdb.year,
        images: metahubImages(tmdb.imdb_id),
      };
    }

    return { ok: false, error: 'not_found', query: { q, type } };
  }

  return {
    ok: false,
    error: 'missing_params',
    usage: {
      mal: '/ids?mal=57658',
      imdb: '/ids?imdb=tt0388629',
      anime: '/ids?q=one+piece&type=anime',
      movie: '/ids?q=matrix&type=movie',
      series: '/ids?q=breaking+bad&type=series',
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      return json({
        ok: true,
        service: 'moviezone-data-api',
        endpoints: ['/ids', '/health'],
      });
    }

    if (url.pathname === '/ids') {
      try {
        const result = await resolveIds(url.searchParams, env || {});
        return json(result, result.ok ? 200 : 400);
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },
};
