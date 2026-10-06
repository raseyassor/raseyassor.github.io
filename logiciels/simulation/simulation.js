// ═══════════════════════════════════════════════════════════════════════════════
// SERA Simulation Engine
// Merged from sim-core.js + simulation.js
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── 1. CONSTANTS & CONFIGURATION ───────────────────────────────────────────

const PANEL_TYPES = {
  mono:  { label: 'Monocrystalline',    eff: 20.0, k1: -0.017237, k2: -0.040465, k3: -0.004,   k4: 0.000149, k5: 0.000170, k6: 0.000005 },
  poly:  { label: 'Polycrystalline',    eff: 17.0, k1: -0.017237, k2: -0.040465, k3: -0.004,   k4: 0.000149, k5: 0.000170, k6: 0.000005 },
  cis:   { label: 'Thin-film CIS',      eff: 14.0, k1: -0.005554, k2: -0.038724, k3: -0.003723, k4: -0.000905, k5: -0.001256, k6: 0.000001 },
  cdte:  { label: 'Thin-film CdTe',     eff: 15.0, k1: -0.046689, k2: -0.072844, k3: -0.002262, k4: 0.000276, k5: 0.000159, k6: -0.000006 },
  hit:   { label: 'Heterojunction HIT', eff: 22.0, k1: -0.017237, k2: -0.040465, k3: -0.0025,  k4: 0.000149, k5: 0.000170, k6: 0.000005 }
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// AOI reflection model constants (Martin & Ruiz)
const AOI_AR = 0.16;
const AOI_DENOM = 1 - Math.exp(-1 / AOI_AR);
const COS85 = Math.cos((85 * Math.PI) / 180);

let lastSecResults = null;

// ─── 2. MATH UTILITIES ──────────────────────────────────────────────────────

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }
function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }

// ─── 2b. INPUT VALIDATION HELPER ────────────────────────────────────────────
// Robust parseFloat with fallback and clamping. Accepts an element or selector.
function getVal(selector, fallback = 0, min = -Infinity, max = Infinity) {
  const el = typeof selector === 'string' ? document.getElementById(selector) : selector;
  if (!el) return fallback;
  const v = parseFloat(el.value);
  if (isNaN(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// ─── 3. SOLAR GEOMETRY ──────────────────────────────────────────────────────

function dayOfYear(month, day) {
  const d = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let s = day;
  for (let m = 1; m < month; m++) s += d[m];
  return s;
}

function declination(doy) {
  return 23.45 * Math.sin(toRad((doy - 81) * 360 / 365));
}

function equationOfTime(doy) {
  const B = (doy - 81) * 360 / 365;
  return 9.87 * Math.sin(toRad(2 * B)) - 7.53 * Math.cos(toRad(B)) - 1.5 * Math.sin(toRad(B));
}

function solarConstant(doy) {
  return 1361.1 * (1 + 0.033 * Math.cos(toRad(360 * (doy - 1) / 365)));
}

function spectralFactor(am) {
  if (am <= 0) return 1;
  const am1 = am - 1.5;
  return Math.max(0.94, Math.min(1.04, 1 - 0.015 * am1 + 0.002 * am1 * am1));
}


// ─── 4. SOLAR GEOMETRY CACHE ────────────────────────────────────────────────
// Sun position (elevation/azimuth), air mass and spectral factor depend
// only on (lat, lng, hourly timestamp) — NOT on weather data.
// We split the computation into a static (weather-independent) part cached
// by time-signature, and a dynamic part that merges irradiance & temperature.
// This eliminates ~95% of trig calls when re-running multi-year analyses.

const _geoCache = new WeakMap();
const _staticGeoCache = new Map();
const _weatherCache = new Map();
let _pendingWeatherFetch = null;

function getStaticSolarGeometry(timeArr, lat, lng) {
  // Key ignores the year — same month/day/hour pattern across years hits cache
  const key = `${lat.toFixed(6)},${lng.toFixed(6)}|${timeArr.length}|${timeArr[0].slice(5,16)}|${timeArr[timeArr.length-1].slice(5,16)}`;
  const cached = _staticGeoCache.get(key);
  if (cached) return cached;

  const n = timeArr.length;
  const month    = new Uint8Array(n);
  const valid    = new Uint8Array(n);
  const sinElev  = new Float64Array(n);
  const cosElev  = new Float64Array(n);
  const sinAz    = new Float64Array(n);
  const cosAz    = new Float64Array(n);
  const specFact = new Float64Array(n);
  const azimuthDeg = new Float64Array(n);

  const lR = toRad(lat);
  const sinLat = Math.sin(lR), cosLat = Math.cos(lR);

  for (let i = 0; i < n; i++) {
    const t = timeArr[i];
    const mo = +t.slice(5, 7);
    const da = +t.slice(8, 10);
    const hUTC = (+t.slice(11, 13)) + (+t.slice(14, 16)) / 60;
    month[i] = mo - 1;

    const doy = dayOfYear(mo, da);
    const decl = declination(doy), eot = equationOfTime(doy);
    const hsa = (hUTC + lng / 15 + eot / 60 - 12) * 15;
    const dR = toRad(decl), hR = toRad(hsa);

    const sinEl = sinLat * Math.sin(dR) + cosLat * Math.cos(dR) * Math.cos(hR);

    if (sinEl <= 0) {
      valid[i] = 0;
      sinElev[i] = 0; cosElev[i] = 1;
      sinAz[i] = 0; cosAz[i] = 1;
      azimuthDeg[i] = 0;
      specFact[i] = 1;
      continue;
    }

    const elevR = Math.asin(clamp(sinEl, -1, 1));
    const cosEl = Math.cos(elevR);
    const cosAzS = (Math.sin(dR) - sinLat * sinEl) / Math.max(cosLat * cosEl, 0.001);
    let azR = Math.acos(clamp(cosAzS, -1, 1));
    if (hsa > 0) azR = 2 * Math.PI - azR;

    valid[i] = 1;
    sinElev[i] = sinEl;
    cosElev[i] = cosEl;
    sinAz[i] = Math.sin(azR);
    cosAz[i] = Math.cos(azR);

    let azDeg = toDeg(azR);
    if (hsa > 0) azDeg = 360 - azDeg;   // astronomical → South-centred convention
    if (azDeg > 180) azDeg -= 360;
    azimuthDeg[i] = azDeg;

    const elevDeg = toDeg(elevR);
    const am = 1 / (sinEl + 0.50572 * Math.pow(elevDeg + 6.07995, -1.6364));
    specFact[i] = spectralFactor(am);
  }

  const geo = { n, month, valid, sinElev, cosElev, sinAz, cosAz, azimuthDeg, specFact };
  _staticGeoCache.set(key, geo);
  return geo;
}

function getSolarGeometry(hourly, lat, lng) {
  const cached = _geoCache.get(hourly);
  if (cached && cached.lat === lat && cached.lng === lng) return cached.geo;

  const staticGeo = getStaticSolarGeometry(hourly.time, lat, lng);
  const n = staticGeo.n;

  const GHI      = new Float64Array(n);
  const DNI      = new Float64Array(n);
  const DIF      = new Float64Array(n);
  const Ta       = new Float64Array(n);
  const Vw       = new Float64Array(n);
  const specFact = staticGeo.specFact;   // reuse static
  const Ai       = new Float64Array(n);
  const expBuilding = new Float64Array(n);
  const expFree     = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const t = hourly.time[i];
    const mo = +t.slice(5, 7);
    const da = +t.slice(8, 10);

    const dni = Math.max(0, hourly.direct_normal_irradiance[i] || 0);
    const dif = Math.max(0, hourly.diffuse_radiation[i] || 0);
    DNI[i] = dni; DIF[i] = dif;
    Ta[i] = hourly.temperature_2m[i] || 0;
    Vw[i] = hourly.wind_speed_10m[i] || 0;

    const sinEl = staticGeo.sinElev[i];
    GHI[i] = dni * Math.max(0, sinEl) + dif;

    const doy = dayOfYear(mo, da);
    const I0 = solarConstant(doy);
    Ai[i] = sinEl > 0.01 ? dni / Math.max(I0, 1) : 0;

    // Pre-compute temperature exponentials (Sandia model)
    const vw = Math.max(Vw[i], 0.5);
    expBuilding[i] = Math.exp(-2.81 + -0.0455 * vw);
    expFree[i]     = Math.exp(-3.56 + -0.075 * vw);
  }

  const geo = {
    n, month: staticGeo.month, valid: staticGeo.valid,
    sinElev: staticGeo.sinElev, cosElev: staticGeo.cosElev,
    sinAz: staticGeo.sinAz, cosAz: staticGeo.cosAz,
    azimuthDeg: staticGeo.azimuthDeg, specFact, Ai,
    GHI, DNI, DIF, Ta, Vw, expBuilding, expFree
  };
  _geoCache.set(hourly, { lat, lng, geo });
  return geo;
}


// ─── 5. HORIZON PROCESSING ──────────────────────────────────────────────────

function buildHorizonLookup(horizonMask) {
  const lookup = new Float64Array(360);
  if (!horizonMask || horizonMask.length < 2) return lookup;
  const pts = horizonMask.map(p => ({ az: p.azimuth ?? p.x, el: p.elevation ?? p.y }));
  pts.sort((a, b) => a.az - b.az);
  for (let i = 0; i < 360; i++) {
    const az = i - 180;
    let lo = pts[0], hi = pts[pts.length - 1];
    for (let j = 0; j < pts.length - 1; j++) {
      if (pts[j].az <= az && pts[j + 1].az >= az) { lo = pts[j]; hi = pts[j + 1]; break; }
    }
    lookup[i] = hi.az === lo.az ? lo.el : lo.el + (hi.el - lo.el) * (az - lo.az) / (hi.az - lo.az);
  }
  return lookup;
}


// ─── 6. PV POWER MODEL ──────────────────────────────────────────────────────

function pvPerKw(Gt, Tc, panel) {
  if (Gt <= 0) return 0;
  const G = Gt / 1000, lnG = Math.log(G), T = Tc - 25;
  const effRel = 1 + panel.k1 * lnG + panel.k2 * lnG * lnG
                   + panel.k3 * T + panel.k4 * T * lnG + panel.k5 * T * lnG * lnG
                   + panel.k6 * T * T;
  return Math.max(0, G * effRel);
}

// ─── 6b. INVERTER PART-LOAD EFFICIENCY ──────────────────────────────────────
// Simplified Sandia inverter model: peak at 30-50%, tare losses at low load

function inverterEfficiency(pdcRatio, pNomEff = 0.98, pThreshold = 0.1) {
  if (pdcRatio <= 0) return 0;
  if (pdcRatio < pThreshold) {
    // Linear ramp from 0 to threshold (tare loss region)
    return pNomEff * (pdcRatio / pThreshold) * 0.5;
  }
  // Peak efficiency around 50%, slight drop at 100%
  const loadFactor = pdcRatio <= 0.5 ? 0.9 + 0.2 * pdcRatio : 1.0 - 0.02 * (pdcRatio - 0.5);
  return pNomEff * loadFactor;
}


// ─── 7. SECTION PRODUCTION COMPUTATION ──────────────────────────────────────

function computeSectionProdFast(geo, tilt, azPV, mount, panel, kWc, albedo, horizonLookup) {
  const tR = toRad(tilt);
  const cosT = Math.cos(tR), sinT = Math.sin(tR);
  const pR = toRad(azPV + 180);
  const cosP = Math.cos(pR), sinP = Math.sin(pR);
  const sinHalfT3 = Math.pow(Math.sin(tR / 2), 3);
  const diffuseIso = (1 + cosT) / 2 * (1 + sinHalfT3);
  const groundTerm = albedo * (1 - cosT) / 2;
  const dT = mount === 'building' ? 0 : 3;
  const expArr = mount === 'building' ? geo.expBuilding : geo.expFree;

  let sumGHI = 0, sumGti = 0, sumIdeal = 0;
  let sumAfterHorizon = 0, sumAfterIAM = 0, sumAfterSpec = 0, sumAfterLowIrrad = 0, sumAfterTemp = 0;
  let annualAC = 0;

  const monthly = Array(12).fill(null).map(() => ({ ac: 0, gti: 0, ghi: 0 }));
  const n = geo.n;

  for (let i = 0; i < n; i++) {
    if (!geo.valid[i]) continue;

    const m = geo.month[i];
    const GHIv = geo.GHI[i];
    if (GHIv <= 0) continue;
    monthly[m].ghi += GHIv / 1000;

    const cosAzDiff = geo.cosAz[i] * cosP + geo.sinAz[i] * sinP;
    const ci = geo.sinElev[i] * cosT + geo.cosElev[i] * sinT * cosAzDiff;
    const cosTheta = ci > 0 ? ci : 0;
    const DNIv = geo.DNI[i], DIFv = geo.DIF[i];
    const cosZen = geo.sinElev[i];
    const Rb = cosZen > 0.01 ? Math.min(cosTheta / cosZen, 10) : 0;

    sumGHI += kWc * (GHIv / 1000);

    // 1. Transposition (ideal, before horizon)
    let Gb = DNIv * cosTheta;
    let Gd = DIFv * (geo.Ai[i] * Rb + (1 - geo.Ai[i]) * diffuseIso);
    const Gr = GHIv * groundTerm;
    const GtIdeal = Gb + Gd + Gr;
    sumIdeal += kWc * (GtIdeal / 1000);

    // 2. Horizon shading (beam + diffuse reduction via sky view factor)
    if (horizonLookup) {
      // Clamp bin to [0, 359] to guard against FP noise at the ±180° boundary
      const bin = Math.min(359, Math.max(0, Math.floor(geo.azimuthDeg[i]) + 180));
      const hEl = horizonLookup[bin];
      const sEl = toDeg(Math.asin(clamp(geo.sinElev[i], -1, 1)));
      
      // Block beam if sun is below horizon
      if (sEl <= hEl) Gb = 0;
      
      // Reduce diffuse by sky view factor (simplified PVsyst model)
      const fSky = Math.max(0, 1 - Math.sin(toRad(hEl)));
      Gd *= fSky;
    }

    const Gt = Gb + Gd + Gr;
    if (Gt <= 0) continue;

    sumAfterHorizon += kWc * (Gt / 1000);
    sumGti += Gt / 1000;
    monthly[m].gti += Gt / 1000;

    // 3. IAM (Incidence Angle Modifier) - Martin & Ruiz model
    const iam = cosTheta <= COS85 ? 0 : (1 - Math.exp(-cosTheta / AOI_AR)) / AOI_DENOM;
    const GtIAM = Gt * iam;
    sumAfterIAM += kWc * (GtIAM / 1000);
    if (GtIAM <= 0) continue;

    // 4. Spectral correction
    const specFact = geo.specFact[i];
    const GtSpec = GtIAM * specFact;
    sumAfterSpec += kWc * (GtSpec / 1000);
    if (GtSpec <= 0) continue;

    // 5. Cell temperature — Sandia model (PVGIS)
    const Tc = geo.Ta[i] + Gt * expArr[i] + (Gt / 1000) * dT;
    const T = Tc - 25;
    const G_ratio = GtSpec / 1000;
    const lnG = Math.log(G_ratio);

    // 5a. Low-irradiance only (at 25°C)
    const effLi = 1 + panel.k1 * lnG + panel.k2 * lnG * lnG;
    const pKwLi = G_ratio * Math.max(0, effLi);
    sumAfterLowIrrad += kWc * pKwLi;

    // 5b. Temperature effect
    const effTotal = effLi + panel.k3 * T + panel.k4 * T * lnG + panel.k5 * T * lnG * lnG + panel.k6 * T * T;
    const pKw = G_ratio * Math.max(0, effTotal);
    sumAfterTemp += kWc * pKw;

    const actual = kWc * pKw;
    annualAC += actual;
    monthly[m].ac += actual;
  }

  return {
    annualAC, annualGti: sumGti, monthly,
    sumGHI, sumIdeal, sumAfterHorizon, sumAfterIAM, sumAfterSpec, sumAfterLowIrrad, sumAfterTemp
  };
}

function computeSectionProd(hourly, lat, lng, tilt, azPV, mount, panel, kWc, albedo, horizonLookup) {
  const geo = getSolarGeometry(hourly, lat, lng);
  return computeSectionProdFast(geo, tilt, azPV, mount, panel, kWc, albedo, horizonLookup);
}


// ─── 8. OPTIMAL TILT SEARCH ─────────────────────────────────────────────────
// Golden-section search: production vs. tilt is unimodal for a fixed azimuth.
// Reduces ~61 evaluations to ~10, then a final 4° sweep for exact integer result.

function findOptimalTilt(hourly, lat, lng, azPV, mount, panel, kWc, albedo, horizonLookup) {
  const geo = getSolarGeometry(hourly, lat, lng);
  const phi = (Math.sqrt(5) - 1) / 2;   // 0.6180339…
  let a = 0, b = 60;
  let c = Math.round(b - phi * (b - a));
  let d = Math.round(a + phi * (b - a));

  let fc = computeSectionProdFast(geo, c, azPV, mount, panel, kWc, albedo, horizonLookup).annualAC;
  let fd = computeSectionProdFast(geo, d, azPV, mount, panel, kWc, albedo, horizonLookup).annualAC;

  while (b - a > 3) {
    if (fc > fd) {
      b = d; d = c; fd = fc;
      c = Math.round(b - phi * (b - a));
      fc = computeSectionProdFast(geo, c, azPV, mount, panel, kWc, albedo, horizonLookup).annualAC;
    } else {
      a = c; c = d; fc = fd;
      d = Math.round(a + phi * (b - a));
      fd = computeSectionProdFast(geo, d, azPV, mount, panel, kWc, albedo, horizonLookup).annualAC;
    }
  }

  let bestTilt = a, bestProd = -1;
  for (let t = a; t <= b; t++) {
    const r = computeSectionProdFast(geo, t, azPV, mount, panel, kWc, albedo, horizonLookup);
    if (r.annualAC > bestProd) { bestProd = r.annualAC; bestTilt = t; }
  }
  return bestTilt;
}

function findDustSafeTiltFast(geo, azPV, mount, panel, kWc, albedo, optTilt, optProd, horizonLookup) {
  if (optTilt >= 15) return null;
  const THRESHOLD = 0.996;
  const r15 = computeSectionProdFast(geo, 15, azPV, mount, panel, kWc, albedo, horizonLookup);
  const r15Ratio = r15.annualAC / optProd;
  if (r15Ratio < THRESHOLD) return { tilt: 15, ratio: r15Ratio };
  let best = 15, bestRatio = r15Ratio;
  for (let t = 16; t <= 60; t++) {
    const r = computeSectionProdFast(geo, t, azPV, mount, panel, kWc, albedo, horizonLookup);
    const ratio = r.annualAC / optProd;
    if (ratio >= THRESHOLD) { best = t; bestRatio = ratio; }
    else break;
  }
  return { tilt: best, ratio: bestRatio };
}


// ─── 9. SUN PATH COMPUTATION ────────────────────────────────────────────────

// Manual sun path calculation (fallback when SunCalc unavailable)
function computeSunPathManual(lat, lng, month, day) {
  const data = [];
  const lR = lat * Math.PI / 180;
  const sinLat = Math.sin(lR), cosLat = Math.cos(lR);
  const doy = dayOfYear(month, day);
  const dec = declination(doy);
  const dR = dec * Math.PI / 180;
  const eot = equationOfTime(doy);
  let lastAz = null;

  for (let h = 0; h < 24; h += 1/6) {
    const hsa = (h + lng / 15 + eot / 60 - 12) * 15;
    const hR = hsa * Math.PI / 180;
    const sinEl = sinLat * Math.sin(dR) + cosLat * Math.cos(dR) * Math.cos(hR);
    if (sinEl <= 0) continue;

    const elev = Math.asin(Math.min(Math.max(sinEl, -1), 1)) * 180 / Math.PI;
    const cosAzS = (Math.sin(dR) - sinLat * sinEl) / Math.max(cosLat * Math.cos(Math.asin(sinEl)), 0.001);
    let az = Math.acos(Math.min(Math.max(cosAzS, -1), 1)) * 180 / Math.PI;
    if (hsa > 0) az = 360 - az;

    let azNorm = az;
    const isNorth = lat >= 0;
    if (!isNorth && azNorm < 0) azNorm += 360;

    if (lastAz !== null && Math.abs(azNorm - lastAz) > 180) {
      data.push({ x: NaN, y: NaN });
    }
    data.push({ x: azNorm, y: Math.max(0, elev) });
    lastAz = azNorm;
  }
  return data;
}

// Sun path for a given date (uses SunCalc when available)
function computeSunPathForDate(lat, lng, month, day) {
  if (typeof SunCalc !== 'undefined') {
    return computeSunPathSunCalc(lat, lng, month, day);
  }
  return computeSunPathManual(lat, lng, month, day);
}

// Sun path using SunCalc library (matches optimal-tilt.js)
function computeSunPathSunCalc(lat, lon, month, day) {
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


// ─── 10. DATA FETCHING ──────────────────────────────────────────────────────

async function fetchWithTimeout(url, ms = 8000) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal }); }
  finally { clearTimeout(id); }
}

