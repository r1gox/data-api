/**
 * MovieZone Data API — IDs + ficha (sinopsis, rating, géneros, estudios…)
 * Env: TMDB_API_KEY (opcional, para movie/series)
 */

const CINEMETA = 'https://v3-cinemeta.strem.io';
const ANIZIP = 'https://api.ani.zip/mappings';
const JIKAN = 'https://api.jikan.moe/v4';
const TMDB = 'https://api.themoviedb.org/3';
const METAHUB = 'https://images.metahub.space';

const SEASON_ES = {
  winter: 'Invierno',
  spring: 'Primavera',
  summer: 'Verano',
  fall: 'Otoño',
};

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
  if (!imdbId || !/^tt\d+$/i.test(String(imdbId))) return null;
  return {
    poster: `${METAHUB}/poster/medium/${imdbId}/img`,
    backdrop: `${METAHUB}/background/medium/${imdbId}/img`,
    logo: `${METAHUB}/logo/medium/${imdbId}/img`,
  };
}

function estadoEs(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('airing') && !s.includes('finished')) return 'En emisión';
  if (s.includes('finished') || s.includes('complete')) return 'Finalizado';
  if (s.includes('not yet') || s.includes('upcoming')) return 'Próximamente';
  if (s.includes('hiatus')) return 'En pausa';
  return status || null;
}

function tipoEs(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'tv' || t === 'serie' || t === 'series') return 'Serie';
  if (t === 'movie' || t === 'pelicula') return 'Película';
  if (t === 'ova') return 'OVA';
  if (t === 'ona') return 'ONA';
  if (t === 'special') return 'Especial';
  if (t === 'music') return 'Música';
  return type || null;
}

