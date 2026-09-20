/**
 * MovieZone Data API
 * - Anime por slug JK:  /ids?jk=jujutsu-kaisen-2nd-season
 * - Anime por MAL:      /ids?mal=21
 * - Anime por título:   /ids?q=one+piece&type=anime
 * - Peli/serie:         /ids?q=matrix&type=movie
 * - Solo IMDb:          /ids?imdb=tt38121182
 *
 * Env opcional: TMDB_API_KEY
 */

const CINEMETA = 'https://v3-cinemeta.strem.io';
const ANIZIP = 'https://api.ani.zip/mappings';
const JIKAN = 'https://api.jikan.moe/v4';
const TMDB = 'https://api.themoviedb.org/3';
const METAHUB = 'https://images.metahub.space';
const JK_BASE = 'https://jkanime.net';

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
      'cache-control': 'public, max-age=1800',
    },
  });
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function metahubImages(imdbId) {
  if (!imdbId || !/^tt\d+$/i.test(String(imdbId))) return {};
  return {
    poster: `${METAHUB}/poster/medium/${imdbId}/img`,
    backdrop: `${METAHUB}/background/medium/${imdbId}/img`,
    logo: `${METAHUB}/logo/medium/${imdbId}/img`,
  };
}

function estadoEs(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return null;
  if (s.includes('emisi') || (s.includes('airing') && !s.includes('finished'))) return 'En emisión';
  if (s.includes('finished') || s.includes('complete') || s.includes('finaliz')) return 'Finalizado';
  if (s.includes('not yet') || s.includes('upcoming') || s.includes('próxim')) return 'Próximamente';
  if (s.includes('hiatus') || s.includes('pausa')) return 'En pausa';
  return status;
}

function tipoEs(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'tv' || t === 'serie' || t === 'series') return 'Serie';
  if (t === 'movie' || t === 'pelicula' || t === 'película') return 'Película';
  if (t === 'ova') return 'OVA';
  if (t === 'ona') return 'ONA';
  if (t === 'special' || t === 'especial') return 'Especial';
  return type || null;
}

/* ───────────── ani.zip ───────────── */

async function fromAnizipMal(malId) {
  if (!malId) return null;
  try {
    const res = await fetch(`${ANIZIP}?mal_id=${encodeURIComponent(malId)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'MovieZoneData/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const m = data.mappings || data;
    if (!m) return null;

    let imdb_season = null;
    const eps = data.episodes;
    if (eps && typeof eps === 'object') {
      for (const k of Object.keys(eps)) {
        if (eps[k] && eps[k].seasonNumber != null) {
          imdb_season = Number(eps[k].seasonNumber);
          break;
        }
      }
    }

    return {
      mal_id: m.mal_id || Number(malId),
      imdb_id: m.imdb_id && /^tt\d+$/i.test(String(m.imdb_id)) ? String(m.imdb_id) : null,
      tmdb_id: m.themoviedb_id || m.tmdb_id || null,
      tvdb_id: m.thetvdb_id || m.tvdb_id || null,
      anilist_id: m.anilist_id || null,
      kitsu_id: m.kitsu_id || null,
      anidb_id: m.anidb_id || null,
      imdb_season,
    };
  } catch {
    return null;
  }
}

/* ───────────── Jikan ───────────── */

async function fichaJikan(malId) {
  if (!malId) return null;
  try {
    let res = await fetch(`${JIKAN}/anime/${encodeURIComponent(malId)}/full`, {
      headers: { Accept: 'application/json', 'User-Agent': 'MovieZoneData/1.0' },
    });
    if (!res.ok) {
      res = await fetch(`${JIKAN}/anime/${encodeURIComponent(malId)}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'MovieZoneData/1.0' },
      });
    }
    if (!res.ok) return null;
    const data = await res.json();
    return mapJikanAnime(data.data);
  } catch {
    return null;
  }
}

function mapJikanAnime(a) {
  if (!a) return null;
  const season =
    a.season && a.year
      ? `${SEASON_ES[String(a.season).toLowerCase()] || a.season} ${a.year}`
      : null;
  const dur =
    a.duration && !/unknown/i.test(a.duration)
      ? String(a.duration).replace(/\s*per ep/i, '').trim()
      : null;
  const emitido = a.aired && a.aired.from ? String(a.aired.from).slice(0, 10) : null;
  const posterMal =
    (a.images && a.images.jpg && (a.images.jpg.large_image_url || a.images.jpg.image_url)) ||
    null;

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
    puntuacion: a.score != null ? Number(a.score) : null,
    year: a.year
      ? String(a.year)
      : emitido
        ? emitido.slice(0, 4)
        : null,
    descripcion: a.synopsis || null,
    en_emision:
      /airing/i.test(String(a.status || '')) && !/finished/i.test(String(a.status || '')),
    poster_mal: posterMal,
    source_meta: 'jikan',
  };
}