// ── PVGIS parsing delegated to api-pvgis.js module ──────

function averageYearlyData(yearData) {
  const fields = ['direct_normal_irradiance','diffuse_radiation','temperature_2m','wind_speed_10m'];
  if (yearData.length === 0) throw new Error('No data available');
  if (yearData.length === 1) return { hourly: yearData[0], yearly: null };
  const ref = yearData[0];
  const n = ref.time.length;
  // Manual copy instead of JSON.parse/stringify (avoids GC pressure)
  const result = {
    time: ref.time.slice(),
    direct_normal_irradiance: new Float64Array(n),
    diffuse_radiation: new Float64Array(n),
    temperature_2m: new Float64Array(n),
    wind_speed_10m: new Float64Array(n)
  };
  for (const f of fields) {
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (const yd of yearData) {
        if (i < yd[f].length) { sum += yd[f][i]; count++; }
      }
      result[f][i] = count > 0 ? sum / count : 0;
    }
  }
  return { hourly: result, yearly: yearData };
}

// ── PVGIS Cache (memory + localStorage) ──────
// Delegated to api-pvgis.js module — no duplicate cache logic needed

async function fetchWeatherPVGIS(lat, lon, mode, selectedYear) {
  let startYear, endYear;
  if (mode === 'multi') {
    if (selectedYear && selectedYear !== 'auto') {
      endYear = Math.min(parseInt(selectedYear), 2023);
      startYear = Math.max(endYear - 9, 2005);
    } else {
      endYear = 2023;
      startYear = 2014;
    }
  } else {
    endYear = (selectedYear && selectedYear !== 'auto') ? Math.min(parseInt(selectedYear), 2023) : 2023;
    startYear = endYear;
  }
  const hours = await PVGIS.getHourlyData({ lat, lon, startyear: startYear, endyear: endYear });
  const rawHourly = hours.outputs ? hours.outputs.hourly : hours;
  if (!rawHourly || rawHourly.length === 0) throw new Error('PVGIS: no data');

  const meta = hours.inputs ? hours.inputs.meteo_data : {};
  const radDb = meta.radiation_db || 'PVGIS';
  const meteoDb = meta.meteo_db || null;
  const yearMin = meta.year_min || null;
  const yearMax = meta.year_max || null;

  const allYears = PVGIS.groupByYear(PVGIS.parseHourlyEntries(rawHourly));
  if (allYears.length === 0) throw new Error('PVGIS: no usable data');

  let result;
  if (mode === 'multi') {
    result = averageYearlyData(allYears);
  } else {
    const lastYd = allYears[allYears.length - 1];
    result = { hourly: lastYd, yearly: null };
  }
  result.radDb = radDb;
  result.meteoDb = meteoDb;
  result.yearMin = yearMin;
  result.yearMax = yearMax;
  result.availableYears = allYears.map(yd => yd.time[0].substring(0, 4));
  return result;
}

async function fetchWeatherOpenMeteo(lat, lon, mode, selectedYear) {
  const currentYear = new Date().getFullYear();
  let startYear, endYear;
  if (mode === 'multi') {
    if (selectedYear && selectedYear !== 'auto') {
      endYear = parseInt(selectedYear);
      startYear = endYear - 9;
    } else {
      endYear = currentYear - 1;
      startYear = endYear - 9;
    }
  } else if (selectedYear && selectedYear !== 'auto') {
    startYear = endYear = parseInt(selectedYear);
  } else {
    endYear = currentYear - 1;
    startYear = endYear;
  }
  const startDate = startYear + '-01-01';
  const endDate = endYear + '-12-31';
  const p = new URLSearchParams({
    latitude: lat, longitude: lon,
    hourly: 'direct_normal_irradiance,diffuse_radiation,temperature_2m,wind_speed_10m',
    timezone: 'UTC', start_date: startDate, end_date: endDate
  });
  const r = await fetchWithTimeout(`https://archive-api.open-meteo.com/v1/archive?${p}`, 20000);
  if (!r.ok) throw new Error('Open-Meteo: ' + r.status);
  const d = await r.json();
  const h = d.hourly;
  const byYear = {};
  for (let i = 0; i < h.time.length; i++) {
    const yr = h.time[i].substring(0, 4);
    if (!byYear[yr]) byYear[yr] = { time: [], direct_normal_irradiance: [], diffuse_radiation: [], temperature_2m: [], wind_speed_10m: [] };
    byYear[yr].time.push(h.time[i] + 'Z');
    byYear[yr].direct_normal_irradiance.push(Math.max(0, h.direct_normal_irradiance[i] || 0));
    byYear[yr].diffuse_radiation.push(Math.max(0, h.diffuse_radiation[i] || 0));
    byYear[yr].temperature_2m.push(h.temperature_2m[i] || 0);
    byYear[yr].wind_speed_10m.push(h.wind_speed_10m[i] || 0);
  }
  const allYears = Object.keys(byYear).sort().map(k => byYear[k]);
  if (allYears.length === 0) throw new Error('No weather data');
  let result;
  if (mode === 'multi' && allYears.length > 1) {
    result = averageYearlyData(allYears);
  } else {
    result = { hourly: allYears[0], yearly: null };
  }
  result.radDb = 'ERA5';
  result.meteoDb = 'ERA5';
  result.yearMin = startYear;
  result.yearMax = endYear;
  result.availableYears = allYears.map(yd => yd.time[0].substring(0, 4));
  return result;
}

async function fetchWeather(lat, lon, mode, selectedYear) {
  // Open-Meteo is faster and more reliable — try it first
  try {
    return await fetchWeatherOpenMeteo(lat, lon, mode, selectedYear);
  } catch (e) {
    console.warn('Open-Meteo unavailable, fallback PVGIS:', e.message);
    showToast('Open-Meteo indisponible. Utilisation de PVGIS (plus lent).', 'warning');
    return await fetchWeatherPVGIS(lat, lon, mode, selectedYear);
  }
}

async function fetchHorizonPVGIS(lat, lon) {
  try {
    const d = await PVGIS.getHorizon({ lat, lon });
    return PVGIS.parseHorizonProfile(d, lat);
  } catch {
    return null;
  }
}

// ─── 10b. PREFETCH WEATHER DATA ON LOCATION CHANGE ──────────────────────────

let _prefetchController = null;

function prefetchWeatherData(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;

  if (_prefetchController) _prefetchController.abort();
  _prefetchController = new AbortController();

  const promise = (async () => {
    const [weather, horizonRaw] = await Promise.all([
      fetchWeather(lat, lng, 'single', 'auto'),
      fetchHorizonPVGIS(lat, lng).catch(() => null)
    ]);
    return { weather, horizonRaw };
  })();

  _pendingWeatherFetch = promise;
  promise.catch(() => {}).finally(() => {
    if (_pendingWeatherFetch === promise) _pendingWeatherFetch = null;
  });
}

function triggerPrefetch() {
  const lat = parseFloat(document.getElementById('lat').value);
  const lng = parseFloat(document.getElementById('lng').value);
  if (isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0)) {
    prefetchWeatherData(lat, lng);
  }
}


// ─── 11. UI: MAP & LOCATION ─────────────────────────────────────────────────

const savedMapPos = JSON.parse(localStorage.getItem('sera-map-position'));
const map = L.map('map', {
  center: savedMapPos ? [savedMapPos.lat, savedMapPos.lng] : [-12.277963, 49.291374],
  zoom: savedMapPos ? savedMapPos.zoom : 13,
  zoomControl: false
});

map.on('moveend', () => {
  const c = map.getCenter();
  localStorage.setItem('sera-map-position', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
});

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; Esri',
  maxZoom: 19
}).addTo(map);

const marker = L.marker([-12.277963, 49.291374], { draggable: true }).addTo(map);

let ignoreNextUpdate = false;

function fetchElevation(lat, lng) {
  const el = document.getElementById('elevation');
  el.dataset.status = 'loading';
  fetchWithTimeout(`https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lng}`)
    .then(r => r.json()).then(d => { el.value = d.results[0].elevation.toFixed(1); el.dataset.status = 'ok'; })
    .catch(() => { el.value = ''; el.dataset.status = 'err'; });
}

function updateFromCoords(lat, lng) {
  ignoreNextUpdate = true;
  document.getElementById('lat').value = lat.toFixed(6);
  document.getElementById('lng').value = lng.toFixed(6);
  marker.setLatLng([lat, lng]);
  map.setView([lat, lng], map.getZoom(), { animate: true });
  fetchElevation(lat, lng);
  triggerPrefetch();
  setTimeout(() => { ignoreNextUpdate = false; }, 100);
}

map.on('click', e => updateFromCoords(e.latlng.lat, e.latlng.lng));
marker.on('dragend', e => { const p = marker.getLatLng(); updateFromCoords(p.lat, p.lng); });

document.getElementById('lat').addEventListener('input', onCoordInput);
document.getElementById('lng').addEventListener('input', onCoordInput);

function onCoordInput() {
  if (ignoreNextUpdate) return;
  const lat = parseFloat(document.getElementById('lat').value);
  const lng = parseFloat(document.getElementById('lng').value);
  if (!isNaN(lat) && !isNaN(lng)) { marker.setLatLng([lat, lng]); map.setView([lat, lng], map.getZoom(), { animate: true }); fetchElevation(lat, lng); triggerPrefetch(); }
}

