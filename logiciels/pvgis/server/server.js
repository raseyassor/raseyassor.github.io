// ── SERA Proxy Server ────────────────────────
// Bypasses CORS for PVGIS API calls

const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3001;
const ROOT = path.resolve(__dirname, '../..');

// MIME types for static files
const MIME = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {

    // ── CORS headers ────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsed = url.parse(req.url, true);

    // ── Proxy PVGIS requests ────────────────
    // Client calls: /api/pvgis/seriescalc?lat=...
    // Proxy forwards to v5.3 API (stable, works as of 2026)
    const pvgisMatch = parsed.pathname.match(/^\/api\/pvgis\/(.+)$/);
    if (pvgisMatch) {
        const endpoint = pvgisMatch[1];
        const q = { ...parsed.query };
        const qs = new URLSearchParams(q).toString();
        const pvgisUrl = `https://re.jrc.ec.europa.eu/api/v5_3/${endpoint}?${qs}`;
        console.log('[PVGIS] Proxying:', pvgisUrl);

        const pReq = https.get(pvgisUrl, { family: 4 }, (proxyRes) => {
            console.log('[PVGIS] Status:', proxyRes.statusCode);
            let body = '';
            let timedOut = false;
            const timeoutId = setTimeout(() => {
                timedOut = true;
                pReq.destroy();
                proxyRes.destroy();
                console.error('[PVGIS] Timeout after 30s —', pvgisUrl);
                if (!res.headersSent) {
                    res.writeHead(504, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'PVGIS upstream timeout' }));
                }
            }, 30000);
            proxyRes.setEncoding('utf8');
            proxyRes.on('data', chunk => { if (!timedOut) body += chunk; });
            proxyRes.on('end', () => {
                clearTimeout(timeoutId);
                if (!timedOut) {
                    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                    res.end(body);
                }
            });
        });
        pReq.on('error', (e) => {
            console.error('[PVGIS] Request error:', e.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'PVGIS connection failed: ' + e.message }));
            }
        });

        return;
    }

    // ── Serve static files ──────────────────
    let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    filePath = path.join(ROOT, filePath);

    const ext = path.extname(filePath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(data);
    });

});

server.listen(PORT, () => {
    console.log(`\n  SERA running at http://localhost:${PORT}\n`);
});