async function malFromTitle(q, year) {
  const query = String(q || '').replace(/\(\d{4}\)/g, '').trim();
  if (!query || query.length < 2) return null;
  try {
    const url = `${JIKAN}/anime?q=${encodeURIComponent(query)}&limit=8`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'MovieZoneData/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const list = data.data || [];
    if (!list.length) return null;

    const qn = query.toLowerCase().replace(/[^a-z0-9áéíóúüñ]+/gi, ' ').trim();
    let best = null;
    let bestScore = -1;

    for (const a of list) {
      const names = [a.title, a.title_english, a.title_japanese]
        .filter(Boolean)
        .map((t) => t.toLowerCase().replace(/[^a-z0-9áéíóúüñ]+/gi, ' ').trim());
      let sc = 0;
      for (const n of names) {
        if (n === qn) sc = Math.max(sc, 100);
        else if (n.includes(qn) || qn.includes(n)) sc = Math.max(sc, 55);
      }
      const ay = a.year
        ? String(a.year)
        : a.aired && a.aired.from
          ? String(a.aired.from).slice(0, 4)
          : null;
      if (year && ay && String(year) === ay) sc += 25;
      if (year && ay && String(year) !== ay) sc -= 40;
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    if (!best || bestScore < 40) return null;
    return best.mal_id;
  } catch {
    return null;
  }
}

/* ───────────── JKanime scrape ───────────── */

async function scrapeJkAnime(slug) {
  slug = String(slug || '')
    .replace(/^https?:\/\/(www\.)?jkanime\.net\//i, '')
    .replace(/\/+$/, '')
    .split('/')[0]
    .trim();
  if (!slug) return null;

  const pageUrl = `${JK_BASE}/${slug}/`;
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();

    function meta(prop) {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
        'i'
      );
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
        'i'
      );
      const m = html.match(re) || html.match(re2);
      return m ? decodeHtml(m[1]) : null;
    }

    function pick(re) {
      const m = html.match(re);
      return m ? decodeHtml(String(m[1]).replace(/\s+/g, ' ').trim()) : null;
    }

    let titulo = meta('og:title') || pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (titulo) {
      titulo = titulo
        .replace(/<[^>]+>/g, '')
        .replace(/\s*-\s*anime.*$/i, '')
        .replace(/\s+online.*$/i, '')
        .replace(/\s+JkAnime.*$/i, '')
        .trim();
    }

    const descripcion = meta('description') || meta('og:description');
    let portada = meta('og:image');
    if (!portada) {
      const img = html.match(
        /https?:\/\/cdn\.jkdesa\.com\/assets\/images\/animes\/image\/[^"'\s]+/i
      );
      if (img) portada = img[0];
    }

    let episodios = null;
    const slugEsc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const epLinks = html.match(new RegExp(`/${slugEsc}/(\\d+)/`, 'g'));
    if (epLinks && epLinks.length) {
      const nums = epLinks
        .map((u) => {
          const m = u.match(/\/(\d+)\/?$/);
          return m ? Number(m[1]) : 0;
        })
        .filter((n) => n > 0);
      if (nums.length) episodios = Math.max(...nums);
    }
    const epTxt =
      pick(/Episodios?\s*:?\s*<\/[^>]+>\s*(\d+)/i) ||
      pick(/(\d+)\s*Episodios?/i);
    if (epTxt && !episodios) episodios = Number(epTxt) || null;

    let estado =
      pick(/Estado\s*:?\s*<\/[^>]+>\s*([^<]+)/i) ||
      pick(/Estado[^<]{0,40}?([A-Za-záéíóúÁÉÍÓÚñÑ ]{4,40})/i);
    if (estado) estado = estadoEs(estado.trim());

    const generos = [];
    const genSection = html.match(
      /G[eé]nero[s]?\s*:?\s*<\/[^>]+>([\s\S]{0,500})/i
    );
    if (genSection) {
      for (const g of genSection[1].matchAll(/<a[^>]*>([^<]+)<\/a>/gi)) {
        const name = decodeHtml(g[1]).trim();
        if (name && !generos.includes(name)) generos.push(name);
      }
    }

    let calidad = null;
    if (/1080p/i.test(html)) calidad = '1080p';
    else if (/720p/i.test(html)) calidad = '720p';
    else if (/480p/i.test(html)) calidad = '480p';

    let tipo = 'Serie';
    const blob = (html + ' ' + (titulo || '')).toLowerCase();
    if (/pel[ií]cula|\bmovie\b/.test(blob)) tipo = 'Película';
    if (/\bova\b/.test(blob)) tipo = 'OVA';
    if (/\bona\b/.test(blob)) tipo = 'ONA';

    const idiomas = ['Japonés'];
    if (/latino|castellano|español/i.test(html)) idiomas.push('Español');

    return {
      slug,
      url: pageUrl,
      titulo: titulo || slug.replace(/-/g, ' '),
      descripcion: descripcion || null,
      portada: portada || null,
      tipo,
      generos,
      episodios,
      estado,
      calidad,
      idiomas,
      source_meta: 'jkanime',
    };
  } catch {
    return null;
  }
}