const locationInput = document.getElementById('location');
locationInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') geocodeLocation(this.value); });

function geocodeLocation(query) {
  if (!query.trim()) return;
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`)
    .then(r => r.json())
    .then(d => { if (d.length > 0) updateFromCoords(parseFloat(d[0].lat), parseFloat(d[0].lon)); })
    .catch(() => {});
}

updateFromCoords(-12.277963, 49.291374);


// ─── 11b. MODE SWITCH (Simple / Expert) ──────────────────────────────────────

let SERA_MODE = localStorage.getItem('sera-sim-mode') || 'beginner';
function isBeginnerMode() { return SERA_MODE !== 'expert'; }

// Friendlier KPI wording for beginners (swapped back when leaving Simple mode)
const BEGINNER_KPI = [
  ['Production annuelle', 'Énergie produite par vos panneaux en un an'],
  ['Rendement par panneau', 'Ce que chaque kW de panneaux vous apporte'],
  ['Taux de fonctionnement', 'Par rapport au maximum théorique'],
  ['Efficacité globale', 'Performance de l’ensemble du système']
];
const EXPERT_KPI = [
  ['Production annuelle', 'Énergie totale produite par an'],
  ['Productible spécifique', 'Énergie par kWc installé'],
  ['Facteur de charge', 'Production réelle vs maximum théorique'],
  ['Ratio de performance', '']
];

function setMode(mode) {
  SERA_MODE = mode === 'expert' ? 'expert' : 'beginner';
  localStorage.setItem('sera-sim-mode', SERA_MODE);
  applyMode();
}

function applyMode() {
  document.body.classList.toggle('mode-beginner', isBeginnerMode());
  document.body.classList.toggle('mode-expert', !isBeginnerMode());

  const beginBtn = document.getElementById('mode-beginner-btn');
  const expertBtn = document.getElementById('mode-expert-btn');
  if (beginBtn) beginBtn.classList.toggle('mode-btn--active', isBeginnerMode());
  if (expertBtn) expertBtn.classList.toggle('mode-btn--active', !isBeginnerMode());

  const hint = document.getElementById('mode-hint');
  if (hint) {
    hint.textContent = isBeginnerMode()
      ? 'Mode simple — nous choisissons des valeurs par défaut sensées pour vous. Passez en Expert pour un contrôle total.'
      : 'Mode expert — contrôle total sur chaque paramètre. Débutant ? Essayez le mode Simple.';
  }

  document.getElementById('beginner-panel').style.display = isBeginnerMode() ? 'block' : 'none';
  document.getElementById('expert-panel').style.display = isBeginnerMode() ? 'none' : 'block';

  const fullLabel = document.getElementById('r-report-full-label');
  if (fullLabel) fullLabel.textContent = isBeginnerMode() ? 'Résumé PDF' : 'Rapport complet';

  // Friendlier KPI wording inside the report KPI row 1
  const kpiRow = document.getElementById('r-kpis-row1');
  if (kpiRow) {
    const labels = kpiRow.querySelectorAll('.kpi-label');
    const subs = kpiRow.querySelectorAll('.kpi-sub');
    const defs = isBeginnerMode() ? BEGINNER_KPI : EXPERT_KPI;
    labels.forEach((el, i) => { if (defs[i]) el.textContent = defs[i][0]; });
    subs.forEach((el, i) => { if (defs[i] && defs[i][1]) el.textContent = defs[i][1]; });
  }

  // When a report already exists and its hidden charts become visible again,
  // re-measure them so they are not drawn at zero width.
  const reportArea = document.getElementById('report-area');
  if (!isBeginnerMode() && reportArea && reportArea.classList.contains('visible')) {
    Object.values(chartInstances).forEach(c => { try { c.resize(); } catch (e) {} });
  }
}

// ─── 11c. BEGINNER FORM BINDINGS ─────────────────────────────────────────────

// Keep the two location inputs in sync (beginner field + expert field)
const bfLocation = document.getElementById('bf-location');
if (bfLocation) {
  bfLocation.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const expertLoc = document.getElementById('location');
    if (expertLoc) expertLoc.value = bfLocation.value;
    geocodeLocation(bfLocation.value);
  });
}

const bfSize = document.getElementById('bf-size');
const bfCost = document.getElementById('bf-cost');
let bfCostTouched = false;
if (bfCost) {
  bfCost.addEventListener('input', () => { bfCostTouched = true; });
}
if (bfSize) {
  const updateSizeHint = () => {
    const kw = parseFloat(bfSize.value) || 1;
    const out = document.getElementById('bf-size-out');
    if (out) out.textContent = kw.toFixed(1).replace('.0', '');
    const hint = document.getElementById('bf-size-hint');
    if (hint) {
      const panels = Math.max(1, Math.round(kw * 2.5));
      const area = Math.round(kw * 6.5);
      hint.textContent = `Cela représente environ ${panels} panneaux, soit ~${area} m² de toiture. Un doute ? Commencez avec 3 kW.`;
    }
    // Keep the suggested installation cost in step with the system size
    if (!bfCostTouched) {
      bfCost.value = Math.max(100, Math.round(kw * 1000));
    }
  };
  bfSize.addEventListener('input', updateSizeHint);
  updateSizeHint();
}

// Push the simple-form choices onto the hidden PV section used by the engine
function syncSectionFromBeginner() {
  const sec = document.querySelector('#sections-container > div');
  if (!sec) return;
  const kw = parseFloat(document.getElementById('bf-size').value) || 1;
  const mount = document.getElementById('bf-mount').value;
  const panelKey = document.getElementById('bf-panel').value;
  const lat = getVal('lat', 0, -90, 90);

  sec.querySelector('.section-puissance').value = kw;
  sec.querySelector('.section-type').value = mount === 'ground' ? 'freestanding' : 'toiture';
  sec.querySelector('.section-panel-type').value = panelKey;
  sec.querySelector('.section-efficiency').value = PANEL_TYPES[panelKey].eff;
  const opt = sec.querySelector('.section-opt-angle');
  if (opt && !opt.checked) opt.checked = true;
  const az = sec.querySelector('.section-azimuth');
  if (az) az.value = lat >= 0 ? 0 : 180;   // face the equator
  const multi = document.getElementById('multi-year');
  if (multi && multi.checked) multi.checked = false;

  // Financial: total cost (€) → €/kWc, and electricity price (€/kWh)
  const invCostEl = document.getElementById('inv-cost');
  if (invCostEl) invCostEl.value = (parseFloat(bfCost ? bfCost.value : '') || kw * 1000) / Math.max(kw, 0.01);
  const elecPriceEl = document.getElementById('elec-price');
  if (elecPriceEl) elecPriceEl.value = document.getElementById('bf-price').value;
}

const beginRunBtn = document.getElementById('simulate-btn-beginner');
if (beginRunBtn) beginRunBtn.addEventListener('click', runSimulation);

applyMode();


// ─── 12. UI: SECTION TABS ───────────────────────────────────────────────────

let sectionCount = 0, activeSection = 0;

function addSection() {
  sectionCount++;
  const tpl = document.getElementById('section-tpl');
  const clone = tpl.content.cloneNode(true);
  document.getElementById('sections-container').appendChild(clone);
  renderTabs();
  activateSection(sectionCount);
}

function removeSection(idx) {
  const cards = document.querySelectorAll('#sections-container > div');
  if (cards.length <= 1) return;
  const card = cards[idx - 1];
  if (card) card.remove();
  sectionCount = document.querySelectorAll('#sections-container > div').length;
  if (activeSection === idx) activateSection(Math.min(idx, sectionCount));
  renderTabs();
}

function renderTabs() {
  const container = document.getElementById('section-tabs');
  container.innerHTML = '';
  const cards = document.querySelectorAll('#sections-container > div');
  cards.forEach((_, i) => {
    const n = i + 1;
    const tab = document.createElement('div');
    tab.className = `section-tab${activeSection === n ? ' active' : ''}`;
    const kwLabel = lastSecResults && lastSecResults[i] ? ` (${lastSecResults[i].kWc.toFixed(2)} kWc)` : '';
    tab.style.cssText = 'font-size: 0.7rem; border: 1px solid var(--border-mid); padding: 0.25rem 0.625rem; display: flex; align-items: center; gap: 0.5rem;';
    tab.innerHTML = `<span>Champ ${n}${kwLabel}</span><span class="close-btn" style="color: var(--text-mid); font-size:12px; line-height:1; cursor: pointer;">&times;</span>`;
    tab.querySelector('span:first-child').addEventListener('click', () => activateSection(n));
    tab.querySelector('.close-btn').addEventListener('click', e => { e.stopPropagation(); removeSection(n); });
    container.appendChild(tab);
  });
}

function activateSection(n) {
  activeSection = n;
  const cards = document.querySelectorAll('#sections-container > div');
  cards.forEach((c, i) => c.style.display = (i + 1 === n) ? 'block' : 'none');
  renderTabs();
}

document.getElementById('add-section').addEventListener('click', addSection);
addSection();

document.addEventListener('change', e => {
  if (e.target.matches('.section-panel-type')) {
    const sec = e.target.closest('#sections-container > div');
    if (!sec) return;
    const effInput = sec.querySelector('.section-efficiency');
    if (effInput) effInput.value = PANEL_TYPES[e.target.value].eff;
  }
});


// ─── 14. UI: PROGRESS BAR & TOAST ───────────────────────────────────────────

function updateProgress(pct, msg) {
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  const overlayText = document.getElementById('loading-text');
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = msg;
  if (overlayText) overlayText.textContent = msg;
}

function showProgress(show) {
  const area = document.getElementById('progress-area');
  if (area) area.style.display = show ? 'block' : 'none';
}

function showToast(msg, type = 'error') {
  const el = document.getElementById('toast');
  if (!el) return;
  const d = document.createElement('div');
  const styles = {
    error:   'border: 1px solid #991b1b; background: #2a0a0a; color: #fca5a5;',
    success: 'border: 1px solid #166534; background: #0a2a0a; color: #86efac;',
    warning: 'border: 1px solid #92400e; background: #2a1a0a; color: #fcd34d;'
  };
  d.style.cssText = (styles[type] || styles.error) + ' font-size: 0.75rem; padding: 0.625rem 1rem; border-radius: 2px; opacity: 1; transition: opacity 0.4s;';
  d.textContent = msg;
  el.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 400); }, type === 'warning' ? 8000 : 5000);
}

function fmtCurrency(v) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtKg(v) {
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kg';
}

document.addEventListener('change', e => {
  if (e.target.id === 'multi-year') {
    const warn = document.getElementById('multi-year-warn');
    if (warn) warn.style.display = e.target.checked ? 'block' : 'none';
  }
});


// ─── 15. CHARTS ─────────────────────────────────────────────────────────────

let chartInstances = {};

function destroyCharts() {
  Object.values(chartInstances).forEach(c => c.destroy());
  Object.keys(chartInstances).forEach(k => delete chartInstances[k]);
  // Clear canvas contexts to prevent memory leaks
  document.querySelectorAll('canvas').forEach(c => {
    const ctx = c.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, c.width, c.height);
  });
}

// ── IEC-compliant P90 helpers ───────────────────
// Student's t critical values at 90th percentile (one-tailed)
// P90 = μ − t(0.90, N−1) × s × √(1 + 1/N)
const _t90 = [null, 3.078, 1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372,
  1.363, 1.356, 1.350, 1.345, 1.341, 1.337, 1.333, 1.330, 1.328, 1.325,
  1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313, 1.311, 1.310];
function studentT90(df) { return df >= _t90.length ? 1.282 : _t90[df]; }
function sampleStd(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
}
function predictionFactor(n) { return Math.sqrt(1 + 1 / n); }

const CHART_DEFAULTS = {
  tooltip: {
    backgroundColor: 'rgba(14, 18, 23, 0.97)',
    titleColor: '#EAE6F0',
    bodyColor: '#CCC',
    borderColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    cornerRadius: 4,
    padding: 10,
    bodyFont: { size: 11 },
    titleFont: { size: 11, weight: '600' }
  },
  xGrid: { display: false },
  yGrid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
  tick: { color: '#5A5670', font: { size: 9 } }
};

function makeChart(canvasId, type, labels, datasets, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(canvas, {
    type,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...CHART_DEFAULTS.tooltip }
      },
      scales: {
        x: {
          ticks: { ...CHART_DEFAULTS.tick, maxRotation: 0 },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          ticks: { ...CHART_DEFAULTS.tick, maxTicksLimit: 6 },
          grid: { ...CHART_DEFAULTS.yGrid }
        }
      },
      ...opts
    }
  });
}

function makeProdVsAngleChart(angles, energies, optimalAngle, dustRec) {
  const canvas = document.getElementById('chart-prod-angle');
  if (!canvas) return;
  if (chartInstances['chart-prod-angle']) chartInstances['chart-prod-angle'].destroy();

  const colors = angles.map(a => {
    if (Math.abs(a - optimalAngle) < 1) return '#FF6B2B';
    if (dustRec && Math.abs(a - dustRec.angle) < 1) return '#22c55e';
    return 'rgba(255, 107, 43, 0.25)';
  });

  chartInstances['chart-prod-angle'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: angles,
      datasets: [{
        data: energies,
        backgroundColor: colors,
        borderColor: colors,
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
          ...CHART_DEFAULTS.tooltip,
          callbacks: {
            title: (items) => items[0].label + '° d’inclinaison',
            label: (item) => item.raw.toFixed(0) + ' kWh/kWc'
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Angle d’inclinaison (°)', color: '#888' },
          ticks: { ...CHART_DEFAULTS.tick, maxTicksLimit: 10 },
          grid: { display: false }
        },
        y: {
          title: { display: true, text: 'kWh/kWc', color: '#888' },
          ticks: { ...CHART_DEFAULTS.tick },
          grid: { ...CHART_DEFAULTS.yGrid }
        }
      }
    }
  });
}

function makePRChart(monthlyAC, monthlyGti, totalKwp) {
  const pr = monthlyAC.map((ac, i) => {
    const gti = monthlyGti[i] || 0;
    return gti > 0 ? (ac / (gti * totalKwp)) : 0;
  });
  makeChart('chart-pr', 'line', MONTH_LABELS, [{
    label: 'PR mensuel',
    data: pr,
    borderColor: '#FF6B2B',
    backgroundColor: 'rgba(255, 107, 43, 0.1)',
    fill: true,
    borderWidth: 2,
    pointRadius: 3,
    pointBackgroundColor: '#FF6B2B',
    pointHoverRadius: 5,
    tension: 0.3
  }], {
    animation: { duration: 600, easing: 'easeOutQuart' },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...CHART_DEFAULTS.tooltip,
        callbacks: { label: ctx => 'PR: ' + ctx.parsed.y.toFixed(3) }
      }
    },
    scales: {
      x: {
        title: { display: true, text: 'Mois', color: '#888' },
        ticks: { ...CHART_DEFAULTS.tick },
        grid: { display: false }
      },
      y: {
        beginAtZero: true, max: 1,
        title: { display: true, text: 'PR', color: '#888' },
        ticks: { ...CHART_DEFAULTS.tick, callback: v => v.toFixed(2) },
        grid: { ...CHART_DEFAULTS.yGrid }
      }
    }
  });
}

function gaussian(x, mu, sigma) {
  return (1 / (sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
}
function normalCDF(x, mu, sigma) {
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}
function erf(z) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z);
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return sign * y;
}

function makeP50P90Chart(yearlyAC, p50, p90) {
  const canvasPdf = document.getElementById('chart-variability-pdf');
  const canvasCdf = document.getElementById('chart-variability-cdf');
  if (!canvasPdf || !canvasCdf) return;

  const mu = p50;
  const sigma = yearlyAC.length > 1 ? sampleStd(yearlyAC) : 0;
  if (sigma <= 0) {
    ['variability-pdf-wrap', 'variability-cdf-wrap'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    return;
  }

  ['variability-pdf-wrap', 'variability-cdf-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'block';
  });

  ['chart-variability-pdf', 'chart-variability-cdf'].forEach(id => {
    if (chartInstances[id]) chartInstances[id].destroy();
  });

  const xMin = mu - 4 * sigma;
  const xMax = mu + 4 * sigma;
  const pts = 120;
  const xVals = Array.from({ length: pts }, (_, i) => xMin + (xMax - xMin) * i / (pts - 1));
  const pdfVals = xVals.map(x => gaussian(x, mu, sigma));
  const cdfVals = xVals.map(x => normalCDF(x, mu, sigma));
  const pdfMax = Math.max(...pdfVals);

  const yP50 = gaussian(p50, mu, sigma);
  const yP90 = gaussian(p90, mu, sigma);
  const cdfP50 = normalCDF(p50, mu, sigma);
  const cdfP90 = normalCDF(p90, mu, sigma);

  const fmt = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: 0 }) + ' kWh';
  const p50Label = fmt(p50);
  const p90Label = fmt(p90);

  const isP50 = (x) => Math.abs(x - p50) / Math.max(1, p50) < 0.01;
  const isP90 = (x) => Math.abs(x - p90) / Math.max(1, p90) < 0.01;

  // Build per-point tooltip hit areas (no visible dots — reference lines drawn by plugin)
  const pdfHitRad = xVals.map(x => isP50(x) || isP90(x) ? 12 : 0);
  const cdfHitRad = xVals.map(x => isP50(x) || isP90(x) ? 12 : 0);

  const reflineData = { p50, p90, mu: mu, sigma, p50Label, p90Label, yP50, yP90, cdfP50, cdfP90 };

  // ── PDF (bell curve) ──
  const pdfCtx = canvasPdf.getContext('2d');
  chartInstances['chart-variability-pdf'] = new Chart(pdfCtx, {
    type: 'line',
    data: {
      labels: xVals.map(x => Math.round(x)),
      datasets: [{
        label: 'Densité de probabilité',
        data: pdfVals,
        borderColor: '#FF6B2B',
        backgroundColor: 'rgba(255, 107, 43, 0.05)',
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: pdfHitRad,
        tension: 0.4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: {
          backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
          borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8,
          callbacks: {
            title: items => {
              const v = parseInt(items[0].label);
              let extra = '';
              if (Math.abs(v - p50) / Math.max(1, p50) < 0.02) extra = ' \u2190 P50';
              else if (Math.abs(v - p90) / Math.max(1, p90) < 0.02) extra = ' \u2190 P90';
              return fmt(v) + extra;
            },
            label: items => 'Densité : ' + items.parsed.y.toExponential(3)
          }
        }
      },
      scales: {
        x: { display: false },
        y: { display: false, beginAtZero: true, max: pdfMax * 1.12 }
      }
    }
  });
  chartInstances['chart-variability-pdf']._reflineData = reflineData;

  // ── CDF (S-curve) ──
  const cdfCtx = canvasCdf.getContext('2d');
  chartInstances['chart-variability-cdf'] = new Chart(cdfCtx, {
    type: 'line',
    data: {
      labels: xVals.map(x => Math.round(x)),
      datasets: [{
        label: 'Probabilité cumulée',
        data: cdfVals,
        borderColor: '#FF6B2B',
        backgroundColor: 'rgba(255, 107, 43, 0.08)',
        fill: false,
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: cdfHitRad,
        tension: 0.4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: {
          backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
          borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8,
          callbacks: {
            title: items => {
              const v = parseInt(items[0].label);
              let extra = '';
              if (Math.abs(v - p50) / Math.max(1, p50) < 0.02) extra = ' \u2190 P50';
              else if (Math.abs(v - p90) / Math.max(1, p90) < 0.02) extra = ' \u2190 P90';
              return fmt(v) + extra;
            },
            label: items => 'Probabilité cumulée : P=' + (items.parsed.y * 100).toFixed(1) + '%'
          }
        }
      },
      scales: {
        x: { display: false },
        y: { min: 0, max: 1, ticks: { color: '#5A5670', font: { size: 8 }, callback: v => (v * 100).toFixed(0) + '%' }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
  chartInstances['chart-variability-cdf']._reflineData = reflineData;
}

// ── P50/P90 reference line plugin (globally registered) ──
if (!Chart.registry.plugins.get('variabilityRefLines')) {
  Chart.register({
    id: 'variabilityRefLines',
    beforeDraw(chart) {
      const d = chart._reflineData;
      if (!d) return;
      const { yP50, yP90, cdfP50, cdfP90 } = d;
      const yS = chart.scales.y, xS = chart.scales.x;
      const ctx = chart.ctx;
      const isPdf = chart.canvas.id === 'chart-variability-pdf';
      const isCdf = chart.canvas.id === 'chart-variability-cdf';
      if (!isPdf && !isCdf) return;
      const fills = isPdf
        ? [{ yVal: yP50, color: 'rgba(255, 107, 43, 0.12)' },
           { yVal: yP90, color: 'rgba(249, 115, 22, 0.12)' }]
        : [{ yVal: cdfP50, color: 'rgba(255, 107, 43, 0.10)' },
           { yVal: cdfP90, color: 'rgba(249, 115, 22, 0.10)' }];
      fills.forEach(({ yVal, color }) => {
        const y = yS.getPixelForValue(yVal);
        if (y < yS.top || y > yS.bottom) return;
        ctx.save();
        ctx.fillStyle = color;
        ctx.fillRect(xS.left, y, xS.right - xS.left, yS.bottom - y);
        ctx.restore();
      });
    },
    afterDraw(chart) {
      const d = chart._reflineData;
      if (!d) return;
      const { p50Label, p90Label, yP50, yP90, cdfP50, cdfP90 } = d;
      const yS = chart.scales.y, xS = chart.scales.x;
      const ctx = chart.ctx;
      const isPdf = chart.canvas.id === 'chart-variability-pdf';
      const isCdf = chart.canvas.id === 'chart-variability-cdf';
      if (!isPdf && !isCdf) return;
      const lines = isPdf
        ? [{ yVal: yP50, color: '#FF6B2B', label: 'P50 ' + p50Label },
           { yVal: yP90, color: '#f97316', label: 'P90 ' + p90Label }]
        : [{ yVal: cdfP50, color: '#FF6B2B', label: 'P50 ' + p50Label },
           { yVal: cdfP90, color: '#f97316', label: 'P90 ' + p90Label }];
      lines.forEach(({ yVal, color, label }) => {
        const y = yS.getPixelForValue(yVal);
        if (y < yS.top || y > yS.bottom) return;
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(xS.left, y); ctx.lineTo(xS.right, y);
        ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = 'bold 11px system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        const labelX = xS.right - tw - 14;
        const labelY = Math.max(yS.top + 14, Math.min(y - 10, yS.bottom - 6));
        ctx.fillRect(labelX, labelY - 15, tw + 12, 20);
        ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'light' ? '#222' : '#fff';
        ctx.fillText(label, labelX + 6, labelY + 1);
        ctx.restore();
      });
    }
  });
}

function makeSunPathChart(lat, lon, horizonRaw) {
  const canvas = document.getElementById('chart-sunpath');
  if (!canvas) return;
  if (chartInstances['chart-sunpath']) chartInstances['chart-sunpath'].destroy();

  const isNorth = lat >= 0;
  const summerMonth = isNorth ? 5 : 11;
  const winterMonth = isNorth ? 11 : 5;

  // Compute sun paths using SunCalc
  const summerLabel = isNorth ? 'Solstice d’été (21 juin)' : 'Solstice d’été (21 déc.)';
  const winterLabel = isNorth ? 'Solstice d’hiver (21 déc.)' : 'Solstice d’hiver (21 juin)';

  const summer = computeSunPathForDate(lat, lon, summerMonth, 21);
  const equinox = computeSunPathForDate(lat, lon, 2, 20);
  const winter = computeSunPathForDate(lat, lon, winterMonth, 21);

  // Parse horizon
  let horizonProfile = null;
  if (horizonRaw && horizonRaw.length > 0) {
    horizonProfile = horizonRaw.map(p => ({ x: p.azimuth ?? p.x, y: p.elevation ?? p.y }));
    const xMin = isNorth ? -180 : 0;
    const xMax = isNorth ? 180 : 360;
    if (horizonProfile.length > 0) {
      if (horizonProfile[0].x > xMin) horizonProfile.unshift({ x: xMin, y: horizonProfile[0].y });
      if (horizonProfile[horizonProfile.length - 1].x < xMax) horizonProfile.push({ x: xMax, y: horizonProfile[horizonProfile.length - 1].y });
    }
  } else {
    const xMin = isNorth ? -180 : 0;
    const xMax = isNorth ? 180 : 360;
    horizonProfile = [{ x: xMin, y: 0 }, { x: xMax, y: 0 }];
  }

  // Axis config based on hemisphere
  const xMin = isNorth ? -180 : 0;
  const xMax = isNorth ? 180 : 360;

  const tickCallback = (v) => {
    if (isNorth) {
      if (v === -180) return '-180° (N)';
      if (v === -90) return '-90° (E)';
      if (v === 0) return '0° (S)';
      if (v === 90) return '90° (W)';
      if (v === 180) return '180° (N)';
    } else {
      if (v === 0) return '0° (S)';
      if (v === 90) return '90° (W)';
      if (v === 180) return '180° (N)';
      if (v === 270) return '270° (E)';
      if (v === 360) return '360° (S)';
    }
    return v + '°';
  };

  chartInstances['chart-sunpath'] = new Chart(canvas, {
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
          data: horizonProfile,
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
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#888', font: { size: 10 }, usePointStyle: true } },
        tooltip: {
          backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
          borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8,
          callbacks: {
            title: () => '',
            label: (ctx) => {
              if (ctx.dataset.label === 'Horizon') return `Horizon : ${ctx.parsed.y.toFixed(1)}°`;
              return `Azimut : ${ctx.parsed.x.toFixed(1)}° | Élévation : ${ctx.parsed.y.toFixed(1)}°`;
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Azimut (°)', color: '#888' },
          min: xMin, max: xMax,
          ticks: { stepSize: 45, color: '#5A5670', callback: tickCallback },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: {
          title: { display: true, text: 'Élévation (°)', color: '#888' },
          min: 0, max: 90,
          ticks: { stepSize: 15, color: '#5A5670', callback: (v) => v + '°' },
          grid: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    }
  });
}

function makeLossHorizontalChart(sumGHI, sumIdeal, sumAfterHorizon, sumAfterIAM, sumAfterSpec, sumAfterLowIrrad, sumAfterTemp, qLoss, mLoss, sLoss, sysFactor, annualAC) {
  const canvas = document.getElementById('chart-losses');
  if (!canvas) return;
  if (chartInstances['chart-losses']) chartInstances['chart-losses'].destroy();

  const poa = sumIdeal || 1;  // POA is the real baseline for percentages

  // Compute intermediate loss steps (careful: losses are already negative percentages)
  // Note: Soiling is applied early (before horizon) per PVPMC methodology
  const sumAfterSoiling = sumIdeal * (1 - sLoss / 100);
  const sumAfterQuality = sumAfterTemp * (1 - qLoss / 100);
  const sumAfterMismatch = sumAfterQuality * (1 - mLoss / 100);
  const sumAfterSystem = sumAfterMismatch * sysFactor;

  // POA gain percentage (transposition gain/loss relative to GHI)
  const poaGainPct = ((sumIdeal - sumGHI) / (sumGHI || 1) * 100);
  const poaLabel = `POA (Transpo.) (${poaGainPct >= 0 ? '+' : ''}${poaGainPct.toFixed(1)}%)`;

  // Steps: GHI → POA → Soiling → losses → Final AC
  // Labels show % du POA (not GHI) for loss steps
  const steps = [
    { label: 'GHI',           kWh: sumGHI,         color: '#6b7280', type: 'base' },
    { label: poaLabel,        kWh: sumIdeal,       color: '#22c55e', type: 'gain' },
    { label: 'Encrassement',       kWh: sumAfterSoiling, color: '#a16207', type: 'loss' },
    { label: 'Horizon',       kWh: sumAfterHorizon, color: '#7c3aed', type: 'loss' },
    { label: 'IAM',           kWh: sumAfterIAM,     color: '#f97316', type: 'loss' },
    { label: 'Spectral',      kWh: sumAfterSpec,    color: '#ec4899', type: 'loss' },
    { label: 'Faible irradiance',     kWh: sumAfterLowIrrad, color: '#06b6d4', type: 'loss' },
    { label: 'Température',   kWh: sumAfterTemp,    color: '#ef4444', type: 'loss' },
    { label: 'Qualité',       kWh: sumAfterQuality, color: '#64748b', type: 'loss' },
    { label: 'Mismatch',      kWh: sumAfterMismatch, color: '#6366f1', type: 'loss' },
    { label: 'Câbles+ond.+PV',  kWh: sumAfterSystem,  color: '#f43f5e', type: 'loss' },
    { label: 'CA final',      kWh: annualAC,        color: '#3b82f6', type: 'final' }
  ];

  // Build horizontal bar chart data
  const labels = steps.map(s => {
    if (s.type === 'base' || s.type === 'gain' || s.type === 'final') {
      return s.label;
    }
    // For loss steps, show % du POA
    const pctOfPOA = ((s.kWh - steps[steps.indexOf(s) - 1].kWh) / poa * 100);
    return `${s.label} (${pctOfPOA >= 0 ? '+' : ''}${pctOfPOA.toFixed(1)}%)`;
  });

  const data = steps.map(s => s.kWh);
  const colors = steps.map(s => s.color);

  chartInstances['chart-losses'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 2
      }]
    },
    options: {
      indexAxis: 'y',  // Horizontal bar chart
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
          borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8, bodyFont: { size: 11 },
          callbacks: {
            label: (ctx) => {
              const step = steps[ctx.dataIndex];
              const kWh = step.kWh.toFixed(1);
              const pctPOA = ((step.kWh / poa) * 100).toFixed(1);
              const pctGHI = ((step.kWh / (sumGHI || 1)) * 100).toFixed(1);
              return `${kWh} kWh (${pctPOA} % du POA, ${pctGHI} % du GHI)`;
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Énergie (kWh)', color: '#888' },
          ticks: { color: '#5A5670' },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: {
          ticks: { color: '#5A5670', font: { size: 10 } },
          grid: { display: false }
        }
      }
    }
  });
}

function makeDiurnalChart(hourly, lat, lng) {
  const geo = getSolarGeometry(hourly, lat, lng);
  const isSouth = lat < 0;
  const seasonDefs = [
    { label: isSouth ? 'Été (déc.-fév.)' : 'Hiver (déc.-fév.)', months: [11, 0, 1], color: '#3b82f6' },
    { label: isSouth ? 'Automne (mars-mai)' : 'Printemps (mars-mai)', months: [2, 3, 4], color: '#22c55e' },
    { label: isSouth ? 'Hiver (juin-août)' : 'Été (juin-août)', months: [5, 6, 7], color: '#f97316' },
    { label: isSouth ? 'Printemps (sept.-nov.)' : 'Automne (sept.-nov.)', months: [8, 9, 10], color: '#a855f7' }
  ];

  const n = geo.n;
  const tzOffset = lng / 15;

  const datasets = seasonDefs.map(s => {
    const profile = new Array(24).fill(null).map(() => ({ sumGhi: 0, sumT: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
      const m = geo.month[i];
      if (!s.months.includes(m)) continue;
      const tStr = hourly.time[i];
      const hUTC = parseInt(tStr.slice(11, 13), 10) + parseInt(tStr.slice(14, 16), 10) / 60;
      const hLocal = (hUTC + tzOffset + 24) % 24;
      const bin = Math.min(23, Math.floor(hLocal));
      profile[bin].sumGhi += geo.GHI[i];
      profile[bin].sumT += geo.Ta[i];
      profile[bin].count++;
    }
    return {
      label: s.label,
      ghiData: profile.map(p => p.count > 0 ? p.sumGhi / p.count : 0),
      tempData: profile.map(p => p.count > 0 ? p.sumT / p.count : 0),
      borderColor: s.color
    };
  });

  const chartCanvas = document.getElementById('chart-diurnal');
  if (!chartCanvas) return;
  if (chartInstances['chart-diurnal']) chartInstances['chart-diurnal'].destroy();

  chartInstances['chart-diurnal'] = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + 'h'),
      datasets: datasets.flatMap(s => [
        { label: s.label + ' (GHI)', data: s.ghiData, borderColor: s.borderColor, backgroundColor: s.borderColor + '22', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'y', fill: true },
        { label: s.label + ' (°C)', data: s.tempData, borderColor: s.borderColor, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, tension: 0.3, yAxisID: 'y1' }
      ])
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#888', font: { size: 10 }, usePointStyle: true } },
        tooltip: {
          backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
          borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8, bodyFont: { size: 11 }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Heure locale (solaire)', color: '#888' },
          ticks: { color: '#5A5670', maxTicksLimit: 12 },
          grid: { display: false }
        },
        y: {
          beginAtZero: true, position: 'left',
          title: { display: true, text: 'GHI (W/m²)', color: '#888' },
          ticks: { color: '#5A5670' },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y1: {
          beginAtZero: false, position: 'right',
          title: { display: true, text: 'Température (°C)', color: '#888' },
          ticks: { color: '#5A5670' },
          grid: { display: false }
        }
      }
    }
  });
}

function makeCashFlowChart(totalInvest, totalKwp, annualBenefit, degradation, discountRate, lifetime, omCostPerKw, elecEscalation, omEscalation, invReplaceCost, invReplaceYear, selfConsumptionRate, annualConsumption, elecPrice, feedIn, annualAC) {
  const canvases = [];
  for (const id of ['chart-cashflow', 'chart-payback']) {
    const c = document.getElementById(id);
    if (c) canvases.push(c);
  }
  if (canvases.length === 0) return;
  canvases.forEach(c => { if (chartInstances[c.id]) chartInstances[c.id].destroy(); });

  const labels = [];
  const netCashFlows = [-totalInvest];
  const cumulativeNPV = [-totalInvest];
  const roiPct = [0];
  const yearlyBreakdown = [];

  let cumNPV = -totalInvest;
  let cumRaw = -totalInvest;
  let simplePaybackYear = null;
  let discountedPaybackYear = null;

  labels.push('Y0');
  yearlyBreakdown.push({ savings: 0, feedin: 0, om: 0, inv: totalInvest });

  for (let y = 1; y <= lifetime; y++) {
    const prodY = annualAC * Math.pow(1 - degradation, y - 1);
    const selfConsumedY = Math.min(prodY * selfConsumptionRate, annualConsumption);
    const fedToGridY = prodY - selfConsumedY;
    const elecPriceY = elecPrice * Math.pow(1 + elecEscalation, y - 1);
    const savingsY = selfConsumedY * elecPriceY;
    const feedinY = fedToGridY * feedIn;
    const benefitY = savingsY + feedinY;
    const omYCalc = (totalKwp || 1) * omCostPerKw * Math.pow(1 + omEscalation, y - 1);
    const invReplaceY = (y === invReplaceYear) ? -(totalKwp * invReplaceCost) : 0;
    const netY = benefitY - omYCalc + invReplaceY;

    netCashFlows.push(netY);
    cumRaw += netY;
    cumNPV += netY / Math.pow(1 + discountRate, y);

    labels.push('Y' + y);
    cumulativeNPV.push(cumNPV);
    roiPct.push(totalInvest > 0 ? (cumRaw + totalInvest) / totalInvest * 100 : 0);
    yearlyBreakdown.push({ savings: savingsY, feedin: feedinY, om: omYCalc, inv: Math.abs(invReplaceY) });

    if (simplePaybackYear === null && cumRaw >= 0) {
      const prevRaw = totalInvest + netCashFlows.slice(1, y).reduce((s, v) => s + v, 0);
      simplePaybackYear = y - 1 + (-prevRaw) / netY;
    }
    if (discountedPaybackYear === null && cumNPV >= 0) {
      discountedPaybackYear = y - 1 + (-cumulativeNPV[cumulativeNPV.length - 2]) / (cumNPV - cumulativeNPV[cumulativeNPV.length - 2]);
    }
  }

  const leftMin = -totalInvest * 1.1;
  const leftMax = Math.max(...cumulativeNPV, 0) * 1.1 || 1;
  const pctMin = 0;
  const pctMax = Math.max(Math.max(...roiPct, 1) * 1.2, 10);

  // Custom payback annotation plugin
  const paybackPlugin = {
    id: 'paybackLines',
    afterDraw(chart) {
      const { ctx, scales: { x, y } } = chart;
      const drawLine = (year, color, label) => {
        if (year == null) return;
        const xPos = x.getPixelForValue(year);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(xPos, y.top);
        ctx.lineTo(xPos, y.bottom);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '10px sans-serif';
        ctx.fillText(label, xPos + 4, y.top + 12);
        ctx.restore();
      };
      const pb = chart.config._paybackData || {};
      drawLine(pb.simple, '#94a3b8', 'RS simple');
      drawLine(pb.discounted, '#FF6B2B', 'RS actualisé');
    }
  };
  if (!Chart.registry.plugins.get('paybackLines')) {
    Chart.register(paybackPlugin);
  }

  canvases.forEach(canvas => {
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'VAN cumulée (€)',
            data: cumulativeNPV,
            borderColor: '#FF6B2B',
            backgroundColor: 'rgba(255, 107, 43, 0.08)',
            fill: true,
            borderWidth: 2.5,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.3,
            yAxisID: 'y'
          },
          {
            label: 'ROI (%)',
            data: roiPct,
            borderColor: '#C84BFF',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.3,
            borderDash: [5, 3],
            yAxisID: 'y1'
          }
        ]
      },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: true, labels: { color: '#888', font: { size: 10 }, usePointStyle: true } },
        tooltip: {
          backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
          borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 10, bodyFont: { size: 11 },
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (ctx.datasetIndex === 0) return 'VAN cumulée : ' + fmtCurrency(v);
              return 'ROI : ' + v.toFixed(1) + '%';
            },
            footer: (items) => {
              const bd = chart.config._yearlyBreakdown;
              if (!bd) return;
              const d = bd[items[0].dataIndex];
              if (!d) return;
              return 'Économies : ' + fmtCurrency(d.savings) + ' | Revente : ' + fmtCurrency(d.feedin) + ' | O&M : ' + fmtCurrency(d.om) + ' | Ond. : ' + fmtCurrency(d.inv);
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Année', color: '#888' },
          ticks: { color: '#5A5670', autoSkip: true, maxRotation: 0 },
          grid: { color: 'rgba(255,255,255,0.03)' }
        },
        y: {
          position: 'left',
          title: { display: true, text: 'Cumulé (€)', color: '#FF6B2B' },
          ticks: { color: '#FF6B2B', callback: v => (v >= 0 ? '+' : '') + v.toFixed(0) },
          grid: { color: 'rgba(255,255,255,0.05)' },
          min: leftMin,
          max: leftMax
        },
        y1: {
          position: 'right',
          title: { display: true, text: 'ROI (%)', color: '#C84BFF' },
          ticks: { color: '#C84BFF', callback: v => v.toFixed(0) + '%' },
          grid: { display: false },
          min: pctMin,
          max: pctMax
        }
      }
    }
  });

  chart.config._paybackData = { simple: simplePaybackYear, discounted: discountedPaybackYear };
  chart.config._yearlyBreakdown = yearlyBreakdown;
  chart.update('none');
  chartInstances[canvas.id] = chart;
  });

  // Compute IRR via binary search
  let irr = null;
  const npvAt = (rate) => netCashFlows.reduce((sum, v, i) => sum + v / Math.pow(1 + rate, i), 0);
  if (npvAt(0) >= 0) {
    let lo = 0, hi = 1;
    while (npvAt(hi) > 0 && hi < 10) hi *= 2;
    for (let iter = 0; iter < 100; iter++) {
      const mid = (lo + hi) / 2;
      if (npvAt(mid) > 0) lo = mid;
      else hi = mid;
      if (hi - lo < 1e-6) break;
    }
    irr = (lo + hi) / 2;
  }

  return { simplePaybackYear, discountedPaybackYear, irr };
}


// ─── 16. MAIN SIMULATION ────────────────────────────────────────────────────

async function runSimulation() {
  const lat = getVal('lat', 0, -90, 90);
  const lng = getVal('lng', 0, -180, 180);
  if (lat === 0 && lng === 0) return;

  if (isBeginnerMode()) syncSectionFromBeginner();

  const btn = isBeginnerMode()
    ? document.getElementById('simulate-btn-beginner')
    : document.getElementById('simulate-btn');
  btn.textContent = isBeginnerMode() ? 'Calcul de l’estimation...' : 'Simulation en cours...';
  btn.disabled = true;

  const overlay = document.getElementById('loading-overlay');
  const overlayText = document.getElementById('loading-text');
  if (overlay) { overlay.style.display = 'flex'; overlayText.textContent = 'Démarrage de la simulation...'; }

  try {
    const multiYearCheckbox = document.getElementById('multi-year');
    const useMultiYear = multiYearCheckbox && multiYearCheckbox.checked;
    const mode = useMultiYear ? 'multi' : 'single';
    const yearSelect = document.getElementById('data-year');
    const selectedYear = yearSelect ? yearSelect.value : 'auto';

    showProgress(true);
    updateProgress(5, 'Téléchargement des données météo et de l’horizon...');

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}:${mode}`;
    let weather;
    let horizonRaw;

    if (_weatherCache.has(cacheKey)) {
      const c = _weatherCache.get(cacheKey);
      weather = c.weather;
      horizonRaw = c.horizonRaw;
    } else if (mode === 'single' && _pendingWeatherFetch) {
      const r = await _pendingWeatherFetch;
      if (r && r.weather) {
        weather = r.weather;
        horizonRaw = r.horizonRaw;
      }
    }
    if (!weather) {
      const fetched = await Promise.all([
        fetchWeather(lat, lng, mode, selectedYear),
        fetchHorizonPVGIS(lat, lng).catch(() => null)
      ]);
      weather = fetched[0];
      horizonRaw = fetched[1];
    }
    _weatherCache.set(cacheKey, { weather, horizonRaw });
    const hourly = weather.hourly;

    // Validate year selector - keep selected year if available, otherwise use latest
    if (yearSelect && weather.availableYears && weather.availableYears.length > 0) {
      const currentVal = yearSelect.value;
      if (!weather.availableYears.includes(currentVal)) {
        yearSelect.value = weather.availableYears[weather.availableYears.length - 1];
      }
    }

    updateProgress(20, 'Calcul de la géométrie solaire...');

    const sections = document.querySelectorAll('#sections-container > div');
    if (sections.length === 0) { btn.textContent = 'Lancer la simulation'; btn.disabled = false; if (overlay) overlay.style.display = 'none'; return; }

    const enabledFinancial = true;
    const invCost = getVal('inv-cost', 1000, 0);
    const elecPrice = getVal('elec-price', 0.25, 0);
    const feedIn = getVal('feed-in', 0.12, 0);
    const lifetime = getVal('lifetime', 25, 1);
    const degradation = getVal('degradation', 0.5, 0) / 100;
    const discountRate = getVal('discount-rate', 4, 0) / 100;
    const co2Factor = getVal('co2-factor', 40, 0);
    const carEmissions = getVal('car-emissions', 120, 0);
    
    // Inverter AC rating for clipping (0 = auto, DC/AC = 1.0)
    const inverterAcRating = getVal('inverter-ac-rating', 0, 0);

    const geo = getSolarGeometry(hourly, lat, lng);

    // Use pre-fetched horizon data (from parallel fetch above)
    const horizonLookup = horizonRaw ? buildHorizonLookup(horizonRaw) : null;
    if (!horizonRaw) {
      showToast('Données d’horizon indisponibles (proxy :3001 injoignable — lancez « node logiciels/pvgis/server/server.js ») — poursuite sans ombrage.', 'warning');
    }

    updateProgress(25, 'Calcul des champs PV...');

    const monthlyAll = Array(12).fill(null).map(() => ({ ghi: 0, gti: 0, ac: 0 }));
    let monthlyFirstGti = null, monthlyFirstAc = null;
    let annualAC = 0, annualGti = 0, totalKwp = 0;
    const secResults = [];
    let sumGHI = 0, sumIdeal = 0, sumAfterHorizon = 0, sumAfterIAM = 0, sumAfterSpec = 0, sumAfterLowIrrad = 0, sumAfterTemp = 0;
    let firstSecParams = null;
    const allSecConfigs = []; // for multi-year variability
    // kWc-weighted loss accumulators for display
    let wcq = 0, wcm = 0, wcs = 0, wcc = 0, wci = 0, wcp = 0, totalLossWeight = 0;

    for (const sec of sections) {
      const kWc = getVal(sec.querySelector('.section-puissance'), 1, 0);
      let tilt = getVal(sec.querySelector('.section-inclinaison'), 35, 0, 90);
      const optCheckbox = sec.querySelector('.section-opt-angle');
      const optimizeAngle = optCheckbox && optCheckbox.checked;
      const azUser = getVal(sec.querySelector('.section-azimuth'), 0, -180, 180);
      const azPV = azUser;
      const type = sec.querySelector('.section-type').value;
      const mount = type === 'freestanding' ? 'free' : 'building';
      const panelKey = sec.querySelector('.section-panel-type').value;
      const panel = PANEL_TYPES[panelKey] || PANEL_TYPES.mono;
      const panelEff = getVal(sec.querySelector('.section-efficiency'), panel.eff, 0, 30);
      // Clamp all losses to >= 0 (defensive programming)
      const cLoss = Math.max(0, getVal(sec.querySelector('.section-cable-loss'), 1, 0));
      const iLoss = Math.max(0, getVal(sec.querySelector('.section-inv-loss'), 2, 0));
      const pLoss = Math.max(0, getVal(sec.querySelector('.section-pv-loss'), 0.5, 0));
      const qLoss = Math.max(0, getVal(sec.querySelector('.section-quality-loss'), 3, 0));
      const mLoss = Math.max(0, getVal(sec.querySelector('.section-mismatch-loss'), 2, 0));
      const sLoss = Math.max(0, getVal(sec.querySelector('.section-soiling-loss'), 3, 0));
      const sysFactor = (1 - cLoss / 100) * (1 - iLoss / 100) * (1 - pLoss / 100) * (1 - qLoss / 100) * (1 - mLoss / 100) * (1 - sLoss / 100);
      
      // Accumulate kWc-weighted losses
      wcq += qLoss * kWc;
      wcm += mLoss * kWc;
      wcs += sLoss * kWc;
      wcc += cLoss * kWc;
      wci += iLoss * kWc;
      wcp += pLoss * kWc;
      totalLossWeight += kWc;
      const albedo = type === 'freestanding' ? 0.2 : 0.15;
      totalKwp += kWc;

      let usedTilt = tilt;
      let dustRec = null;
      if (optimizeAngle) {
        usedTilt = findOptimalTilt(hourly, lat, lng, azPV, mount, panel, kWc, albedo, horizonLookup);
      }

      const result = computeSectionProdFast(geo, usedTilt, azPV, mount, panel, kWc, albedo, horizonLookup);

      if (optimizeAngle && usedTilt < 15) {
        const dr = findDustSafeTiltFast(geo, azPV, mount, panel, kWc, albedo, usedTilt, result.annualAC, horizonLookup);
        if (dr && dr.tilt !== usedTilt) dustRec = dr;
      }

      const secAC = result.annualAC * sysFactor;
      const secMonthly = result.monthly.map(m => m.ac * sysFactor);
      const secGti = result.annualGti;

      sumGHI += result.sumGHI;
      sumIdeal += result.sumIdeal;
      sumAfterHorizon += result.sumAfterHorizon;
      sumAfterIAM += result.sumAfterIAM;
      sumAfterSpec += result.sumAfterSpec;
      sumAfterLowIrrad += result.sumAfterLowIrrad;
      sumAfterTemp += result.sumAfterTemp;

      result.monthly.forEach((m, i) => {
        monthlyAll[i].ghi += m.ghi;
        monthlyAll[i].gti += m.gti;
        monthlyAll[i].ac += m.ac * sysFactor;
      });
      annualGti += secGti;
      annualAC += secAC;

      if (!firstSecParams) {
        firstSecParams = { kWc: 1, actualKwc: kWc, tilt: usedTilt, azPV, albedo, mount, panel, panelLabel: panel.label, sysFactor, cLoss, iLoss, pLoss, qLoss, mLoss, sLoss, panelEff, dustRec };
        monthlyFirstGti = result.monthly.map(m => m.gti);
        monthlyFirstAc = result.monthly.map(m => m.ac * sysFactor);
      }

      const displayTilt = optimizeAngle && usedTilt !== tilt ? usedTilt + '° (opt.)' : usedTilt + '°';
      secResults.push({ kWc, tilt: displayTilt, rawTilt: usedTilt, azUser, type, panel: panel.label, panelEff, cLoss, iLoss, pLoss, total: secAC, monthly: secMonthly, dustRec });
      allSecConfigs.push({ kWc, tilt: usedTilt, azPV, mount, panel, albedo, sysFactor });
    }

    lastSecResults = secResults;

    // Apply inverter clipping if AC rating is specified
    let clippingLoss = 0;
    const inverterAcKw = inverterAcRating > 0 ? inverterAcRating : totalKwp;
    if (inverterAcRating > 0 && annualAC > inverterAcKw * 8760) {
      // Clip annual AC to inverter capacity
      const clippedAnnualAC = inverterAcKw * 8760;
      clippingLoss = annualAC - clippedAnnualAC;
      annualAC = clippedAnnualAC;
      
      // Clip monthly values proportionally
      const clipFactor = clippedAnnualAC / (clippedAnnualAC + clippingLoss);
      monthlyAll.forEach(m => { m.ac *= clipFactor; });
    }

    // ─── Display Report ───
    updateProgress(60, 'Génération du rapport...');
    document.getElementById('report-empty').classList.add('hidden');
    document.getElementById('report-content').style.display = 'block';
    document.getElementById('report-area').classList.add('visible');

    document.getElementById('r-prod-annuelle').textContent = annualAC.toFixed(1) + ' kWh';
    // Specific yield: annualAC / totalKwp
    const specificYield = totalKwp > 0 ? annualAC / totalKwp : 0;
    document.getElementById('r-specific-yield').textContent = specificYield.toFixed(0) + ' kWh/kWc';
    // Capacity factor: annualAC / (totalKwp * 8760) * 100
    const capacityFactor = totalKwp > 0 ? (annualAC / (totalKwp * 8760)) * 100 : 0;
    document.getElementById('r-capacity-factor').textContent = capacityFactor.toFixed(1) + ' %';
    document.getElementById('r-irr-annuelle').textContent = (annualGti / 365).toFixed(2) + ' kWh/m²/day';
    const equivDaily = annualAC / Math.max(totalKwp, 0.001) / 365;
    document.getElementById('r-heures').textContent = equivDaily.toFixed(2) + ' h/jour';

    const locVal = document.getElementById('location').value;
    document.getElementById('r-loc').textContent = lat.toFixed(3) + ', ' + lng.toFixed(3) + (locVal ? ' (' + locVal + ')' : '');
    document.getElementById('r-pv-installed').textContent = totalKwp.toFixed(2) + ' kWc';
    document.getElementById('r-sections-count').textContent = sections.length + ' champ(s)';
    const dbLabel = weather.radDb || 'PVGIS';
    const meteoLabel = weather.meteoDb ? ' + ' + weather.meteoDb : '';
    const availYears = weather.availableYears || [];
    const yearLabel = useMultiYear
      ? (availYears.length > 1 ? availYears[0] + '–' + availYears[availYears.length - 1] : '1 an')
      : String(weather.yearMax || availYears[availYears.length - 1] || '—');
    document.getElementById('r-db-label').textContent = dbLabel + meteoLabel + ' (' + yearLabel + ')';
    const dbChip = document.getElementById('r-chip-db');
    if (dbChip) { dbChip.textContent = dbLabel; dbChip.style.display = 'inline-flex'; }
    const dbInline = document.getElementById('r-db-inline');
    if (dbInline) dbInline.textContent = dbLabel + meteoLabel + ' (' + yearLabel + ')';


    let variabilityText;
    if (useMultiYear) {
      variabilityText = '—';
    } else {
      const mAc = monthlyFirstAc || monthlyAll.map(m => m.ac);
      const mMean = mAc.reduce((a, b) => a + b, 0) / mAc.length;
      const mStd = mMean > 0 ? Math.sqrt(mAc.reduce((s, v) => s + (v - mMean) ** 2, 0) / mAc.length) : 0;
      const mCv = mMean > 0 ? (mStd / mMean) * 100 : 0;
      variabilityText = '±' + mCv.toFixed(1) + ' % (mensuel)';
    }
    document.getElementById('r-variabilite').textContent = variabilityText;
    if (firstSecParams) {
      document.getElementById('r-tech-label').textContent = firstSecParams.panelLabel + ' (' + firstSecParams.panelEff.toFixed(1) + ' %)';
    }

    // Sections detail table
    const stb = document.getElementById('r-sections-tbody');
    stb.innerHTML = '';
    secResults.forEach((s, i) => {
      const dustInfo = s.dustRec ? `<span style="color: var(--accent); margin-left: 0.5rem;">(sans-poussière : ${s.dustRec.tilt}°)</span>` : '';
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom: 1px solid var(--border);';
      tr.innerHTML = `<td style="padding: 0.5rem 0.75rem 0.5rem 0;">Champ ${i + 1}</td>
        <td style="padding: 0.5rem 0.75rem 0.5rem 0; color: var(--text-mid);">${s.kWc.toFixed(2)}</td>
        <td style="padding: 0.5rem 0.75rem 0.5rem 0; color: var(--text-mid);">${s.tilt}${dustInfo}</td>
        <td style="padding: 0.5rem 0.75rem 0.5rem 0; color: var(--text-mid);">${s.azUser}°</td>
        <td style="padding: 0.5rem 0.75rem 0.5rem 0; color: var(--text-mid);">${s.panel} (${s.panelEff.toFixed(1)}%)</td>
        <td style="padding: 0.5rem 0.75rem 0.5rem 0; color: var(--text-mid);">${(s.cLoss + s.iLoss + s.pLoss).toFixed(1)}%</td>
        <td style="padding: 0.5rem 0.75rem 0.5rem 0; color: #4ade80;">${s.total.toFixed(1)}</td>`;
      stb.appendChild(tr);
    });

    // Monthly energy balance table
    const mbb = document.getElementById('r-monthly-balance');
    const mHead = document.getElementById('r-monthly-head');
    if (mbb) {
      const monthlyData = monthlyAll;
      // Store for toggle view switching
      window._energyView = 'monthly';
      window._energyData = monthlyData;
      window._energyKwp = totalKwp;
      
      const rows = [
        { label: 'Production (kWh)', data: monthlyData.map(m => m.ac), color: '#22c55e', isRate: false },
        { label: 'Irradiation (kWh/m²)', data: monthlyData.map(m => m.gti), color: '#f97316', isRate: false },
        { label: 'PR (%)', data: monthlyData.map((m, i) => m.gti > 0 ? (m.ac / (m.gti * totalKwp) * 100) : 0), color: '#3b82f6', isRate: true },
        { label: 'Heures soleil (h/jour)', data: monthlyData.map((m, i) => totalKwp > 0 ? (m.ac / totalKwp / DAYS_IN_MONTH[i]) : 0), color: '#a855f7', isRate: true }
      ];
      _buildEnergyTable(rows, 'monthly', mbb);
    }

    // Loss breakdown - physical losses (cascading from GHI)
    const fmtLoss = (prev, curr) => {
      if (prev <= 0) return '—';
      const pct = ((prev - curr) / prev) * 100;
      // Threshold to avoid -0.0% display
      if (Math.abs(pct) < 0.05) return '—';
      return pct >= 0 ? '-' + pct.toFixed(1) + '%' : '+' + Math.abs(pct).toFixed(1) + '%';
    };

    const lTranspo = fmtLoss(sumGHI, sumIdeal);
    const lHorizon = fmtLoss(sumIdeal, sumAfterHorizon);
    const lIAM = fmtLoss(sumAfterHorizon, sumAfterIAM);
    const lSpec = fmtLoss(sumAfterIAM, sumAfterSpec);
    const lLowIrrad = fmtLoss(sumAfterSpec, sumAfterLowIrrad);
    const lTemp = fmtLoss(sumAfterLowIrrad, sumAfterTemp);

    // System losses - use kWc-weighted averages across all sections
    const cLoss = totalLossWeight > 0 ? wcc / totalLossWeight : 1;
    const iLoss = totalLossWeight > 0 ? wci / totalLossWeight : 2;
    const pLoss = totalLossWeight > 0 ? wcp / totalLossWeight : 0.5;
    const qLoss = totalLossWeight > 0 ? wcq / totalLossWeight : 3;
    const mLoss = totalLossWeight > 0 ? wcm / totalLossWeight : 2;
    const sLoss = totalLossWeight > 0 ? wcs / totalLossWeight : 3;

    // Combined system factor (all user-defined losses)
    const sysFactor = (1 - cLoss / 100) * (1 - iLoss / 100) * (1 - pLoss / 100) *
                      (1 - qLoss / 100) * (1 - mLoss / 100) * (1 - sLoss / 100);
    const lSys = '-' + ((1 - sysFactor) * 100).toFixed(1) + '%';

    // Total factor: physical × system
    const physicalFactor = sumGHI > 0 ? sumAfterTemp / sumGHI : 0;
    const totalFactor = physicalFactor * sysFactor;
    const lTotal = '-' + (Math.max(0, Math.min((1 - totalFactor) * 100, 99.9))).toFixed(1) + '%';

    document.getElementById('r-loss-transpo').textContent = lTranspo;
    document.getElementById('r-loss-horizon').textContent = lHorizon;
    document.getElementById('r-loss-aoi').textContent = lIAM;
    document.getElementById('r-loss-spec').textContent = lSpec;
    document.getElementById('r-loss-low-irrad').textContent = lLowIrrad;
    document.getElementById('r-loss-temp').textContent = lTemp;
    document.getElementById('r-loss-quality').textContent = '-' + qLoss.toFixed(1) + '%';
    document.getElementById('r-loss-mismatch').textContent = '-' + mLoss.toFixed(1) + '%';
    document.getElementById('r-loss-soiling').textContent = '-' + sLoss.toFixed(1) + '%';
    document.getElementById('r-loss-sys').textContent = lSys;
    document.getElementById('r-pertes').textContent = lTotal;

    // Financial analysis — compute data, display text, hide/show section
    let finData = null;
    let lcoe = null;
    let npv = null;
    let yearlyCashFlow = null;
    let discountedPaybackYear = null;
    if (enabledFinancial) {
      const totalInvest = totalKwp * invCost;
      
      // Financial inputs (shared with chart block)
      const omCostPerKw = getVal('om-cost', 20, 0);
      const elecEscalation = getVal('elec-escalation', 2.5, 0) / 100;
      const omEscalation = getVal('om-escalation', 2.0, 0) / 100;
      const invReplaceCost = getVal('inverter-replacement', 150, 0);
      const invReplaceYear = getVal('inverter-replace-year', 12, 1);
      const selfConsumptionRate = getVal('self-consumption', 70, 0, 100) / 100;
      const annualConsumption = getVal('annual-consumption', 5000, 0);
      const maxSelfConsumption = annualAC * selfConsumptionRate;
      const selfConsumed = Math.min(maxSelfConsumption, annualConsumption);
      const fedToGrid = annualAC - selfConsumed;
      
      // Warn if self-consumption is capped by consumption
      if (maxSelfConsumption > annualConsumption && annualConsumption > 0) {
        showToast(`Autoconsommation plafonnée par la consommation annuelle (${annualConsumption} kWh). Taux réel : ${(annualConsumption/annualAC*100).toFixed(1)} %`, 'warning');
      }
      
      // Year 1 values
      const annualSavings = selfConsumed * elecPrice;
      const annualFeedin = fedToGrid * feedIn;
      const annualBenefit = annualSavings + annualFeedin;
      const annualOM = totalKwp * omCostPerKw;

      document.getElementById('r-invest').textContent = fmtCurrency(totalInvest);
      const invSub = document.getElementById('r-invest-sub');
      if (invSub) invSub.textContent = totalKwp.toFixed(2) + ' kWc × ' + fmtCurrency(invCost) + '/kWc';
      document.getElementById('r-savings').textContent = fmtCurrency(annualSavings) + '/an';
      const savSub = document.getElementById('r-savings-sub');
      if (savSub) savSub.textContent = selfConsumed.toFixed(0) + ' kWh autoconsommés × ' + fmtCurrency(elecPrice) + '/kWh';
      document.getElementById('r-feedin').textContent = fmtCurrency(annualFeedin) + '/an';
      const feedSub = document.getElementById('r-feedin-sub');
      if (feedSub) feedSub.textContent = fedToGrid.toFixed(0) + ' kWh injectés × ' + fmtCurrency(feedIn) + '/kWh';
      document.getElementById('r-net-benefit').textContent = fmtCurrency(annualBenefit) + '/an';
      const benefitSub = document.getElementById('r-net-benefit-sub');
      if (benefitSub) benefitSub.textContent = 'Économies + revenu de revente (A1)';

      // Corrected LCOE: (totalInvest + Σ(O&M + inv replacement) / (1+r)^y) / Σ(energy / (1+r)^y)
      let totalCostPV = totalInvest;
      let totalEnergyPV = 0;
      let totalOMLifetime = 0;
      for (let y = 1; y <= lifetime; y++) {
        const omY = annualOM * Math.pow(1 + omEscalation, y - 1);
        const invReplaceY = (y === invReplaceYear) ? (totalKwp * invReplaceCost) : 0;
        totalCostPV += (omY + invReplaceY) / Math.pow(1 + discountRate, y);
        totalEnergyPV += annualAC * Math.pow(1 - degradation, y - 1) / Math.pow(1 + discountRate, y);
        totalOMLifetime += omY;
      }
      lcoe = totalEnergyPV > 0 ? totalCostPV / totalEnergyPV : 0;
      document.getElementById('r-lcoe').textContent = lcoe.toFixed(4) + ' €/kWh';
      const lcoeSub = document.getElementById('r-lcoe-sub');
      if (lcoeSub) lcoeSub.textContent = 'Coût actualisé : coût total sur la durée de vie ÷ énergie totale sur la durée de vie';
      
      // Display total O&M
      const totalOMEl = document.getElementById('r-total-om');
      if (totalOMEl) totalOMEl.textContent = fmtCurrency(totalOMLifetime);
      const omSub = document.getElementById('r-total-om-sub');
      if (omSub) omSub.textContent = fmtCurrency(annualOM) + '/an × ' + lifetime + ' ans avec ' + (omEscalation * 100).toFixed(1) + '% de hausse';

      finData = { totalInvest, annualBenefit, annualSavings, annualFeedin, selfConsumed, fedToGrid, annualOM, totalOMLifetime, invReplaceCost, invReplaceYear, omCostPerKw, elecEscalation, omEscalation, selfConsumptionRate, annualConsumption };

      const simplePayback = annualBenefit > 0 ? totalInvest / annualBenefit : Infinity;
      document.getElementById('r-payback').textContent = simplePayback < 100 ? simplePayback.toFixed(1) + ' ans' : '—';
      const paybackSub = document.getElementById('r-payback-sub');
      if (paybackSub) paybackSub.textContent = simplePayback < 100
        ? 'Année où les économies cumulées couvrent le coût du système. Inclut la dégradation.'
        : 'Retour au-delà de la durée de vie du système';

      // Corrected NPV with O&M, inverter replacement, and electricity escalation
      npv = -totalInvest;
      let cumulativeNPV = -totalInvest;
      const yearlyCash = [];
      yearlyCash.push({ year: 0, investment: -totalInvest, om: 0, benefit: 0, invReplace: 0, cumulative: cumulativeNPV });

      for (let y = 1; y <= lifetime; y++) {
        // Production degrades
        const prodY = annualAC * Math.pow(1 - degradation, y - 1);
        
        // Self-consumption split (recalculate with degraded production)
        const selfConsumedY = Math.min(prodY * selfConsumptionRate, annualConsumption);
        const fedToGridY = prodY - selfConsumedY;
        
        // Electricity price escalates
        const elecPriceY = elecPrice * Math.pow(1 + elecEscalation, y - 1);
        const savingsY = selfConsumedY * elecPriceY;
        const feedinY = fedToGridY * feedIn; // feed-in tariff is fixed (contract)
        const benefitY = savingsY + feedinY;
        
        // O&M escalates
        const omY = annualOM * Math.pow(1 + omEscalation, y - 1);
        
        // Inverter replacement
        const invReplaceY = (y === invReplaceYear) ? -(totalKwp * invReplaceCost) : 0;
        
        const netCashFlow = benefitY - omY + invReplaceY;
        const discounted = netCashFlow / Math.pow(1 + discountRate, y);
        cumulativeNPV += discounted;
        npv += discounted;

        yearlyCash.push({
          year: y,
          investment: 0,
          om: -omY,
          benefit: benefitY,
          invReplace: invReplaceY,
          netCashFlow,
          cumulative: cumulativeNPV
        });

        // Discounted payback: first year where cumulativeNPV >= 0
        if (discountedPaybackYear === null && cumulativeNPV >= 0) {
          const prev = yearlyCash[yearlyCash.length - 2].cumulative;
          discountedPaybackYear = (y - 1) + (-prev) / (cumulativeNPV - prev);
        }
      }
      yearlyCashFlow = yearlyCash;

      document.getElementById('r-npv').textContent = npv > 0 ? '+' + fmtCurrency(npv) : fmtCurrency(npv);
      const npvSub = document.getElementById('r-npv-sub');
      if (npvSub) npvSub.textContent = 'Valeur actuelle nette sur ' + lifetime + ' ans à un taux de ' + (discountRate * 100).toFixed(1) + '% discount rate';
      
      // Discounted payback
      const discPaybackEl = document.getElementById('r-payback-discounted');
      if (discPaybackEl) {
        discPaybackEl.textContent = discountedPaybackYear ? discountedPaybackYear.toFixed(1) + ' ans' : '—';
      }
      const discPaybackSub = document.getElementById('r-payback-discounted-sub');
      if (discPaybackSub) discPaybackSub.textContent = discountedPaybackYear
        ? 'Année où la trésorerie cumulée actualisée devient positive'
        : 'Non atteint pendant la durée de vie du système';

      document.getElementById('r-financial-section').style.display = 'block';
      document.getElementById('self-consumption-wrap').style.display = 'block';
      document.getElementById('loss-chart-row').classList.add('two-col');

      // Beginner mode: plain-language money summary (same numbers as the full report)
      const bFinWrap = document.getElementById('beginner-fin');
      if (bFinWrap) bFinWrap.style.display = isBeginnerMode() ? 'block' : 'none';
      if (isBeginnerMode()) {
        const bInvest = document.getElementById('bf-fin-invest');
        if (bInvest) bInvest.textContent = fmtCurrency(totalInvest);
        const bSavings = document.getElementById('bf-fin-savings');
        if (bSavings) bSavings.textContent = fmtCurrency(annualBenefit) + '/an';
        const bPayback = document.getElementById('bf-fin-payback');
        if (bPayback) bPayback.textContent = document.getElementById('r-payback').textContent;
        const bNpv = document.getElementById('bf-fin-npv');
        if (bNpv) bNpv.textContent = document.getElementById('r-npv').textContent;
        const bNote = document.getElementById('bf-fin-note');
        if (bNote) {
          bNote.textContent = npv > 0
            ? `Bonne nouvelle : sur ${lifetime} ans, votre installation devrait rapporter environ ${fmtCurrency(npv)} de plus que son coût.`
            : `Attention : sur ${lifetime} ans, cette installation devrait coûter environ ${fmtCurrency(Math.abs(npv))} de plus que ses gains. Essayez un coût d’installation plus bas ou un prix de l’électricité plus élevé, puis relancez.`;
        }
      }
    }

    // CO2 avoidance
    const co2Year = annualAC * co2Factor;
    const co2Lifetime = co2Year * lifetime;
    const kmEquiv = co2Year / carEmissions;

    document.getElementById('r-co2-year').textContent = fmtKg(co2Year / 1000);
    document.getElementById('r-co2-lifetime').textContent = fmtKg(co2Lifetime / 1000);
    document.getElementById('r-co2-km').textContent = Math.round(kmEquiv).toLocaleString('en-US') + ' km';

    document.getElementById('r-co2-section').style.display = 'block';

    // Multi-year variability (computed once, reused for export)
    let variabilityStats = null;
    if (useMultiYear) updateProgress(75, 'Calcul de la variabilité interannuelle...');
    if (useMultiYear && weather.yearly && weather.yearly.length > 1 && allSecConfigs.length > 0) {
      const yearlyAC = weather.yearly.map(yh => {
        let yearTotal = 0;
        for (const sc of allSecConfigs) {
          const r = computeSectionProd(yh, lat, lng, sc.tilt, sc.azPV, sc.mount, sc.panel, sc.kWc, sc.albedo, horizonLookup);
          yearTotal += r.annualAC * sc.sysFactor;
        }
        return yearTotal;
      });
      const meanY = yearlyAC.reduce((a, b) => a + b, 0) / yearlyAC.length;
      const s = sampleStd(yearlyAC);
      const n = yearlyAC.length;
      const cvY = meanY > 0 ? (s / meanY) * 100 : 0;
      const p50 = meanY;
      const p90 = s > 0 ? meanY - studentT90(n - 1) * s * predictionFactor(n) : meanY;
      document.getElementById('r-variabilite').textContent = '±' + cvY.toFixed(1) + ' % (1σ, ' + weather.yearly.length + ' ans)';
      variabilityStats = { years: yearlyAC.length, mean: meanY, std: s, cv: cvY, min: Math.min(...yearlyAC), max: Math.max(...yearlyAC), p50, p90, yearlyAC };
      const p50El = document.getElementById('r-p50');
      const p90El = document.getElementById('r-p90');
      const p50Wrap = document.getElementById('r-p50-wrap');
      const p90Wrap = document.getElementById('r-p90-wrap');
      if (p50El) p50El.textContent = p50.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kWh';
      if (p90El) p90El.textContent = p90.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kWh';
      if (p50Wrap) p50Wrap.style.display = 'block';
      if (p90Wrap) p90Wrap.style.display = 'block';
    } else if (useMultiYear) {
      document.getElementById('r-variabilite').textContent = 'Pas assez d’années';
      const p50Wrap = document.getElementById('r-p50-wrap');
      const p90Wrap = document.getElementById('r-p90-wrap');
      if (p50Wrap) p50Wrap.style.display = 'none';
      if (p90Wrap) p90Wrap.style.display = 'none';
      ['variability-pdf-wrap', 'variability-cdf-wrap'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
    }

    // Charts
    updateProgress(80, 'Génération des graphiques...');
    const monthlyAC = monthlyAll.map(m => m.ac);
    const monthlyGti = monthlyAll.map(m => m.gti);
    destroyCharts();

    // Horizontal loss chart
    makeLossHorizontalChart(sumGHI, sumIdeal, sumAfterHorizon, sumAfterIAM, sumAfterSpec, sumAfterLowIrrad, sumAfterTemp, qLoss, mLoss, sLoss, sysFactor, annualAC);

    // Cash flow chart + IRR (if financial enabled)
    let finResult = null;
    if (finData) {
      finResult = makeCashFlowChart(
        finData.totalInvest, 
        totalKwp,
        finData.annualBenefit,
        degradation, 
        discountRate, 
        lifetime,
        finData.omCostPerKw,
        finData.elecEscalation,
        finData.omEscalation,
        finData.invReplaceCost,
        finData.invReplaceYear,
        finData.selfConsumptionRate,
        finData.annualConsumption,
        elecPrice,
        feedIn,
        annualAC
      );
      document.getElementById('r-irr').textContent = finResult.irr != null ? (finResult.irr * 100).toFixed(1) + '%' : '—';
      const irrSub = document.getElementById('r-irr-sub');
      if (irrSub) irrSub.textContent = finResult.irr != null
        ? 'Rendement annuel équivalent du capital investi'
        : 'Le calcul du TRI n’a pas convergé';
      
      // Self-consumption donut chart
      const selfConsCanvas = document.getElementById('chart-self-consumption');
      if (selfConsCanvas) {
        if (chartInstances['chart-self-consumption']) chartInstances['chart-self-consumption'].destroy();
        const selfConsTotal = finData.selfConsumed + finData.fedToGrid;
        chartInstances['chart-self-consumption'] = new Chart(selfConsCanvas, {
          type: 'doughnut',
          data: {
            labels: ['Autoconsommée', 'Injectée au réseau'],
            datasets: [{
              data: [finData.selfConsumed, finData.fedToGrid],
              backgroundColor: ['#22c55e', '#3b82f6'],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
              legend: { display: true, labels: { color: '#888', font: { size: 10 }, usePointStyle: true } },
              tooltip: {
                backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
                borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8, bodyFont: { size: 11 },
                callbacks: {
                  label: (ctx) => {
                    const val = ctx.parsed;
                    const pct = selfConsTotal > 0 ? (val / selfConsTotal * 100).toFixed(1) : 0;
                    return `${ctx.label}: ${val.toLocaleString('fr-FR', { minimumFractionDigits: 0 })} kWh (${pct}%)`;
                  }
                }
              }
            }
          },
          plugins: [{
            id: 'doughnutLabels',
            afterDraw(chart) {
              const ctx = chart.ctx;
              const arcs = chart.getDatasetMeta(0).data;
              const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
              chart.data.datasets[0].data.forEach((val, i) => {
                const arc = arcs[i];
                if (!arc || !arc.x || !arc.y) return;
                const angle = arc.startAngle + (arc.endAngle - arc.startAngle) / 2;
                const radius = arc.outerRadius * 0.65;
                const x = arc.x + Math.cos(angle) * radius;
                const y = arc.y + Math.sin(angle) * radius;
                const pct = total > 0 ? (val / total * 100).toFixed(1) : 0;
                const txt = val.toLocaleString('fr-FR', { minimumFractionDigits: 0 }) + ' kWh\n' + pct + '%';
                ctx.save();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = 'bold 12px system-ui, sans-serif';
                ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'light' ? '#222' : '#fff';
                const lines = txt.split('\n');
                lines.forEach((line, li) => {
                  ctx.fillText(line, x, y + li * 14 - 7);
                });
                ctx.restore();
              });
            }
          }]
        });
      }
    }

    const chartOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
          borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8, bodyFont: { size: 11 },
          callbacks: {
            label: function(ctx) {
              const idx = ctx.dataIndex;
              const val = ctx.parsed.y;
              const isProd = ctx.dataset.label === 'kWh';
              if (isProd) {
                const equivHs = val / totalKwp / DAYS_IN_MONTH[idx];
                  return val.toFixed(1) + ' kWh (' + equivHs.toFixed(2) + ' h/j)';
              } else {
                return val.toFixed(1) + ' kWh/m²';
              }
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Mois', color: '#888' },
          ticks: { color: '#5A5670', maxRotation: 0 },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'kWh', color: '#888' },
          ticks: { color: '#5A5670', maxTicksLimit: 6 },
          grid: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    };

    // Monthly production chart: actual vs ideal (no loss)
    const prodCanvas = document.getElementById('chart-prod');
    if (prodCanvas) {
      if (chartInstances['chart-prod']) chartInstances['chart-prod'].destroy();
      
      // Ideal production = POA irradiation × total capacity (theoretical max)
      const idealAC = monthlyGti.map(gti => gti * totalKwp);
      
      chartInstances['chart-prod'] = new Chart(prodCanvas, {
        type: 'bar',
        data: {
          labels: MONTH_LABELS,
          datasets: [
            {
              label: 'Production idéale (sans pertes)',
              data: idealAC,
              backgroundColor: 'rgba(34, 197, 94, 0.25)',
              borderColor: '#22c55e',
              borderWidth: 1,
              borderRadius: 3,
              borderDash: [4, 2]
            },
            {
              label: 'Production réelle',
              data: monthlyAC,
              backgroundColor: monthlyAC.map(v => {
                const max = Math.max(...monthlyAC, 1);
                const a = 0.25 + (v / max) * 0.55;
                return `rgba(56, 189, 248, ${a})`;
              }),
              borderColor: '#38bdf8',
              borderWidth: 1,
              borderRadius: 3,
              hoverBackgroundColor: 'rgba(56, 189, 248, 0.85)'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, labels: { color: '#888', font: { size: 10 }, usePointStyle: true } },
            tooltip: {
              backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#fff',
              borderColor: '#333', borderWidth: 1, cornerRadius: 4, padding: 8, bodyFont: { size: 11 },
              callbacks: {
                label: function(ctx) {
                  const idx = ctx.dataIndex;
                  const val = ctx.parsed.y;
                  const equivHs = val / totalKwp / DAYS_IN_MONTH[idx];
                  if (ctx.datasetIndex === 0) return val.toFixed(1) + ' kWh (idéal)';
                return val.toFixed(1) + ' kWh (' + equivHs.toFixed(2) + ' h/j)';
                }
              }
            }
          },
          scales: {
            x: {
              title: { display: true, text: 'Mois', color: '#888' },
              ticks: { color: '#5A5670', maxRotation: 0 },
              grid: { display: false }
            },
            y: {
              beginAtZero: true,
              title: { display: true, text: 'kWh', color: '#888' },
              ticks: { color: '#5A5670', maxTicksLimit: 6 },
              grid: { color: 'rgba(255,255,255,0.05)' }
            }
          }
        }
      });
    }

    makeChart('chart-irr', 'bar', MONTH_LABELS, [{
      label: 'kWh/m²',
      data: monthlyGti,
      backgroundColor: monthlyGti.map(v => {
        const max = Math.max(...monthlyGti, 1);
        const a = 0.25 + (v / max) * 0.55;
        return `rgba(168, 85, 247, ${a})`;
      }),
      borderColor: '#a855f7', borderWidth: 1, borderRadius: 3,
      hoverBackgroundColor: 'rgba(168, 85, 247, 0.85)'
    }], chartOpts);

    // Production vs angle (full 0-90° sweep)
    if (firstSecParams) {
      const fsp = firstSecParams;
      const angles = [];
      const energies = [];
      let maxP = 0, optT = 0;
      for (let t = 0; t <= 90; t++) {
        const r = computeSectionProdFast(geo, t, fsp.azPV, fsp.mount, fsp.panel, 1, fsp.albedo, horizonLookup);
        const p = r.annualAC * fsp.sysFactor;
        angles.push(t);
        energies.push(p);
        if (p > maxP) { maxP = p; optT = t; }
      }
      // Find dust-safe recommendation
      let dustRec = null;
      if (optT < 15) {
        const THRESHOLD = 0.996;
        const optEnergy = energies[optT];
        for (let a = 20; a >= 15; a--) {
          if (energies[a] / optEnergy >= THRESHOLD) {
            dustRec = { angle: a, ratio: energies[a] / optEnergy };
            break;
          }
        }
      }
      makeProdVsAngleChart(angles, energies, optT, dustRec);
    }

    // PR chart
    const prGti = monthlyFirstGti || monthlyGti;
    const prAc = monthlyFirstAc || monthlyAC;
    const prKwp = firstSecParams ? firstSecParams.actualKwc : totalKwp;
    makePRChart(prAc, prGti, prKwp);

    // Annual PR = annualAC / (annualGti × totalKwp) — not monthly average
    const prAnnuel = annualGti > 0 ? (annualAC / (annualGti * prKwp)) * 100 : 0;
    const prEl = document.getElementById('r-pr');
    if (prEl) prEl.textContent = prAnnuel.toFixed(1) + ' %';

    // Sun path
    updateProgress(90, 'Calcul de la trajectoire solaire...');
    makeSunPathChart(lat, lng, horizonRaw);

    // Diurnal profile
    makeDiurnalChart(hourly, lat, lng);

    // P50/P90 variability chart (after destroyCharts above)
    if (variabilityStats && variabilityStats.yearlyAC) {
      makeP50P90Chart(variabilityStats.yearlyAC, variabilityStats.p50, variabilityStats.p90);
    } else {
      ['variability-pdf-wrap', 'variability-cdf-wrap'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
    }

    updateProgress(100, 'Terminé');
    setTimeout(() => showProgress(false), 2000);
    document.getElementById('report-area').scrollIntoView({ behavior: 'smooth', block: 'start' });

    // ─── Capture full result for markdown export ───
    const monthlyData = monthlyAll.map(m => ({ ghi: m.ghi, gti: m.gti, ac: m.ac }));
    // Monthly average temperature from hourly data
    const _tmp_sums = Array(12).fill(0);
    const _tmp_cnts = Array(12).fill(0);
    for (let _i = 0; _i < (hourly.time || []).length; _i++) {
      const _mo = parseInt(hourly.time[_i].slice(5, 7), 10) - 1;
      _tmp_sums[_mo] += hourly.temperature_2m[_i] || 0;
      _tmp_cnts[_mo]++;
    }
    const monthlyAvgTemp = _tmp_sums.map((s, i) => _tmp_cnts[i] > 0 ? s / _tmp_cnts[i] : 0);
    const lossCascade = [
      { stage: 'GHI (horizontal)', kWh: sumGHI },
      { stage: 'POA (transposition idéale)', kWh: sumIdeal },
      { stage: 'Après ombrage horizon', kWh: sumAfterHorizon },
      { stage: 'Après IAM (angle d’incidence)', kWh: sumAfterIAM },
      { stage: 'Après correction spectrale', kWh: sumAfterSpec },
      { stage: 'Après faible irradiance', kWh: sumAfterLowIrrad },
      { stage: 'Après pertes de température', kWh: sumAfterTemp },
      { stage: 'Sortie CA nette', kWh: annualAC }
    ];

    // variabilityStats already computed above in the multi-year section — reused here

    window.lastSimResult = {
      meta: { timestamp: new Date().toISOString(), mode: useMultiYear ? 'multi-year' : 'single-year', year: yearSelect ? yearSelect.value : 'auto', lat, lng, locationName: document.getElementById('location')?.value || '', interface: SERA_MODE },
      weather: { radDb: weather.radDb || 'PVGIS', meteoDb: weather.meteoDb || '', availableYears: weather.availableYears || [], yearMax: weather.yearMax || '' },
      inputs: {
        sections: Array.from(sections).map(sec => {
          const v = (cls, def) => sec.querySelector(cls)?.value || def;
          return { kWc: +v('.section-puissance', 1), tilt: +v('.section-inclinaison', 35), azimuth: +v('.section-azimuth', 180), mount: v('.section-type', 'rooftop'), panel: v('.section-panel-type', 'mono'), efficiency: +v('.section-efficiency', 20), cableLoss: +v('.section-cable-loss', 1), invLoss: +v('.section-inv-loss', 2), pvLoss: +v('.section-pv-loss', 0.5), qualityLoss: +v('.section-quality-loss', 3), mismatchLoss: +v('.section-mismatch-loss', 2), soilingLoss: +v('.section-soiling-loss', 3) };
        }),
        financial: enabledFinancial ? { invCost, elecPrice, feedIn, lifetime, degradation: degradation * 100, discountRate: discountRate * 100, selfConsumptionRate: getVal('self-consumption', 70, 0, 100), annualConsumption: getVal('annual-consumption', 5000, 0), co2Factor, carEmissions } : null
      },
      results: {
        totalKwp, annualAC, annualGti, specificYield, capacityFactor,
        prAnnuel, prKwp,
        dailyIrradiation: annualGti / 365,
        sunEquivalent: annualAC / Math.max(totalKwp, 0.001) / 365,
        variability: variabilityText,
        variabilityStats
      },
      sections: secResults.map((s, i) => ({ index: i + 1, kWc: s.kWc, tilt: s.tilt, rawTilt: s.rawTilt, azUser: s.azUser, type: s.type, panel: s.panel, panelEff: s.panelEff, cLoss: s.cLoss, iLoss: s.iLoss, pLoss: s.pLoss, sysFactor: null, total: s.total, monthly: s.monthly, dustRec: s.dustRec })),
      monthly: { labels: MONTH_LABELS, data: monthlyData, ghi: monthlyData.map(m => m.ghi), gti: monthlyData.map(m => m.gti), ac: monthlyData.map(m => m.ac), avgTemp: monthlyAvgTemp },
      losses: { sumGHI, sumIdeal, sumAfterHorizon, sumAfterIAM, sumAfterSpec, sumAfterLowIrrad, sumAfterTemp, cascade: lossCascade, qLoss, mLoss, sLoss, cLoss: firstSecParams?.cLoss || 0, iLoss: firstSecParams?.iLoss || 0, pLoss: firstSecParams?.pLoss || 0, sysFactor: firstSecParams?.sysFactor || 0, physicalFactor: sumGHI > 0 ? sumAfterTemp / sumGHI : 0, totalFactor: sumGHI > 0 ? annualAC / sumGHI : 0 },
      financial: finData ? { totalInvest: finData.totalInvest, annualBenefit: finData.annualBenefit, annualSavings: finData.annualSavings, annualFeedin: finData.annualFeedin, selfConsumed: finData.selfConsumed, fedToGrid: finData.fedToGrid, lcoe, simplePaybackYear: finResult ? finResult.simplePaybackYear : null, discountedPaybackYear, npv, irr: finResult ? finResult.irr : null, yearlyCashFlow, totalOMLifetime: finData.totalOMLifetime, invReplaceCost: finData.invReplaceCost, invReplaceYear: finData.invReplaceYear } : null
    };

  } catch (e) {
    showToast('Erreur : ' + e.message);
    console.error(e);
  }

  btn.textContent = isBeginnerMode() ? 'Estimer ma production' : 'Lancer la simulation';
  btn.disabled = false;
  if (overlay) overlay.style.display = 'none';
}

document.getElementById('simulate-btn').addEventListener('click', runSimulation);

// Report export moved to report-export.js

// ─── ENERGY VIEW TOGGLE ───────────────────────────────────────────────────

function _buildEnergyTable(rows, view, tbody) {
  tbody.innerHTML = '';
  const isSeasonal = view === 'seasonal';
  const isYearly = view === 'yearly';
  
  rows.forEach((row, rowIdx) => {
    const tr = document.createElement('tr');
    const bgColor = rowIdx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent';
    tr.style.cssText = `border-bottom: 1px solid var(--border); background-color: ${bgColor};`;
    
    let html = `<td style="padding: 0.4rem 0.5rem; text-align: left; color: var(--text-mid);">${row.label}</td>`;
    
    if (isYearly) {
      const total = row.data.reduce((a, b) => a + b, 0);
      const display = row.isRate ? (total / 12).toFixed(1) : total.toFixed(0);
      html += `<td style="padding: 0.4rem 0.5rem; font-weight:600; color: ${row.color};">${display}</td>`;
    } else if (isSeasonal) {
      // DJF, MAM, JJA, SON
      const seasons = [
        { label: 'DJF', indices: [11, 0, 1] },
        { label: 'MAM', indices: [2, 3, 4] },
        { label: 'JJA', indices: [5, 6, 7] },
        { label: 'SON', indices: [8, 9, 10] }
      ];
      seasons.forEach(s => {
        const sum = s.indices.reduce((a, i) => a + row.data[i], 0);
        const display = row.isRate ? (sum / 3).toFixed(1) : sum.toFixed(0);
        html += `<td style="padding: 0.4rem 0.5rem; color: ${row.color};">${display}</td>`;
      });
      const annualTotal = row.data.reduce((a, b) => a + b, 0);
      const annualDisplay = row.isRate ? (annualTotal / 12).toFixed(1) : annualTotal.toFixed(0);
      html += `<td style="padding: 0.4rem 0.5rem; font-weight:600; color: ${row.color};">${annualDisplay}</td>`;
    } else {
      let total = 0;
      row.data.forEach((val, i) => {
        total += val;
        const display = row.isRate ? val.toFixed(1) : val.toFixed(0);
        html += `<td style="padding: 0.4rem 0.5rem; color: ${row.color};">${display}</td>`;
      });
      const totalDisplay = row.isRate ? (row.data.reduce((a, b) => a + b, 0) / 12).toFixed(1) : total.toFixed(0);
      html += `<td style="padding: 0.4rem 0.5rem; font-weight:600; color: ${row.color};">${totalDisplay}</td>`;
    }
    
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
}

function switchEnergyView(view) {
  window._energyView = view;
  const data = window._energyData;
  const kwp = window._energyKwp;
  if (!data) return;
  
  // Update pill toggle active state
  document.querySelectorAll('.pill-toggle').forEach(el => {
    el.classList.toggle('pill-toggle--active', el.dataset.view === view);
  });
  
  // Update table header
  const head = document.getElementById('r-monthly-head');
  if (head) {
    let html = '<tr><th>Indicateur</th>';
    if (view === 'yearly') {
      html += '<th>Annuel</th>';
    } else if (view === 'seasonal') {
      html += '<th>DJF</th><th>MAM</th><th>JJA</th><th>SON</th><th style="font-weight:600;">Annuel</th>';
    } else {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      months.forEach(m => html += `<th>${m}</th>`);
      html += '<th style="font-weight:600;">Total</th>';
    }
    html += '</tr>';
    head.innerHTML = html;
  }
  
  const rows = [
    { label: 'Production (kWh)', data: data.map(m => m.ac), color: '#22c55e', isRate: false },
    { label: 'Irradiation (kWh/m²)', data: data.map(m => m.gti), color: '#f97316', isRate: false },
    { label: 'PR (%)', data: data.map((m, i) => m.gti > 0 ? (m.ac / (m.gti * kwp) * 100) : 0), color: '#3b82f6', isRate: true },
    { label: 'Heures soleil (h/jour)', data: data.map((m, i) => kwp > 0 ? (m.ac / kwp / [31,28,31,30,31,30,31,31,30,31,30,31][i]) : 0), color: '#a855f7', isRate: true }
  ];
  
  const tbody = document.getElementById('r-monthly-balance');
  if (tbody) _buildEnergyTable(rows, view, tbody);
}

// ─── COLLAPSIBLE SECTION TOGGLE ────────────────────────────────────────────

function toggleCollapse(el) {
  if (!el) return;
  el.classList.toggle('open');
}

window.addEventListener('resize', () => {
  Object.values(chartInstances).forEach(chart => {
    if (chart && chart.resize) chart.resize();
  });
});



