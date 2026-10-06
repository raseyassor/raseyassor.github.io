// ── SERA Report Export Module ───────────────────
// Professional .md report generator — A4-optimised layout

/* ── Store sim result for report-template.html ── */
function saveSimResultForTemplate() {
  if (!window.lastSimResult) {
    showToast('Aucun rapport à exporter. Lancez d’abord une simulation.');
    return false;
  }
  try {
    sessionStorage.setItem('seraSimResult', JSON.stringify(window.lastSimResult));
    return true;
  } catch (e) {
    showToast('Échec d’enregistrement des données du rapport : ' + e.message);
    return false;
  }
}

function openFullReport() {
  if (!saveSimResultForTemplate()) return;
  window.open('report-template.html', '_blank');
}

function buildBriefReportMarkdown(r) {
  const num = (v, d = 1) => v != null && isFinite(v) ? Number(v).toFixed(d) : '—';
  const loc = (v) => v != null && isFinite(v) ? Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—';
  const cur = (v) => v != null && isFinite(v) ? Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €' : '—';
  const months = ['Janv.','Févr.','Mars','Avr.','Mai','Juin','Juil.','Août','Sept.','Oct.','Nov.','Déc.'];
  const locName = r.meta.locationName || `${r.meta.lat.toFixed(4)}°N, ${r.meta.lng.toFixed(4)}°E`;

  let md = '';
  md += '# Résumé solaire\n\n';
  md += '| Vos informations | |\n|:---|:---|\n';
  md += `| **Lieu** | ${locName} (${r.meta.lat.toFixed(3)}°N, ${r.meta.lng.toFixed(3)}°E) |\n`;
  md += `| **Date du rapport** | ${r.meta.timestamp.replace('T', ' ').replace(/\..+/, '')} |\n\n`;

  md += '| Résultat | Valeur |\n|:---|---:|\n';
  md += `| **Puissance du système** | **${num(r.results.totalKwp, 1)} kW** |\n`;
  md += `| **Production estimée / an** | **${loc(r.results.annualAC)} kWh** |\n`;
  md += `| Production par kW de panneaux | ${num(r.results.specificYield, 0)} kWh/kWp par an |\n`;
  md += `| Les panneaux fonctionnent à | ${num(r.results.capacityFactor, 1)}% de leur production maximale possible |\n`;
  if (r.financial) {
    const life = r.inputs.financial?.lifetime || 25;
    md += `| Investissement estimé | ${cur(r.financial.totalInvest)} |\n`;
    md += `| Bénéfice estimé / an | ${cur(r.financial.annualBenefit)} |\n`;
    md += `| Investissement récupéré en | environ ${num(r.financial.simplePaybackYear, 1)} ans |\n`;
    md += `| **Bénéfice sur ${life} ans** | **${r.financial.npv >= 0 ? '+' : ''}${cur(r.financial.npv)}** |\n`;
  }
  md += '\n';

  md += '**Production mensuelle (kWh) :**\n\n';
  md += '| ' + months.join(' | ') + ' |\n';
  md += '|' + '---:|'.repeat(12) + '\n';
  md += '| ' + r.monthly.ac.map(v => Math.round(v).toLocaleString('fr-FR')).join(' | ') + ' |\n\n';

  const co2Yr = r.results.annualAC * (r.inputs.financial?.co2Factor || 40) / 1000;
  if (co2Yr > 0) {
    const life = r.inputs.financial?.lifetime || 25;
    const kmEq = Math.round(co2Yr * 1000000 / (r.inputs.financial?.carEmissions || 120));
    md += `> Cela évite environ **${num(co2Yr, 0)} tonnes de CO₂ par an** (${num(co2Yr * life, 0)} tonnes sur la durée de vie du système) — soit environ ${kmEq.toLocaleString('fr-FR')} km en voiture en moins.\n\n`;
  }

  md += '---\n\n';
  md += `*Estimation générée par SERA — ${locName} · ${r.meta.timestamp.replace('T', ' ').replace(/\..+/, '')}*  \n`;
  md += '*Estimation automatisée basée sur des valeurs typiques. La production réelle dépend de la météo, de l’ombrage et de la qualité d’installation. Pour une étude technique complète, utilisez le mode Expert et le rapport détaillé.*\n';
  return md;
}

