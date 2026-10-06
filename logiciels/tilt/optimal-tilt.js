// ── SERA Optimal Tilt Logic ──────────────────

(function () {
    'use strict';

    const btn = document.getElementById('simulate-btn');
    const status = document.getElementById('sim-status');
    const graphsSection = document.getElementById('tilt-graphs');
    const progressContainer = document.getElementById('progress-container');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const latInput = document.getElementById('latitude');
    const lonInput = document.getElementById('longitude');
    const azimuthInput = document.getElementById('azimuth');
    const startyearInput = document.getElementById('startyear');
    const endyearInput = document.getElementById('endyear');
    const raddatabaseInput = document.getElementById('raddatabase');

    // ── Weather cache (same prefetch pattern as simulation.js) ──
    const _hoursCache = {};
    let _pendingFetch = null;
    let _prefetchController = null;
    let _lastRadDb = null;

    const G0 = 1367;
    const rho = 0.2;

    let chartProduction = null;
    let chartSunpath = null;

    // ── Progress ──────────────────────────────
    function setProgress(pct, text) {
        progressFill.style.width = pct + '%';
        progressText.textContent = text;
    }

    // ── Parse PVGIS timestamp → Date UTC ──────
    function parsePVGISTime(timeStr) {
        const [datePart, timePart] = timeStr.split(':');
        const y = datePart.slice(0, 4), m = datePart.slice(4, 6), d = datePart.slice(6, 8);
        const h = timePart.slice(0, 2), min = timePart.slice(2, 4);
        return new Date(Date.UTC(+y, +m - 1, +d, +h, +min));
    }

    // ── Precompute sun positions ──────────────
    function precomputeSunPositions(hours, lat, lon) {
        return hours.map(h => {
            const date = parsePVGISTime(h.time);
            const pos = SunCalc.getPosition(date, lat, lon);
            return {
                sinAlt: Math.sin(pos.altitude),
                cosAlt: Math.cos(pos.altitude),
                azimuth: pos.azimuth,
                Gb: h['Gb(i)'] || 0,
                Gd: h['Gd(i)'] || 0,
                Gr: h['Gr(i)'] || 0
            };
        });
    }

    // ── Hay-Davies (precomputed sun positions) ─
    function hayDaviesFast(beta, aspect, sunPos) {
        const { Gb, Gd, Gr, sinAlt, cosAlt, azimuth } = sunPos;
        const Gh = Gb + Gd + Gr;
        if (Gh <= 0 || sinAlt <= 0) return 0;

        const cosZenith = sinAlt;
        const betaRad = beta * Math.PI / 180;
        const aspectRad = aspect * Math.PI / 180;
        const cosIncidence = sinAlt * Math.cos(betaRad) +
                             cosAlt * Math.sin(betaRad) *
                             Math.cos(azimuth - aspectRad);
        if (cosIncidence <= 0) return 0;

        const Anisotropie = Gb / G0;
        const directT = Gb * (cosIncidence / cosZenith);
        const diffuseT = Gd * (Anisotropie * (cosIncidence / cosZenith) + (1 - Anisotropie) * ((1 + Math.cos(betaRad)) / 2));
        const albedoT = Gh * rho * ((1 - Math.cos(betaRad)) / 2);
        return directT + diffuseT + albedoT;
    }

    // ── Legacy Hay-Davies wrapper (kept for API compat, unused internally) ──
    function hayDavies(beta, aspect, hour, lat, lon) {
        const date = parsePVGISTime(hour.time);
        const pos = SunCalc.getPosition(date, lat, lon);
        return hayDaviesFast(beta, aspect, {
            sinAlt: Math.sin(pos.altitude),
            cosAlt: Math.cos(pos.altitude),
            azimuth: pos.azimuth,
            Gb: hour['Gb(i)'] || 0,
            Gd: hour['Gd(i)'] || 0,
            Gr: hour['Gr(i)'] || 0
        });
    }

    // ── Find optimal ──────────────────────────
    function findOptimal(hours, lat, lon, aspect) {
        const sunPositions = precomputeSunPositions(hours, lat, lon);
        let bestAngle = 0, maxEnergy = 0;
        for (let b = 0; b <= 90; b += 5) {
            let total = 0;
            for (const sp of sunPositions) total += hayDaviesFast(b, aspect, sp);
            if (total > maxEnergy) { maxEnergy = total; bestAngle = b; }
        }
        for (let b = Math.max(0, bestAngle - 4); b <= Math.min(90, bestAngle + 4); b += 1) {
            let total = 0;
            for (const sp of sunPositions) total += hayDaviesFast(b, aspect, sp);
            if (total > maxEnergy) { maxEnergy = total; bestAngle = b; }
        }
        return { angle: bestAngle, kwh: maxEnergy / 1000 };
    }

    // ── Energy for each angle ─────────────────
    function computeEnergyCurve(hours, lat, lon, aspect) {
        const sunPositions = precomputeSunPositions(hours, lat, lon);
        const angles = [], energies = [];
        for (let b = 0; b <= 90; b++) {
            let total = 0;
            for (const sp of sunPositions) total += hayDaviesFast(b, aspect, sp);
            angles.push(b);
            energies.push(total / 1000);
        }
        return { angles, energies };
    }

    // ── Find dust-safe angle (max angle with ratio >= 0.996) ──
    function findDustAngle(angles, energies, optimalAngle) {
        if (optimalAngle >= 15) return null;

        const optimalEnergy = energies[optimalAngle];
        const minRatio = 0.996;

        // Search from 20° down to 15° → return the MAX angle that respects ratio
        for (let a = 20; a >= 15; a--) {
            if (a < energies.length) {
                const ratio = energies[a] / optimalEnergy;
                if (ratio >= minRatio) {
                    return { angle: a, ratio: ratio, energy: energies[a] };
                }
            }
        }
        return null;
    }

    // ── Sun path for a given date ─────────────
    function computeSunPathForDate(lat, lon, month, day) {
        const data = [];
        const isNorth = lat >= 0;
        let lastAz = null;

        for (let minute = 0; minute < 1440; minute += 10) {
            const t = new Date(Date.UTC(2023, month, day, 0, 0, 0) + minute * 60000);
            const pos = SunCalc.getPosition(t, lat, lon);
            const altDeg = pos.altitude * 180 / Math.PI;

            if (altDeg > -5) {
                let azNorm = pos.azimuth * 180 / Math.PI;

                if (!isNorth && azNorm < 0) {
                    azNorm += 360;
                }

                if (lastAz !== null && Math.abs(azNorm - lastAz) > 180) {
                    data.push({ x: NaN, y: NaN });
                }

                data.push({ x: azNorm, y: Math.max(0, altDeg) });
                lastAz = azNorm;
            }
        }
        return data;
    }

    // ── Parse PVGIS horizon profile ───────────
    function parseHorizon(horizonData, lat) {
        if (!horizonData?.outputs?.horizon_profile) return null;
        const profile = horizonData.outputs.horizon_profile;
        const isNorth = lat >= 0;

        let pts = profile.map(p => {
            let az = p.A; // PVGIS: 0=S, +90=W, -90=E

            if (isNorth) {
                // NH: pas d'inversion
            } else {
                // SH: convertir en 0-360
                if (az < 0) az += 360;
            }

            return { x: az, y: p.H_hor };
        });

        pts.sort((a, b) => a.x - b.x);

        const xMin = isNorth ? -180 : 0;
        const xMax = isNorth ? 180 : 360;
        if (pts.length > 0) {
            if (pts[0].x > xMin) pts.unshift({ x: xMin, y: pts[0].y });
            if (pts[pts.length - 1].x < xMax) pts.push({ x: xMax, y: pts[pts.length - 1].y });
        }

        return pts;
    }

    // ── Draw Production chart ─────────────────
    function drawProductionChart(angles, energies, optimalAngle, dustRec) {
        const ctx = document.getElementById('chart-production').getContext('2d');
        if (chartProduction) chartProduction.destroy();

        const colors = angles.map(a => {
            if (Math.abs(a - optimalAngle) < 1) return '#FF6B2B';
            if (dustRec && Math.abs(a - dustRec.angle) < 1) return '#2ECC71';
            return 'rgba(255, 107, 43, 0.25)';
        });

        chartProduction = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: angles,
                datasets: [{
                    data: energies,
                    backgroundColor: colors,
                    borderColor: colors.map(c => c),
                    borderWidth: 1,
                    borderRadius: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 600, easing: 'easeOutQuart' },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(14, 18, 23, 0.97)',
                        titleColor: '#EAE6F0',
                        bodyColor: '#CCC',
                        borderColor: 'rgba(255,255,255,0.10)',
                        borderWidth: 1,
                        cornerRadius: 4,
                        padding: 10,
                        bodyFont: { size: 11 },
                        titleFont: { size: 11, weight: '600' },
                        callbacks: {
                            title: (items) => items[0].label + "° d'inclinaison",
                            label: (item) => item.raw.toFixed(0) + ' kWh/kWc'
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: "Angle d'inclinaison (°)", color: '#888' },
                        ticks: { color: '#5A5670', font: { size: 9 }, maxTicksLimit: 10 },
                        grid: { display: false }
                    },
                    y: {
                        title: { display: true, text: 'kWh/kWc', color: '#888' },
                        ticks: { color: '#5A5670', font: { size: 9 } },
                        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }
                    }
                }
            }
        });
    }

    // ── Draw Sun Path chart ───────────────────
    function drawSunPathChart(lat, lon, horizonProfile) {
        const ctx = document.getElementById('chart-sunpath').getContext('2d');
        if (chartSunpath) chartSunpath.destroy();

        const isNorth = lat >= 0;
        const summerMonth = isNorth ? 5 : 11;
        const winterMonth = isNorth ? 11 : 5;

        const summer = computeSunPathForDate(lat, lon, summerMonth, 21);
        const equinox = computeSunPathForDate(lat, lon, 2, 20);
        const winter = computeSunPathForDate(lat, lon, winterMonth, 21);

        const summerLabel = isNorth ? "Solstice d'été (21 juin)" : "Solstice d'été (21 déc.)";
        const winterLabel = isNorth ? "Solstice d'hiver (21 déc.)" : "Solstice d'hiver (21 juin)";

        // Horizon data (already sorted and extended to edges)
        const horizonLine = horizonProfile
            ? horizonProfile
            : [{ x: isNorth ? -180 : 0, y: 0 }, { x: isNorth ? 180 : 360, y: 0 }];

        // Axis config based on hemisphere
        const xMin = isNorth ? -180 : 0;
        const xMax = isNorth ? 180 : 360;

        const tickCallback = (v) => {
            if (isNorth) {
                if (v === -180) return '-180° (N)';
                if (v === -90) return '-90° (E)';
                if (v === 0) return '0° (S)';
                if (v === 90) return '90° (O)';
                if (v === 180) return '180° (N)';
            } else {
                if (v === 0) return '0° (S)';
                if (v === 90) return '90° (O)';
                if (v === 180) return '180° (N)';
                if (v === 270) return '270° (E)';
                if (v === 360) return '360° (S)';
            }
            return v + '°';
        };

        chartSunpath = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: [
                    {
                        label: summerLabel,
                        data: summer,
                        borderColor: '#FF6B2B',
                        backgroundColor: 'transparent',
                        pointRadius: 0,
                        showLine: true,
                        borderWidth: 2,
                        tension: 0.3
                    },
                    {
                        label: 'Équinoxes (mars/sept.)',
                        data: equinox,
                        borderColor: '#60a5fa',
                        backgroundColor: 'transparent',
                        pointRadius: 0,
                        showLine: true,
                        borderWidth: 2,
                        borderDash: [6, 3],
                        tension: 0.3
                    },
                    {
                        label: winterLabel,
                        data: winter,
                        borderColor: '#C84BFF',
                        backgroundColor: 'transparent',
                        pointRadius: 0,
                        showLine: true,
                        borderWidth: 2,
                        tension: 0.3
                    },
                    {
                        label: 'Horizon',
                        data: horizonLine,
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.15)',
                        pointRadius: 0,
                        showLine: true,
                        borderWidth: 2,
                        fill: 'origin'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 600, easing: 'easeOutQuart' },
                interaction: {
                    mode: 'nearest',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: '#888', font: { size: 10 }, usePointStyle: true }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(14, 18, 23, 0.97)',
                        titleColor: '#EAE6F0',
                        bodyColor: '#CCC',
                        borderColor: 'rgba(255,255,255,0.10)',
                        borderWidth: 1,
                        cornerRadius: 4,
                        padding: 10,
                        bodyFont: { size: 11 },
                        titleFont: { size: 11, weight: '600' },
                        callbacks: {
                            title: (items) => '',
                            label: (item) => {
                                if (item.datasetIndex < 3) {
                                    return `Azimut : ${item.raw.x.toFixed(1)}° | Élévation : ${item.raw.y.toFixed(1)}°`;
                                }
                                return `Horizon : ${item.raw.y.toFixed(1)}°`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: 'Azimut (°)', color: '#888' },
                        min: xMin, max: xMax,
                        ticks: {
                            color: '#5A5670',
                            font: { size: 9 },
                            stepSize: 45,
                            callback: tickCallback
                        },
                        grid: { display: false }
                    },
                    y: {
                        title: { display: true, text: 'Élévation (°)', color: '#888' },
                        min: 0, max: 90,
                        ticks: { color: '#5A5670', font: { size: 9 }, stepSize: 15 },
                        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }
                    }
                }
            }
        });
    }

    // ── Open-Meteo → PVGIS-format converter ───
    function omToPVGISFormat(data, lat, lon) {
        const times = data.hourly.time;
        const dni = data.hourly.direct_normal_irradiance;
        const dhi = data.hourly.diffuse_radiation;
        const out = [];
        for (let i = 0; i < times.length; i++) {
            const date = new Date(times[i] + 'Z');
            const pos = SunCalc.getPosition(date, lat, lon);
            const sinAlt = Math.sin(pos.altitude);
            const yr = date.getUTCFullYear();
            const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
            const dy = String(date.getUTCDate()).padStart(2, '0');
            const hr = String(date.getUTCHours()).padStart(2, '0');
            out.push({
                time: yr + mo + dy + ':' + hr + '00',
                'Gb(i)': Math.max(0, (dni[i] || 0) * sinAlt),
                'Gd(i)': Math.max(0, dhi[i] || 0),
                'Gr(i)': 0
            });
        }
        return out;
    }

    async function fetchWeatherOpenMeteo(lat, lon, startyear, endyear, externalSignal) {
        const startDate = startyear + '-01-01';
        const endDate = endyear + '-12-31';
        const p = new URLSearchParams({
            latitude: lat, longitude: lon,
            hourly: 'direct_normal_irradiance,diffuse_radiation',
            timezone: 'UTC',
            start_date: startDate, end_date: endDate
        });
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 30000);
        if (externalSignal) {
            externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
        }
        try {
            const r = await fetch('https://archive-api.open-meteo.com/v1/archive?' + p, { signal: ctrl.signal });
            if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
            const d = await r.json();
            if (!d.hourly || !d.hourly.time.length) throw new Error('No data from Open-Meteo');
            _lastRadDb = 'ERA5 (Open-Meteo)';
            return omToPVGISFormat(d, lat, lon);
        } finally {
            clearTimeout(tid);
        }
    }

    async function fetchWeather(lat, lon, startyear, endyear) {
        const key = lat.toFixed(4) + '_' + lon.toFixed(4) + '_' + startyear + '_' + endyear;
        if (_hoursCache[key]) return _hoursCache[key];
        let hours;
        try {
            hours = await fetchWeatherOpenMeteo(lat, lon, startyear, endyear);
        } catch (e) {
            console.warn('Open-Meteo failed, fallback PVGIS:', e.message);
            const pvgisStart = Math.min(startyear, 2023);
            const pvgisEnd = Math.min(endyear, 2023);
            const data = await PVGIS.getHourlyData({ lat, lon, startyear: pvgisStart, endyear: pvgisEnd, raddatabase: raddatabaseInput.value });
            const meta = data.inputs?.meteo_data || {};
            _lastRadDb = meta.radiation_db || raddatabaseInput.value || 'PVGIS';
            hours = data.outputs?.hourly;
            if (!hours || hours.length === 0) throw new Error('No hourly data returned');
        }
        _hoursCache[key] = hours;
        return hours;
    }

    function prefetchWeatherData(lat, lon) {
        const sy = parseInt(startyearInput.value) || 2018;
        const ey = parseInt(endyearInput.value) || 2023;
        const key = lat.toFixed(4) + '_' + lon.toFixed(4) + '_' + sy + '_' + ey;
        if (_hoursCache[key]) return;
        if (_prefetchController) _prefetchController.abort();
        _prefetchController = new AbortController();
        const signal = _prefetchController.signal;
        const promise = (async () => {
            try {
                _hoursCache[key] = await fetchWeatherOpenMeteo(lat, lon, sy, ey, signal);
                _lastRadDb = 'ERA5 (Open-Meteo)';
            } catch (e) {
                if (e.name !== 'AbortError') console.warn('Pre-fetch failed:', e.message);
            }
        })();
        _pendingFetch = promise;
        promise.finally(() => { if (_pendingFetch === promise) _pendingFetch = null; });
    }

    // ── Location change → prefetch ─────────────
    function onLocationChanged() {
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);
        if (!isNaN(lat) && !isNaN(lon)) prefetchWeatherData(lat, lon);
    }
    latInput.addEventListener('change', onLocationChanged);
    lonInput.addEventListener('change', onLocationChanged);
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.addEventListener('click', onLocationChanged);
    const addrBtn = document.getElementById('address-btn');
    if (addrBtn) addrBtn.addEventListener('click', function () { setTimeout(onLocationChanged, 100); });
    const addrInput = document.getElementById('address-input');
    if (addrInput) addrInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') setTimeout(onLocationChanged, 100);
    });

    // Prefetch any initial coordinates
    setTimeout(onLocationChanged, 200);

    // ── Button handler ────────────────────────
    btn.addEventListener('click', async function () {
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);
        const azimuth = parseFloat(azimuthInput.value) || 180;
        const startyear = parseInt(startyearInput.value) || 2018;
        const endyear = parseInt(endyearInput.value) || 2023;
        const raddatabase = raddatabaseInput.value;

        if (isNaN(lat) || isNaN(lon)) {
            showStatus("Sélectionnez d'abord un emplacement sur la carte.", 'error');
            return;
        }

        // Cancel any in-flight prefetch so it doesn't compete
        if (_prefetchController) _prefetchController.abort();

        btn.disabled = true;
        btn.innerHTML = 'Chargement...';
        graphsSection.style.display = 'none';
        progressContainer.style.display = 'flex';
        setProgress(0, 'Initialisation...');

        try {
            setProgress(10, 'Récupération des données solaires horaires...');
            const hours = await fetchWeather(lat, lon, startyear, endyear);

            setProgress(40, "Récupération du profil d'horizon...");
            let horizonProfile = null;
            try {
                const horizonData = await PVGIS.getHorizon({ lat, lon });
                horizonProfile = parseHorizon(horizonData, lat);
                console.log('Horizon points:', horizonProfile?.length);
            } catch (e) {
                console.warn('Horizon fetch failed:', e);
            }

            setProgress(60, "Calcul de l'inclinaison optimale...");
            const result = findOptimal(hours, lat, lon, azimuth);
            console.log('Optimal tilt:', result.angle, '°');

            setProgress(75, 'Génération du graphique de production...');
            const curve = computeEnergyCurve(hours, lat, lon, azimuth);
            const dustRec = findDustAngle(curve.angles, curve.energies, result.angle);

            if (dustRec) {
                console.log('Dust recommendation:', dustRec.angle, '° (ratio:', dustRec.ratio.toFixed(4), ')');
            }

            drawProductionChart(curve.angles, curve.energies, result.angle, dustRec);

            setProgress(90, 'Génération du diagramme de trajectoire solaire...');
            drawSunPathChart(lat, lon, horizonProfile);

            setProgress(100, 'Terminé');

            // Populate result cards
            const rAngle = document.getElementById('tilt-angle-result');
            const rProd = document.getElementById('tilt-prod-result');
            const rDust = document.getElementById('tilt-dust-rec');
            const rDustAngle = document.getElementById('tilt-dust-angle');
            if (rAngle) rAngle.textContent = result.angle + '°';
            if (rProd) rProd.textContent = result.kwh.toFixed(0) + ' kWh/kWc';
            if (rDust) rDust.style.display = dustRec ? 'flex' : 'none';
            if (rDustAngle && dustRec) {
                rDustAngle.textContent = dustRec.angle + '° (' + (dustRec.ratio * 100).toFixed(1) + "% de l'opt.)";
            }
            document.getElementById('tilt-results').style.display = 'block';

            graphsSection.style.display = 'block';
            showStatus('Résultats prêts — ' + (_lastRadDb || 'PVGIS'), 'success');

        } catch (e) {
            console.error('Error:', e);
            const msg = e.name === 'AbortError' || e.message.includes('timeout')
                ? 'Délai du serveur de données dépassé. Réessayez ou choisissez un autre emplacement.'
                : e.message;
            showStatus('Erreur : ' + msg, 'error');
        } finally {
            setTimeout(() => { progressContainer.style.display = 'none'; }, 1000);
            btn.disabled = false;
            btn.innerHTML = `
                Lancer la simulation
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            `;
        }
    });

    function showStatus(msg, type) {
        status.style.display = 'block';
        status.textContent = msg;
        status.className = 'tilt-status tilt-status--' + type;
    }

})();