/** Ficha completa desde MAL/Jikan */
async function fichaJikan(malId) {
  const res = await fetch(`${JIKAN}/anime/${encodeURIComponent(malId)}/full`, {
    headers: { Accept: 'application/json', 'User-Agent': 'MovieZoneData/1.0' },
  });
  if (!res.ok) {
    // fallback sin /full
    const r2 = await fetch(`${JIKAN}/anime/${encodeURIComponent(malId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!r2.ok) return null;
    const d2 = await r2.json();
    return mapJikanAnime(d2.data);
  }
  const data = await res.json();
  return mapJikanAnime(data.data);
}

function mapJikanAnime(a) {
  if (!a) return null;
  const season =
    a.season && a.year
      ? `${SEASON_ES[String(a.season).toLowerCase()] || a.season} ${a.year}`
      : null;
  const dur =
    a.duration && a.duration !== 'Unknown'
      ? a.duration.replace(' per ep', '').trim()
      : null;
  const emitido = a.aired?.from ? String(a.aired.from).slice(0, 10) : null;
  const posterMal =
    a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null;

  return {
    mal_id: a.mal_id,
    titulo: a.title_english || a.title,
    titulo_original: a.title_japanese || a.title || null,
    titulo_romaji: a.title || null,
    tipo: tipoEs(a.type),
    generos: (a.genres || []).map((g) => g.name).filter(Boolean),
    studios: (a.studios || []).map((s) => s.name).filter(Boolean),
    temporada: season,
    idiomas: ['Japonés'],
    episodios: a.episodes != null ? a.episodes : null,
    duracion: dur || 'Desconocido',
    emitido,
    estado: estadoEs(a.status),
    calidad: null,
    puntuacion: a.score != null ? Number(a.score) : null,
    year: a.year
      ? String(a.year)
      : emitido
        ? emitido.slice(0, 4)
        : null,
    descripcion: a.synopsis || null,
    en_emision: /airing/i.test(String(a.status || '')) && !/finished/i.test(String(a.status || '')),
    poster_mal: posterMal,
    source_meta: 'jikan',
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
  return best.mal_id;
}

async function fichaTmdb(q, type, apiKey) {
  if (!apiKey) return null;
  const kind = type === 'movie' ? 'movie' : 'tv';
  const sRes = await fetch(
    `${TMDB}/search/${kind}?api_key=${apiKey}&query=${encodeURIComponent(q)}&language=es-ES`
  );
  if (!sRes.ok) return null;
  const sData = await sRes.json();
  const hit = (sData.results || [])[0];
  if (!hit) return null;

  const detailUrl =
    `${TMDB}/${kind}/${hit.id}?api_key=${apiKey}&language=es-ES&append_to_response=external_ids`;
  const dRes = await fetch(detailUrl);
  if (!dRes.ok) return null;
  const d = await dRes.json();
  const ext = d.external_ids || {};

  return {
    ids: {
      imdb_id: ext.imdb_id || null,
      tmdb_id: d.id,
      tvdb_id: ext.tvdb_id || null,
    },
    titulo: d.title || d.name,
    titulo_original: d.original_title || d.original_name || null,
    tipo: kind === 'movie' ? 'Película' : 'Serie',
    generos: (d.genres || []).map((g) => g.name),
    studios: (d.production_companies || []).map((c) => c.name).slice(0, 5),
    temporada: null,
    idiomas: (d.spoken_languages || []).map((l) => l.name || l.english_name),
    episodios: d.number_of_episodes ?? null,
    duracion: kind === 'movie'
      ? (d.runtime ? `${d.runtime} min` : null)
      : (d.episode_run_time?.[0] ? `${d.episode_run_time[0]} min` : null),
    emitido: (d.release_date || d.first_air_date || null),
    estado: d.status || null,
    calidad: null,
    puntuacion: d.vote_average != null ? Number(d.vote_average) : null,
    year: (d.release_date || d.first_air_date || '').slice(0, 4) || null,
    descripcion: d.overview || null,
    source_meta: 'tmdb',
  };
}

function packAnime(ids, ficha) {
  const imdb = ids?.imdb_id || null;
  const images = metahubImages(imdb) || {};
  if (ficha?.poster_mal) images.poster_mal = ficha.poster_mal;
  if (!images.poster && ficha?.poster_mal) images.poster = ficha.poster_mal;

  return {
    ok: true,
    ids: {
      mal_id: ids?.mal_id || ficha?.mal_id || null,
      imdb_id: imdb,
      tmdb_id: ids?.tmdb_id || null,
      tvdb_id: ids?.tvdb_id || null,
      anilist_id: ids?.anilist_id || null,
      kitsu_id: ids?.kitsu_id || null,
      anidb_id: ids?.anidb_id || null,
      imdb_season: ids?.imdb_season ?? null,
    },
    titulo: ficha?.titulo || null,
    titulo_original: ficha?.titulo_original || null,
    tipo: ficha?.tipo || 'Serie',
    generos: ficha?.generos || [],
    studios: ficha?.studios || [],
    temporada: ficha?.temporada || null,
    idiomas: ficha?.idiomas || ['Japonés'],
    episodios: ficha?.episodios ?? null,
    duracion: ficha?.duracion || 'Desconocido',
    emitido: ficha?.emitido || null,
    estado: ficha?.estado || null,
    calidad: ficha?.calidad ?? null,
    puntuacion: ficha?.puntuacion ?? null,
    year: ficha?.year || null,
    descripcion: ficha?.descripcion || null,
    en_emision: ficha?.en_emision ?? null,
    images,
    source_meta: ficha?.source_meta || 'jikan+anizip',
  };
}

async function resolve(params, env) {
  const mal = params.get('mal') || params.get('mal_id');
  const imdb = params.get('imdb') || params.get('imdb_id');
  const q = (params.get('q') || params.get('query') || '').trim();
  const type = (params.get('type') || 'anime').toLowerCase();
  const year = params.get('year');

  // —— Por MAL ——
  if (mal) {
    const [map, ficha] = await Promise.all([
      fromAnizipMal(mal),
      fichaJikan(mal),
    ]);
    if (!ficha && !map) {
      return { ok: false, error: 'mal_not_found', query: { mal: Number(mal) } };
    }
    const body = packAnime(map || { mal_id: Number(mal) }, ficha);
    body.query = { mal: Number(mal) };
    return body;
  }

  // —— Por texto anime ——
  if (q && (type === 'anime' || type === 'animes')) {
    const malId = await malFromTitle(q, year);
    if (!malId) return { ok: false, error: 'not_found', query: { q, type } };
    const [map, ficha] = await Promise.all([
      fromAnizipMal(malId),
      fichaJikan(malId),
    ]);
    const body = packAnime(map || { mal_id: malId }, ficha);
    body.query = { q, type: 'anime' };
    return body;
  }

  // —— Movie / series (TMDB) ——
  if (q && (type === 'movie' || type === 'serie' || type === 'series' || type === 'tv')) {
    const f = await fichaTmdb(q, type === 'movie' ? 'movie' : 'series', env.TMDB_API_KEY);
    if (!f) return { ok: false, error: 'not_found', query: { q, type }, hint: 'Set TMDB_API_KEY' };
    return {
      ok: true,
      query: { q, type },
      ids: f.ids,
      titulo: f.titulo,
      titulo_original: f.titulo_original,
      tipo: f.tipo,
      generos: f.generos,
      studios: f.studios,
      temporada: null,
      idiomas: f.idiomas,
      episodios: f.episodios,
      duracion: f.duracion || 'Desconocido',
      emitido: f.emitido,
      estado: f.estado,
      calidad: null,
      puntuacion: f.puntuacion,
      year: f.year,
      descripcion: f.descripcion,
      images: metahubImages(f.ids.imdb_id),
      source_meta: 'tmdb',
    };
  }

  // —— Solo IMDb (meta ligera Cinemeta) ——
  if (imdb && /^tt\d+$/i.test(imdb)) {
    const kinds = type === 'movie' ? ['movie', 'series'] : ['series', 'movie'];
    for (const kind of kinds) {
      try {
        const res = await fetch(`${CINEMETA}/meta/${kind}/${imdb}.json`);
        if (!res.ok) continue;
        const { meta } = await res.json();
        if (!meta) continue;
        return {
          ok: true,
          query: { imdb },
          ids: { imdb_id: meta.imdb_id || imdb },
          titulo: meta.name,
          titulo_original: null,
          tipo: meta.type === 'movie' ? 'Película' : 'Serie',
          generos: meta.genre || meta.genres || [],
          studios: [],
          temporada: null,
          idiomas: [],
          episodios: null,
          duracion: meta.runtime || 'Desconocido',
          emitido: meta.released ? String(meta.released).slice(0, 10) : null,
          estado: meta.status || null,
          calidad: null,
          puntuacion: meta.imdbRating ? Number(meta.imdbRating) : null,
          year: meta.year || null,
          descripcion: meta.description || null,
          images: metahubImages(imdb),
          source_meta: 'cinemeta',
        };
      } catch (_) {}
    }
    return { ok: false, error: 'imdb_not_found', query: { imdb } };
  }

  return {
    ok: false,
    error: 'missing_params',
    usage: {
      mal: '/ids?mal=57658',
      anime: '/ids?q=one+piece&type=anime',
      movie: '/ids?q=matrix&type=movie',
      series: '/ids?q=breaking+bad&type=series',
      imdb: '/ids?imdb=tt0388629',
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
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'moviezone-data-api', endpoints: ['/ids'] });
    }
    if (url.pathname === '/ids' || url.pathname === '/meta') {
      try {
        const result = await resolve(url.searchParams, env || {});
        return json(result, result.ok ? 200 : 400);
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};