function exportReport() {
  if (!window.lastSimResult) {
    showToast('Aucun rapport à exporter. Lancez d’abord une simulation.');
    return;
  }
  const md = buildReportMarkdown(window.lastSimResult);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const loc = (window.lastSimResult.meta.locationName || window.lastSimResult.meta.lat + '_' + window.lastSimResult.meta.lng)
    .replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
  a.download = `rapport-solaire-${loc}-${window.lastSimResult.meta.year}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Rapport exporté en Markdown', 'success');
}

function buildReportMarkdown(r) {
  if (r.meta && r.meta.interface === 'beginner') {
    return buildBriefReportMarkdown(r);
  }
  const num = (v, d = 1) => v != null && isFinite(v) ? Number(v).toFixed(d) : '—';
  const pct = (v) => v != null && isFinite(v) ? Number(v).toFixed(1) + '%' : '—';
  const loc = (v) => v != null && isFinite(v) ? Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—';
  const cur = (v) => v != null && isFinite(v) ? Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €' : '—';
  const kwh = (v) => v != null && isFinite(v) ? Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kWh' : '—';
  const months = ['Janv.','Févr.','Mars','Avr.','Mai','Juin','Juil.','Août','Sept.','Oct.','Nov.','Déc.'];
  const fin = r.inputs.financial;
  const coverDate = r.meta.timestamp.replace('T', ' ').replace(/\..+/, '');
  const locName = r.meta.locationName || `${r.meta.lat.toFixed(4)}°N, ${r.meta.lng.toFixed(4)}°E`;

  let md = '';

  // ══════════════════════════════════════════════════════════════
  //  PAGE 1 — PROJECT OVERVIEW
  // ══════════════════════════════════════════════════════════════
  md += '# Rapport de simulation PV solaire\n\n';

  md += '| Paramètre | Valeur |\n';
  md += '|:---|---:|\n';
  md += `| **Projet** | Système PV — ${locName} |\n`;
  md += `| **Lieu** | ${locName} |\n`;
  md += `| **Coordonnées** | ${r.meta.lat.toFixed(4)}°N, ${r.meta.lng.toFixed(4)}°E |\n`;
  md += `| **Puissance installée** | **${num(r.results.totalKwp, 2)} kWp** |\n`;
  md += `| **Production AC annuelle** | **${kwh(r.results.annualAC)}** |\n`;
  md += `| **Ratio de performance** | **${pct(r.results.prAnnuel)}** |\n`;
  md += `| **Données météo** | ${r.meta.year} (${r.weather.radDb}${r.weather.meteoDb ? ' + ' + r.weather.meteoDb : ''}) |\n`;
  md += `| **Mode de simulation** | ${r.meta.mode === 'multi-year' ? 'Pluriannuel (' + r.results.variabilityStats?.years + ' ans)' : 'Annuelle'} |\n`;
  md += `| **Date du rapport** | ${coverDate} |\n`;
  md += `| **Moteur** | SERA — Analyseur de Ressource d’Énergie Solaire |\n\n`;

  if (r.results.variabilityStats) {
    md += `> **P50 (attendu) :** ${kwh(r.results.variabilityStats.p50)} · `;
    md += `**P90 (prudent) :** ${kwh(r.results.variabilityStats.p90)} · `;
    md += `**CV :** ±${num(r.results.variabilityStats.cv, 1)}%\n\n`;
  }

  if (r.financial) {
    md += `> **Investissement :** ${cur(r.financial.totalInvest)} · `;
    md += `**VAN :** ${r.financial.npv > 0 ? '+' : ''}${cur(r.financial.npv)} · `;
    md += `**TRI :** ${r.financial.irr != null ? pct(r.financial.irr * 100) : '—'} · `;
    md += `**LCOE :** ${num(r.financial.lcoe, 4)} €/kWh · `;
    md += `**Amortissement :** ${r.financial.simplePaybackYear ? num(r.financial.simplePaybackYear, 1) + ' ans' : '—'}\n\n`;
  }

  md += '<div style="page-break-after: always;"></div>\n\n';

  // ══════════════════════════════════════════════════════════════
  //  PAGE 2 — SITE & SYSTEM CONFIGURATION
  // ══════════════════════════════════════════════════════════════
  md += '## 1. Configuration du site & système\n\n';

  md += '### 1.1 Données du site\n\n';
  md += '| Paramètre | Valeur |\n';
  md += '|:---|---:|\n';
  md += `| Latitude | ${r.meta.lat.toFixed(4)}°N |\n`;
  md += `| Longitude | ${r.meta.lng.toFixed(4)}°E |\n`;
  md += `| Base météo | ${r.weather.radDb}${r.weather.meteoDb ? ' + ' + r.weather.meteoDb : ''} |\n`;
  md += `| Période de données | ${r.meta.year} |\n`;
  md += `| Années disponibles | ${r.weather.availableYears.join(', ') || '—'} |\n`;
  if (r.monthly.avgTemp) {
    const tMin = Math.min(...r.monthly.avgTemp);
    const tMax = Math.max(...r.monthly.avgTemp);
    const tAvg = r.monthly.avgTemp.reduce((a, b) => a + b, 0) / 12;
    md += `| Température ambiante | ${num(tAvg, 1)}°C (${num(tMin, 1)}–${num(tMax, 1)}°C) |\n`;
  }
  md += '\n';

  md += '### 1.2 Configuration du champ PV\n\n';
  md += `Le système comprend **${r.inputs.sections.length}** section(s) — **${num(r.results.totalKwp, 2)} kWp** au total.\n\n`;

  r.inputs.sections.forEach((s, i) => {
    const sec = r.sections && r.sections[i] ? r.sections[i] : null;
    md += `**Section ${i + 1} :** ${s.kWc} kWp · ${s.tilt}° inclinaison · ${s.azimuth}° azimut · ${s.panel} (${s.efficiency}%) · ${s.mount}\n\n`;
    md += '| Perte | Valeur |\n|:---|---:|\n';
    md += `| Câble | ${s.cableLoss}% |\n| Onduleur | ${s.invLoss}% |\n| Module | ${s.pvLoss}% |\n| Qualité | ${s.qualityLoss}% |\n| Désadaptation | ${s.mismatchLoss}% |\n| Salissures | ${s.soilingLoss}% |\n`;
    if (sec) {
      md += `| **Contribution annuelle** | **${kwh(sec.total)}** |\n`;
      if (sec.dustRec) md += `| Inclinaison anti-poussière | ${sec.dustRec.tilt}° (${num(sec.dustRec.ratio * 100, 1)}%) |\n`;
    }
    md += '\n';
  });

  md += '<div style="page-break-after: always;"></div>\n\n';

  // ══════════════════════════════════════════════════════════════
  //  PAGE 3 — ENERGY PRODUCTION
  // ══════════════════════════════════════════════════════════════
  md += '## 2. Production d’énergie\n\n';

  md += '### 2.1 Indicateurs clés de performance\n\n';
  md += '| Indicateur | Valeur | Unité |\n';
  md += '|:---|---:|---|\n';
  md += `| Production AC annuelle | ${loc(r.results.annualAC)} | kWh |\n`;
  md += `| Productible spécifique | ${num(r.results.specificYield, 0)} | kWh/kWp |\n`;
  md += `| Facteur de charge | ${num(r.results.capacityFactor, 1)} | % |\n`;
  md += `| Ratio de performance (PR) | **${num(r.results.prAnnuel, 1)}** | % |\n`;
  md += `| Irradiation annuelle dans le plan (GTI) | ${loc(r.results.annualGti)} | kWh/m² |\n`;
  md += `| Irradiation horizontale (GHI) | ${loc(r.losses.sumGHI)} | kWh/m² |\n`;
  md += `| Heures de soleil équivalentes | ${num(r.results.sunEquivalent, 2)} | h/jour |\n`;
  md += '\n';

  md += '### 2.2 Bilan énergétique mensuel\n\n';
  md += '| Mois | GHI | GTI | Prod. | PR | Heures sol. |';
  if (r.monthly.avgTemp) md += ' T°C |';
  md += '\n|:---|:---|:---|:---|:---:|:---:|';
  if (r.monthly.avgTemp) md += ':---:|';
  md += '\n';
  let tGHI = 0, tGTI = 0, tAC = 0;
  r.monthly.ghi.forEach((ghi, i) => {
    const gti = r.monthly.gti[i], ac = r.monthly.ac[i];
    const pr = gti > 0 ? (ac / Math.max(gti * r.results.prKwp, 0.001) * 100) : 0;
    const sh = r.results.totalKwp > 0 ? ac / r.results.totalKwp / [31,28,31,30,31,30,31,31,30,31,30,31][i] : 0;
    let row = `| ${months[i]} | ${num(ghi, 0)} | ${num(gti, 0)} | ${num(ac, 0)} | ${num(pr, 1)} | ${num(sh, 2)}`;
    if (r.monthly.avgTemp) row += ` | ${num(r.monthly.avgTemp[i], 1)}`;
    md += row + ' |\n';
    tGHI += ghi; tGTI += gti; tAC += ac;
  });
  md += `| **Total** | **${num(tGHI, 0)}** | **${num(tGTI, 0)}** | **${num(tAC, 0)}** | **${num(r.results.prAnnuel, 1)}** | **${num(r.results.sunEquivalent, 2)}**`;
  if (r.monthly.avgTemp) md += ' | —';
  md += ' |\n\n';

  // Seasonal
  const seasons = [
    { label: 'Hiver (DJF)', idx: [11,0,1] },
    { label: 'Printemps (MAM)', idx: [2,3,4] },
    { label: 'Été (JJA)', idx: [5,6,7] },
    { label: 'Automne (SON)', idx: [8,9,10] }
  ];
  md += '### 2.3 Répartition saisonnière\n\n';
  md += '| Saison | Prod. (kWh) | Part | GTI moy. | PR moy. |\n|:---|---:|:---|:---:|:---:|\n';
  seasons.forEach(s => {
    const p = s.idx.reduce((a, i) => a + r.monthly.ac[i], 0);
    const g = s.idx.reduce((a, i) => a + r.monthly.gti[i], 0);
    const pr = s.idx.reduce((a, i) => a + (r.monthly.gti[i] > 0 ? r.monthly.ac[i] / Math.max(r.monthly.gti[i] * r.results.prKwp, 0.001) * 100 : 0), 0) / s.idx.filter(i => r.monthly.gti[i] > 0).length;
    md += `| ${s.label} | ${loc(p)} | ${r.results.annualAC > 0 ? num(p / r.results.annualAC * 100, 1) : 0}% | ${num(g, 0)} | ${num(pr, 1)}% |\n`;
  });
  md += '\n';

  const bestM = r.monthly.ac.indexOf(Math.max(...r.monthly.ac));
  const worstM = r.monthly.ac.indexOf(Math.min(...r.monthly.ac));
  md += `> **Max :** ${months[bestM]} (${kwh(r.monthly.ac[bestM])}) · **Min :** ${months[worstM]} (${kwh(r.monthly.ac[worstM])})\n\n`;

  // P50/P90 section when variability data exists
  if (r.results.variabilityStats && r.results.variabilityStats.yearlyAC) {
    md += '### 2.4 Variabilité interannuelle\n\n';
    md += `Sur ${r.results.variabilityStats.years} ans de données :\n\n`;
    md += '| Statistique | Valeur |\n|:---|---:|\n';
    md += `| Moyenne | ${kwh(r.results.variabilityStats.mean)} |\n`;
    md += `| Écart-type (σ) | ${kwh(r.results.variabilityStats.std)} |\n`;
    md += `| CV | ${num(r.results.variabilityStats.cv, 1)}% |\n`;
    md += `| Min (observé) | ${kwh(r.results.variabilityStats.min)} |\n`;
    md += `| Max (observé) | ${kwh(r.results.variabilityStats.max)} |\n`;
    md += `| **P50 (attendu)** | **${kwh(r.results.variabilityStats.p50)}** |\n`;
    md += `| **P90 (prudent)** | **${kwh(r.results.variabilityStats.p90)}** |\n\n`;
  }

  md += '<div style="page-break-after: always;"></div>\n\n';

  // ══════════════════════════════════════════════════════════════
  //  PAGE 4 — LOSS ANALYSIS
  // ══════════════════════════════════════════════════════════════
  md += '## 3. Analyse des pertes\n\n';

  md += '### 3.1 Cascade des pertes\n\n';
  md += '| Étape | Énergie (kWh) | % du GHI | Δ préc. |\n|:---|---:|:---:|:---:|\n';
  r.losses.cascade.forEach((row, i) => {
    const pctGHI = r.losses.sumGHI > 0 ? row.kWh / r.losses.sumGHI * 100 : 0;
    const prev = i > 0 ? r.losses.cascade[i - 1].kWh : null;
    let lossStr = '—';
    if (prev != null && prev > 0) {
      const lossPct = (prev - row.kWh) / prev * 100;
      lossStr = lossPct >= 0 ? '−' + num(lossPct, 1) + '%' : '+' + num(Math.abs(lossPct), 1) + '%';
    }
    md += `| ${row.stage} | ${loc(row.kWh)} | ${num(pctGHI, 1)}% | ${lossStr} |\n`;
  });
  md += '\n';

  md += '### 3.2 Synthèse des pertes\n\n';
  md += '| Catégorie | Valeur | Description |\n|:---|---:|:---|\n';
  md += `| Transposition | ${r.losses.sumGHI > 0 ? num((r.losses.sumIdeal - r.losses.sumGHI) / r.losses.sumGHI * 100, 1) + '%' : '—'} | Inclinaison/azimut vs horizontal |\n`;
  md += `| Horizon | ${r.losses.sumIdeal > 0 ? num((1 - r.losses.sumAfterHorizon / r.losses.sumIdeal) * 100, 1) + '%' : '—'} | Profil d’ombrage lointain |\n`;
  md += `| IAM | ${r.losses.sumAfterHorizon > 0 ? num((1 - r.losses.sumAfterIAM / r.losses.sumAfterHorizon) * 100, 1) + '%' : '—'} | Réflexion Martin & Ruiz |\n`;
  md += `| Spectral | ${r.losses.sumAfterIAM > 0 ? num((1 - r.losses.sumAfterSpec / r.losses.sumAfterIAM) * 100, 1) + '%' : '—'} | Effet de masse d’air |\n`;
  md += `| Faible éclairement | ${r.losses.sumAfterSpec > 0 ? num((1 - r.losses.sumAfterLowIrrad / r.losses.sumAfterSpec) * 100, 1) + '%' : '—'} | η non linéaire à faible W/m² |\n`;
  md += `| Température | ${r.losses.sumAfterLowIrrad > 0 ? num((1 - r.losses.sumAfterTemp / r.losses.sumAfterLowIrrad) * 100, 1) + '%' : '—'} | Cellule >25°C |\n`;
  md += `| Câble DC | ${r.losses.cLoss != null ? num(r.losses.cLoss, 1) + '%' : '—'} | Câblage ohmique |\n`;
  md += `| Onduleur | ${r.losses.iLoss != null ? num(r.losses.iLoss, 1) + '%' : '—'} | Conversion |\n`;
  md += `| Qualité | ${r.losses.qLoss != null ? num(r.losses.qLoss, 1) + '%' : '—'} | Tolérance |\n`;
  md += `| Désadaptation | ${r.losses.mLoss != null ? num(r.losses.mLoss, 1) + '%' : '—'} | Discordance des chaînes |\n`;
  md += `| Salissures | ${r.losses.sLoss != null ? num(r.losses.sLoss, 1) + '%' : '—'} | Poussière/neige |\n`;
  md += `| **Facteur physique** | **${pct(r.losses.physicalFactor * 100)}** | Transp→horizon→IAM→spec→faibleÉcl→temp |\n`;
  md += `| **Facteur système** | **${pct(r.losses.sysFactor * 100)}** | Câble×ond×module×qual×désad×salis |\n`;
  md += `| **PR total** | **${pct(r.results.prAnnuel)}** | Physique × Système |\n\n`;

  md += '<div style="page-break-after: always;"></div>\n\n';

  // ══════════════════════════════════════════════════════════════
  //  PAGE 5 — FINANCIAL ANALYSIS
  // ══════════════════════════════════════════════════════════════
  if (r.financial) {
    md += '## 4. Analyse financière\n\n';

    md += '### 4.1 Investissement & revenus\n\n';
    md += '| Poste | Montant |\n|:---|---:|\n';
    md += `| CAPEX total | **${cur(r.financial.totalInvest)}** |\n`;
    md += `| Coût spécifique | ${num(fin.invCost, 0)} €/kWp |\n`;
    md += `| O&M sur durée de vie | ${cur(r.financial.totalOMLifetime || 0)} |\n`;
    md += `| Remplacement onduleur (an ${r.financial.invReplaceYear}) | ${r.financial.invReplaceCost ? cur(r.financial.invReplaceCost * r.results.totalKwp) : '—'} |\n`;
    md += `| Prix électricité (A1) | ${num(fin.elecPrice, 3)} €/kWh |\n`;
    md += `| Tarif d’injection | ${num(fin.feedIn, 3)} €/kWh |\n`;
    md += `| Autoconsommé (A1) | ${kwh(r.financial.selfConsumed)} × ${num(fin.elecPrice, 3)} € = **${cur(r.financial.annualSavings)}** |\n`;
    md += `| Injecté réseau (A1) | ${kwh(r.financial.fedToGrid)} × ${num(fin.feedIn, 3)} € = **${cur(r.financial.annualFeedin)}** |\n`;
    md += `| **Bénéfice annuel net (A1)** | **${cur(r.financial.annualBenefit)}** |\n\n`;

    md += '| Indicateur | Valeur |\n|:---|---:|\n';
    md += `| VAN (${fin.lifetime} ans, ${fin.discountRate}% actu.) | ${r.financial.npv > 0 ? '+' : ''}${cur(r.financial.npv)} |\n`;
    md += `| TRI | ${r.financial.irr != null ? pct(r.financial.irr * 100) : '—'} |\n`;
    md += `| LCOE | ${num(r.financial.lcoe, 4)} €/kWh |\n`;
    md += `| Amortissement simple | ${r.financial.simplePaybackYear ? num(r.financial.simplePaybackYear, 1) + ' ans' : '—'} |\n`;
    md += `| Amortissement actualisé | ${r.financial.discountedPaybackYear ? num(r.financial.discountedPaybackYear, 1) + ' ans' : '—'} |\n`;
    md += `| Dégradation | ${fin.degradation}%/an |\n`;
    md += `| Taux d’actualisation | ${fin.discountRate}% |\n`;
    md += `| Durée de vie du système | ${fin.lifetime} ans |\n\n`;

    if (r.financial.yearlyCashFlow && r.financial.yearlyCashFlow.length > 0) {
      md += '### 4.2 Trésorerie année par année (années sélectionnées)\n\n';
      md += '| Année | Flux net | Cumulé |\n|:---:|:---:|:---:|\n';
      const step = Math.max(1, Math.floor(r.financial.yearlyCashFlow.length / 10));
      const breakEven = r.financial.yearlyCashFlow.find(row => row.cumulative >= 0);
      r.financial.yearlyCashFlow.forEach((row, i) => {
        if (i % step !== 0 && i !== 0 && i !== r.financial.yearlyCashFlow.length - 1 && row.year !== breakEven?.year) return;
        md += `| ${row.year} | ${row.netCashFlow != null ? cur(row.netCashFlow) : '—'} | ${row.cumulative >= 0 ? '+' : ''}${cur(row.cumulative)} |\n`;
      });
      md += '\n';
      if (breakEven) {
        md += `> Seuil de rentabilité atteint en **année ${breakEven.year}** (cumul actualisé positif).\n\n`;
      }
    }

    md += '<div style="page-break-after: always;"></div>\n\n';
  }

  // ══════════════════════════════════════════════════════════════
  //  PAGE 6 — ENVIRONMENTAL IMPACT
  // ══════════════════════════════════════════════════════════════
  if (fin) {
    const envIdx = r.financial ? 5 : 4;
    md += `## ${envIdx}. Impact environnemental\n\n`;
    const cf = fin.co2Factor || 400;
    const car = fin.carEmissions || 120;
    const life = fin.lifetime || 25;
    const co2yr = r.results.annualAC * cf / 1000;
    const co2life = co2yr * life;
    const kmEq = co2yr * 1000000 / car;
    const treesEq = co2yr / 0.022;
    const homesEq = co2yr / 1.5;

    md += '| Indicateur | Valeur | Équivalent |\n|:---|---:|:---|\n';
    md += `| Intensité CO₂ réseau | ${cf} g/kWh | — |\n`;
    md += `| CO₂ évité / an | **${num(co2yr, 1)} t** | ${Math.round(kmEq).toLocaleString('fr-FR')} km-voiture |\n`;
    md += `| CO₂ évité / ${life} ans | **${num(co2life, 1)} t** | ${Math.round(treesEq).toLocaleString('fr-FR')} années-arbre |\n`;
    md += `| Foyers alimentés | ${num(homesEq, 1)} | à 1,5 t CO₂/foyer/an |\n\n`;
    md += '<div style="page-break-after: always;"></div>\n\n';
  }

  // ══════════════════════════════════════════════════════════════
  //  PAGE 7 — METHODOLOGY
  // ══════════════════════════════════════════════════════════════
  const methIdx = r.financial ? 6 : 5;
  md += `## ${methIdx}. Méthodologie\n\n`;

  md += '### Sources de données\n\n';
  md += `- **Météo :** ${r.weather.radDb}${r.weather.meteoDb ? ' avec réanalyse ' + r.weather.meteoDb : ''} — horaire\n`;
  md += '- **Horizon :** Calculé par MNE (PVGIS)\n\n';

  md += '### Modèles\n\n';
  md += '- **Transposition :** Hay-Davies (direct + isotrope + circumsolaire + brillance d’horizon)\n';
  md += '- **Température cellule :** Sandia (NOCT + vent)\n';
  md += '- **IAM :** Martin & Ruiz (réflexion selon l’angle)\n';
  md += '- **Correction spectrale :** masse d’air + paramétrisation PW (PVGIS)\n';
  md += '- **P50/P90 :** moyenne ± 1,282σ (distribution normale)\n';
  md += '- **Financier :** DCF — VAN, TRI (recherche dichotomique), amortissement, LCOE\n';
  md += '- **Dégradation :** réduction linéaire annuelle\n\n';

  md += '### Normes\n\n';
  md += '- Ratio de performance selon IEC 61724-1:2017\n';
  md += '- Indicateurs financiers selon les lignes directrices IEA PVPS Task 13\n\n';

  md += '---\n\n';
  md += `*Généré par SERA — ${r.meta.lat.toFixed(3)}°N, ${r.meta.lng.toFixed(3)}°E · ${r.meta.year} · ${coverDate}*  \n`;
  md += '*Rapport de simulation automatisé. Les performances réelles peuvent varier. Consultez un ingénieur PV certifié pour les décisions d’investissement.*\n';

  return md;
}
