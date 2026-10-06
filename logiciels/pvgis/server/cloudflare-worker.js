// ── SERA PVGIS Proxy — Cloudflare Worker ─────────────────────
// Déploiement : dash.cloudflare.com → Workers & Pages → Create Worker
// → remplacez tout le code par ce fichier → Deploy.
// Puis copiez l'URL du worker (https://xxx.workers.dev) dans
// logiciels/pvgis/api/api-pvgis.js → PROXY_WORKER.
// Gratuit (~100 000 req/jour), sans endormissement.

const UPSTREAM = 'https://re.jrc.ec.europa.eu/api/v5_3';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    const url = new URL(request.url);
    // Accepte /seriescalc?... et /api/pvgis/seriescalc?...
    const m = url.pathname.match(/^(?:\/api\/pvgis)?\/(.+)$/);
    if (!m || request.method !== 'GET') {
      return new Response('Not found', { status: 404, headers: cors() });
    }
    const target = `${UPSTREAM}/${m[1]}${url.search}`;
    try {
      const upstream = await fetch(target, { headers: { Accept: 'application/json' } });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...cors(), 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'PVGIS upstream failed: ' + e.message }), {
        status: 502,
        headers: { ...cors(), 'Content-Type': 'application/json' },
      });
    }
  },
};
