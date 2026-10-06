// ── SERA PVGIS API Module ────────────────────
// Sole module for PVGIS API communication
// Handles raw data fetching AND PVGIS-specific parsing

const PVGIS = {

    PROXY: '/api/pvgis',
    // Fallback when the page is served by a static server (e.g. Live Server :5500)
    // instead of pvgis/server/server.js (:3001) which owns the /api/pvgis route.
    PROXY_FALLBACK: 'http://localhost:3001/api/pvgis',

    async _get(endpoint, params) {
        const qs = params.toString();
        let res = null, lastErr = null;
        for (const base of [this.PROXY, this.PROXY_FALLBACK]) {
            try {
                res = await fetch(`${base}/${endpoint}?${qs}`);
                if (res.ok) return res.json();
                lastErr = new Error(`PVGIS ${endpoint} error: ${res.status} via ${base}`);
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error(`PVGIS ${endpoint} unreachable (serveur node :3001 lancé ?)`);
    },

    /**
     * Fetch hourly solar data from PVGIS
     */
    async getHourlyData({ lat, lon, startyear, endyear, raddatabase }) {
        const params = new URLSearchParams({
            lat, lon,
            raddatabase: raddatabase || 'PVGIS-SARAH3',
            outputformat: 'json',
            usehorizon: 1,
            components: 1
        });
        if (startyear != null) params.set('startyear', startyear);
        if (endyear != null) params.set('endyear', endyear);
        return this._get('seriescalc', params);
    },

    /**
     * Fetch horizon profile from PVGIS
     */
    async getHorizon({ lat, lon }) {
        const params = new URLSearchParams({ lat, lon, outputformat: 'json' });
        return this._get('printhorizon', params);
    },

    /**
     * Parse raw PVGIS hourly entries into standard internal format
     * @param {Array} rawHourly - raw PVGIS hourly array (each entry has time, Gb(i), Gd(i), T2m, WS10m, H_sun)
     * @returns {Array} parsed entries [{timeStr, dni, dhi, t2m, ws10m}]
     */
    parseHourlyEntries(rawHourly) {
        return rawHourly.map(entry => {
            const t = entry.time;
            const timeStr = `${t.substring(0, 4)}-${t.substring(4, 6)}-${t.substring(6, 8)}T${t.substring(9, 11)}:00:00Z`;
            const sunHeight = entry.H_sun || 0;
            const bhi = entry['Gb(i)'] || 0;
            const dni = sunHeight > 0.5 ? bhi / Math.sin(sunHeight * Math.PI / 180) : 0;
            return {
                timeStr,
                dni: Math.min(2000, Math.max(0, dni)),
                dhi: Math.max(0, entry['Gd(i)'] || 0),
                t2m: entry.T2m || 0,
                ws10m: entry.WS10m || 0
            };
        });
    },

    /**
     * Group parsed hourly entries by year
     * @param {Array} parsedEntries - output from parseHourlyEntries()
     * @returns {Array} year-grouped arrays [{time[], direct_normal_irradiance[], diffuse_radiation[], temperature_2m[], wind_speed_10m[]}]
     */
    groupByYear(parsedEntries) {
        const years = {};
        for (const entry of parsedEntries) {
            const yr = entry.timeStr.substring(0, 4);
            if (!years[yr]) years[yr] = { time: [], direct_normal_irradiance: [], diffuse_radiation: [], temperature_2m: [], wind_speed_10m: [] };
            years[yr].time.push(entry.timeStr);
            years[yr].direct_normal_irradiance.push(entry.dni);
            years[yr].diffuse_radiation.push(entry.dhi);
            years[yr].temperature_2m.push(entry.t2m);
            years[yr].wind_speed_10m.push(entry.ws10m);
        }
        return Object.keys(years).sort().map(k => years[k]);
    },

    /**
     * Parse PVGIS horizon profile into sorted [{azimuth, elevation}] array
     * @param {Object} horizonData - raw PVGIS horizon response
     * @param {number} lat - latitude (determines NH/SH azimuth convention)
     * @returns {Array|null} sorted horizon points or null if invalid
     */
    parseHorizonProfile(horizonData, lat) {
        if (!horizonData || !horizonData.outputs || !horizonData.outputs.horizon_profile || !horizonData.outputs.horizon_profile.length) return null;
        const isNorth = lat >= 0;
        const pts = horizonData.outputs.horizon_profile.map(p => {
            let az = p.A || 0; // PVGIS: 0=S, +90=W, -90=E
            if (!isNorth && az < 0) az += 360; // SH: convert to 0-360
            return { azimuth: az, elevation: p.H_hor || 0 };
        });
        pts.sort((a, b) => a.azimuth - b.azimuth);
        return pts;
    }

};