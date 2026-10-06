// ── SERA Map Module ──────────────────────────

(function () {
    'use strict';

    // ── DOM refs ──────────────────────────────
    const mapEl = document.getElementById('map');
    const lonInput = document.getElementById('longitude');
    const latInput = document.getElementById('latitude');
    const altInput = document.getElementById('altitude');
    const addressInput = document.getElementById('address-input');
    const addressBtn = document.getElementById('address-btn');

    // ── Init map (center on Diego Suarez) ─────
    const map = L.map(mapEl, {
        center: [-12.3486, 49.2917],
        zoom: 13,
        zoomControl: true
    });

    // ── Satellite tile layer ──────────────────
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
        maxZoom: 19
    }).addTo(map);

    // ── Marker ────────────────────────────────
    let marker = null;

    function setMarker(lat, lon) {
        if (marker) {
            marker.setLatLng([lat, lon]);
        } else {
            marker = L.marker([lat, lon], {
                icon: L.divIcon({
                    className: 'sera-marker',
                    html: '<div style="width:12px;height:12px;background:#FF6B2B;border-radius:50%;border:2px solid #080B0F;box-shadow:0 0 12px rgba(255,107,43,0.5);"></div>',
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                })
            }).addTo(map);
        }
    }

    // ── Reverse geocode (lat/lon → address) ───
    async function reverseGeocode(lat, lon) {
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`
            );
            const data = await res.json();
            if (data.display_name) {
                addressInput.value = data.display_name.split(',').slice(0, 3).join(',');
            }
        } catch (e) {
            // silent fail — address field just stays empty
        }
    }

    // ── Forward geocode (address → lat/lon) ───
    async function forwardGeocode(query) {
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`
            );
            const data = await res.json();
            if (data.length > 0) {
                const { lat, lon } = data[0];
                const latNum = parseFloat(lat);
                const lonNum = parseFloat(lon);

                latInput.value = latNum.toFixed(4);
                lonInput.value = lonNum.toFixed(4);

                setMarker(latNum, lonNum);
                map.setView([latNum, lonNum], 14);
                fetchAltitude(latNum, lonNum);
            }
        } catch (e) {
            // silent fail
        }
    }

    // ── Fetch altitude from Open Elevation API ─
    async function fetchAltitude(lat, lon) {
        try {
            const res = await fetch(
                `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lon}`
            );
            const data = await res.json();
            if (data.results && data.results.length > 0) {
                altInput.value = Math.round(data.results[0].elevation);
            }
        } catch (e) {
            altInput.value = '—';
        }
    }

    // ── Handle map click ──────────────────────
    map.on('click', function (e) {
        const { lat, lng } = e.latlng;

        latInput.value = lat.toFixed(4);
        lonInput.value = lng.toFixed(4);

        setMarker(lat, lng);
        reverseGeocode(lat, lng);
        fetchAltitude(lat, lng);
    });

    // ── Handle address search ─────────────────
    addressBtn.addEventListener('click', function () {
        const query = addressInput.value.trim();
        if (query) forwardGeocode(query);
    });

    addressInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            const query = addressInput.value.trim();
            if (query) forwardGeocode(query);
        }
    });

    // ── Handle manual input changes ───────────
    latInput.addEventListener('change', onManualInput);
    lonInput.addEventListener('change', onManualInput);

    function onManualInput() {
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);
        if (!isNaN(lat) && !isNaN(lon)) {
            setMarker(lat, lon);
            map.setView([lat, lon], 14);
            reverseGeocode(lat, lon);
            fetchAltitude(lat, lon);
        }
    }

})();