/* ───────────── TMDB (movie/series) ───────────── */

async function fichaTmdb(q, type, apiKey) {
  if (!apiKey) return null;
  const kind = type === 'movie' ? 'movie' : 'tv';
  try {
    const sRes = await fetch(
      `${TMDB}/search/${kind}?api_key=${apiKey}&query=${encodeURIComponent(q)}&language=es-ES`
    );
    if (!sRes.ok) return null;
    const sData = await sRes.json();
    const hit = (sData.results || [])[0];
    if (!hit) return null;

    const dRes = await fetch(
      `${TMDB}/${kind}/${hit.id}?api_key=${apiKey}&language=es-ES&append_to_response=external_ids`
    );
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
      idiomas: (d.spoken_languages || []).map((l) => l.name || l.english_name),
      episodios: d.number_of_episodes ?? null,
      duracion:
        kind === 'movie'
          ? d.runtime
            ? `${d.runtime} min`
            : 'Desconocido'
          : d.episode_run_time && d.episode_run_time[0]
            ? `${d.episode_run_time[0]} min`
            : 'Desconocido',
      emitido: d.release_date || d.first_air_date || null,
      estado: d.status || null,
      puntuacion: d.vote_average != null ? Number(d.vote_average) : null,
      year: (d.release_date || d.first_air_date || '').slice(0, 4) || null,
      descripcion: d.overview || null,
      source_meta: 'tmdb',
    };
  } catch {
    return null;
  }
}

/* ───────────── Cinemeta por imdb ───────────── */

async function fromCinemetaImdb(imdbId, typeHint) {
  const kinds =
    typeHint === 'movie' || typeHint === 'película'
      ? ['movie', 'series']
      : ['series', 'movie'];
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
        titulo: meta.name || null,
        tipo: meta.type === 'movie' ? 'Película' : 'Serie',
        generos: meta.genre || meta.genres || [],
        duracion: meta.runtime || null,
        emitido: meta.released ? String(meta.released).slice(0, 10) : null,
        estado: meta.status || null,
        puntuacion: meta.imdbRating ? Number(meta.imdbRating) : null,
        year: meta.year ? String(meta.year) : null,
        descripcion: meta.description || null,
        source_meta: 'cinemeta',
      };
    } catch {
      /* next */
    }
  }
  return null;
}

/* ───────────── Merge helpers ───────────── */

function first(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return null;
}

function packAnime({ jk, map, ficha, query }) {
  const imdb = map?.imdb_id || null;
  const images = { ...metahubImages(imdb) };
  if (jk?.portada) {
    images.poster_jk = jk.portada;
    if (!images.poster) images.poster = jk.portada;
  }
  if (ficha?.poster_mal) {
    images.poster_mal = ficha.poster_mal;
    if (!images.poster) images.poster = ficha.poster_mal;
  }

  return {
    ok: true,
    query,
    ids: {
      mal_id: map?.mal_id || ficha?.mal_id || null,
      imdb_id: imdb,
      tmdb_id: map?.tmdb_id || null,
      tvdb_id: map?.tvdb_id || null,
      anilist_id: map?.anilist_id || null,
      kitsu_id: map?.kitsu_id || null,
      anidb_id: map?.anidb_id || null,
      imdb_season: map?.imdb_season ?? null,
    },
    titulo: first(jk?.titulo, ficha?.titulo),
    titulo_original: first(ficha?.titulo_original),
    tipo: first(jk?.tipo, ficha?.tipo, 'Serie'),
    generos: first(jk?.generos, ficha?.generos) || [],
    studios: ficha?.studios || [],
    temporada: ficha?.temporada || null,
    idiomas: first(jk?.idiomas, ficha?.idiomas) || ['Japonés'],
    episodios: first(jk?.episodios, ficha?.episodios),
    duracion: first(ficha?.duracion, 'Desconocido'),
    emitido: ficha?.emitido || null,
    estado: first(jk?.estado, ficha?.estado),
    calidad: jk?.calidad || null,
    puntuacion: ficha?.puntuacion ?? null,
    year: ficha?.year || null,
    descripcion: first(jk?.descripcion, ficha?.descripcion),
    en_emision: ficha?.en_emision ?? null,
    images,
    jk_url: jk?.url || null,
    source_meta: [jk && 'jkanime', ficha && 'jikan', map && 'anizip']
      .filter(Boolean)
      .join('+') || 'unknown',
  };
}

/* ───────────── Resolvers ───────────── */

async function resolveFromJk(slug) {
  const jk = await scrapeJkAnime(slug);
  if (!jk) return { ok: false, error: 'jk_not_found', query: { jk: slug } };

  let malId = await malFromTitle(jk.titulo, null);
  if (!malId) malId = await malFromTitle(String(slug).replace(/-/g, ' '), null);

  let map = null;
  let ficha = null;
  if (malId) {
    [map, ficha] = await Promise.all([fromAnizipMal(malId), fichaJikan(malId)]);
  }

  return packAnime({
    jk,
    map: map || (malId ? { mal_id: malId } : null),
    ficha,
    query: { jk: slug },
  });
}

async function resolveFromMal(malId) {
  const [map, ficha] = await Promise.all([
    fromAnizipMal(malId),
    fichaJikan(malId),
  ]);
  if (!ficha && !map) {
    return { ok: false, error: 'mal_not_found', query: { mal: Number(malId) } };
  }
  return packAnime({
    jk: null,
    map: map || { mal_id: Number(malId) },
    ficha,
    query: { mal: Number(malId) },
  });
}

async function resolve(params, env) {
  const jk = params.get('jk') || params.get('jkanime') || params.get('slug');
  const mal = params.get('mal') || params.get('mal_id');
  const imdb = params.get('imdb') || params.get('imdb_id');
  const q = (params.get('q') || params.get('query') || '').trim();
  const type = (params.get('type') || 'anime').toLowerCase();
  const year = params.get('year');

  // 1) JKanime slug (prioridad anime)
  if (jk) return resolveFromJk(jk);

  // 2) MAL id
  if (mal) return resolveFromMal(mal);

  // 3) Búsqueda por título anime
  if (q && (type === 'anime' || type === 'animes')) {
    const malId = await malFromTitle(q, year);
    if (!malId) return { ok: false, error: 'not_found', query: { q, type } };
    const body = await resolveFromMal(malId);
    if (body.ok) body.query = { q, type: 'anime' };
    return body;
  }

  // 4) Movie / series → TMDB
  if (
    q &&
    (type === 'movie' ||
      type === 'serie' ||
      type === 'series' ||
      type === 'tv' ||
      type === 'pelicula')
  ) {
    const f = await fichaTmdb(
      q,
      type === 'movie' || type === 'pelicula' ? 'movie' : 'series',
      env.TMDB_API_KEY
    );
    if (!f) {
      return {
        ok: false,
        error: 'not_found',
        query: { q, type },
        hint: env.TMDB_API_KEY ? undefined : 'Set TMDB_API_KEY for movie/series search',
      };
    }
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
      duracion: f.duracion,
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

  // 5) Solo IMDb → Cinemeta
  if (imdb && /^tt\d+$/i.test(imdb)) {
    const cm = await fromCinemetaImdb(imdb, type);
    if (!cm) return { ok: false, error: 'imdb_not_found', query: { imdb } };
    return {
      ok: true,
      query: { imdb },
      ids: { imdb_id: cm.imdb_id || imdb },
      titulo: cm.titulo,
      titulo_original: null,
      tipo: cm.tipo,
      generos: cm.generos || [],
      studios: [],
      temporada: null,
      idiomas: [],
      episodios: null,
      duracion: cm.duracion || 'Desconocido',
      emitido: cm.emitido,
      estado: cm.estado,
      calidad: null,
      puntuacion: cm.puntuacion,
      year: cm.year,
      descripcion: cm.descripcion,
      images: metahubImages(imdb),
      source_meta: 'cinemeta',
    };
  }

  return {
    ok: false,
    error: 'missing_params',
    usage: {
      jk: '/ids?jk=jujutsu-kaisen-2nd-season',
      mal: '/ids?mal=21',
      anime: '/ids?q=one+piece&type=anime',
      movie: '/ids?q=matrix&type=movie',
      series: '/ids?q=breaking+bad&type=series',
      imdb: '/ids?imdb=tt0388629',
    },
  };
}

/* ───────────── Worker ───────────── */

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
      return json({
        ok: true,
        service: 'moviezone-data-api',
        endpoints: ['/ids', '/meta', '/health'],
      });
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
