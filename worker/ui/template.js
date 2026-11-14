/**
 * Генератор HTML-сторінки моніторингу статусу ОСББ "Новодарницьке".
 * Ізольований презентаційний шар (UI / View).
 */

import { resolveSystemState, SystemStateId } from '../domain/system-state.js';

function getPhaseColor(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '#94a3b8';
  if (v < 50) return '#ef4444';
  if (v < 195 || v > 255) return '#ef4444';
  if (v < 205 || v > 248) return '#f59e0b';
  return '#10b981';
}

function buildVoltageBarHTML(gridVoltages, loadVoltages, isGridOn) {
  if (!gridVoltages || typeof gridVoltages.l1 !== 'number' || typeof gridVoltages.l2 !== 'number' || typeof gridVoltages.l3 !== 'number') {
    return '';
  }
  const phases = [
    ['L1', gridVoltages.l1],
    ['L2', gridVoltages.l2],
    ['L3', gridVoltages.l3]
  ];
  const allDead = phases.every(([, v]) => v < 50);
  const chipsHtml = phases.map(([name, val]) => {
    const color = getPhaseColor(val);
    const valStr = val < 5 ? '0' : Math.round(val);
    return `<div style="background:rgba(15,23,42,0.55); border:1px solid ${color}44; border-radius:10px; padding:6px 8px; text-align:center;">
      <div style="font-size:0.65rem; color:var(--text-muted);">${name}</div>
      <div style="font-size:0.95rem; font-weight:700; color:${color};">${valStr} <small style="font-size:0.68rem;">В</small></div>
    </div>`;
  }).join('');

  let loadNote = '';
  if (!isGridOn && loadVoltages && typeof loadVoltages.l1 === 'number' && typeof loadVoltages.l2 === 'number' && typeof loadVoltages.l3 === 'number') {
    const avgLoadV = Math.round((loadVoltages.l1 + loadVoltages.l2 + loadVoltages.l3) / 3);
    if (avgLoadV > 100) {
      loadNote = ` • На будинок: <strong>~${avgLoadV} В</strong>`;
    }
  }

  const statusTag = allDead
    ? `<span style="color:#f87171;">0 В (вимкнено ДТЕК)</span>`
    : `<span style="color:var(--text-muted);">Норма: 205–248 В (відсічка &lt;195 / &gt;255)</span>`;

  return `
    <div class="card" style="padding:12px 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap;">
        <div style="font-size:0.78rem; font-weight:700; color:var(--text-main);">⚡ Напруга міської мережі (по фазах)</div>
        <div style="font-size:0.66rem; color:var(--text-muted);">${statusTag}${loadNote}</div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
        ${chipsHtml}
      </div>
    </div>
  `;
}

function renderOutageCardHTML(outage, gradId) {
  return `
      <div class="card">
        <!-- Outage Title & Duration -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:6px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="width:9px; height:9px; border-radius:50%; background:${outage.isOngoing ? '#ef4444' : (outage.eventType === 'VOLTAGE_SAG' ? '#f59e0b' : '#64748b')}; box-shadow:${outage.isOngoing ? '0 0 8px #ef4444' : 'none'};"></span>
            <strong style="font-size:0.88rem; color:var(--text-main);">
              ${outage.isOngoing ? `Триває зараз: ${outage.dayLabel && outage.dayLabel !== 'Сьогодні' ? `<span style="color:#94a3b8; font-weight:500;">${outage.dayLabel},</span> ` : ''}з ${outage.start}` : `Відключення: ${outage.dayLabel ? `<span style="color:#94a3b8; font-weight:500;">${outage.dayLabel},</span> ` : ''}${outage.start} — ${outage.end}`}
            </strong>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            ${outage.eventLabel ? `
              <div style="font-size:0.68rem; color:${outage.eventBadgeColor || '#f59e0b'}; font-weight:600; background:${outage.eventBadgeBg || 'rgba(245,158,11,0.12)'}; padding:2px 7px; border-radius:6px;">
                ${outage.eventLabel}
              </div>
            ` : ''}
            <div style="font-size:0.72rem; color:#60a5fa; font-weight:700; background:rgba(59,130,246,0.12); padding:3px 8px; border-radius:8px;">
              ⏳ ${outage.durStr}
            </div>
          </div>
        </div>

        <!-- Outage Stats: Peak & Average -->
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; margin-bottom:12px;">
          <div class="journal-badge">
            <div class="jb-val" style="color:#f59e0b;">${outage.peakKw} <small style="font-size:0.65rem">кВт</small></div>
            <div class="jb-lbl">⚡ Пік (${outage.peakTime})</div>
          </div>
          <div class="journal-badge">
            <div class="jb-val" style="color:#60a5fa;">${outage.avgKw} <small style="font-size:0.65rem">кВт</small></div>
            <div class="jb-lbl">📊 Сер. навантаження</div>
          </div>
          <div class="journal-badge">
            <div class="jb-val" style="color:#34d399;">${outage.socDrain > 0 ? `${outage.startSoc}% ➔ ${outage.minSoc}%` : `~${outage.energyKwh} кВт·год`}</div>
            <div class="jb-lbl">${outage.socDrain > 0 ? `🔋 Розряд (-${outage.socDrain}%)` : `🔋 Витрачено (~${outage.energyKwh} кВт·год)`}</div>
          </div>
        </div>

        <!-- Zoomed SVG Chart -->
        <div style="width: 100%; overflow: hidden;">
          <svg viewBox="0 0 520 175" style="width:100%; height:auto; display:block;">
            <defs>
              <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
              </linearGradient>
            </defs>

            <!-- Grid Lines -->
            <line x1="35" y1="22" x2="505" y2="22" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 3"/>
            <text x="30" y="26" fill="#94a3b8" font-size="8.5" text-anchor="end">${outage.maxKw}кВт</text>

            <line x1="35" y1="${Math.round((22 + 145)/2)}" x2="505" y2="${Math.round((22 + 145)/2)}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 3"/>
            <text x="30" y="${Math.round((22 + 145)/2) + 3}" fill="#94a3b8" font-size="8.5" text-anchor="end">${outage.midKw}кВт</text>

            <line x1="35" y1="145" x2="505" y2="145" stroke="rgba(255,255,255,0.12)"/>
            <text x="30" y="148" fill="#94a3b8" font-size="8.5" text-anchor="end">0</text>

            <!-- Average Dashed Line -->
            <line x1="35" y1="${outage.yAvg}" x2="505" y2="${outage.yAvg}" stroke="#f59e0b" stroke-dasharray="4 3" stroke-width="1.2" opacity="0.8"/>
            <text x="502" y="${Math.max(16, outage.yAvg - 4)}" fill="#f59e0b" font-size="8" font-weight="700" text-anchor="end">Сер: ${outage.avgKw} кВт</text>

            <!-- Area fill -->
            <path d="${outage.areaD}" fill="url(#${gradId})" />

            <!-- Power Curve -->
            <path d="${outage.pathD}" fill="none" stroke="#3b82f6" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>

            <!-- Battery SOC Line -->
            <path d="${outage.socD}" fill="none" stroke="#10b981" stroke-width="1.8" stroke-dasharray="3 3"/>

            <!-- Peak Badge -->
            <circle cx="${outage.peakX}" cy="${outage.peakY}" r="3.5" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/>
            <rect x="${outage.peakX - 22}" y="${Math.max(5, outage.peakY - 17)}" width="44" height="13" rx="3" fill="rgba(15, 23, 42, 0.88)" stroke="rgba(245, 158, 11, 0.4)" stroke-width="0.8"/>
            <text x="${outage.peakX}" y="${Math.max(14, outage.peakY - 8)}" fill="#f59e0b" font-size="8.5" font-weight="700" text-anchor="middle">${outage.peakKw} кВт</text>

            <!-- Timestamps -->
            ${outage.labelsSvg}
          </svg>
        </div>

        <!-- Legend -->
        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:0.68rem; color:#94a3b8; border-top:1px solid rgba(255,255,255,0.06); padding-top:6px;">
          <span style="display:flex; align-items:center; gap:4px;"><span style="width:10px; height:2px; background:#3b82f6; display:inline-block;"></span> Споживання (кВт)</span>
          <span style="display:flex; align-items:center; gap:4px;"><span style="width:10px; height:2px; background:#f59e0b; border-top:1px dashed #f59e0b; display:inline-block;"></span> Сер.: ${outage.avgKw} кВт</span>
          <span style="display:flex; align-items:center; gap:4px;"><span style="width:10px; height:2px; background:#10b981; border-top:1px dashed #10b981; display:inline-block;"></span> АКБ: ${outage.socDrain > 0 ? `${outage.startSoc}% ➔ ${outage.minSoc}%` : `100% (~${outage.energyKwh} кВт·год)`}</span>
        </div>
      </div>`;
}

export function renderHTML(data) {
  const state = resolveSystemState(data);
  const isOnline = state.isOnline;
  const soc = data.battery_soc ?? 0;
  const strokeColor = state.gaugeStrokeColor;
  const offset = 502 - (soc / 100) * 502;
  const rawOutages = data.outages || [];
  const ongoingChart = data.ongoing_outage_chart !== undefined
    ? data.ongoing_outage_chart
    : (rawOutages.find(o => o && o.isOngoing) || null);
  const blackoutCharts = Array.isArray(data.blackout_outages)
    ? data.blackout_outages
    : rawOutages.filter(o => o && !o.isOngoing && o.eventType !== 'VOLTAGE_SAG').slice(0, 3);
  const voltageCharts = Array.isArray(data.voltage_outages)
    ? data.voltage_outages
    : rawOutages.filter(o => o && !o.isOngoing && o.eventType === 'VOLTAGE_SAG').slice(0, 3);
  const journal = data.journal || { count: 0, totalHoursFormatted: "0 хв", minSoc: 100 };
  const currOutage = data.current_outage;
  const outageStartStr = currOutage ? (currOutage.dayLabel && currOutage.dayLabel !== 'Сьогодні' ? `(з ${currOutage.dayLabel} ${currOutage.start})` : `(з ${currOutage.start})`) : '';
  const outageDurStr = currOutage 
    ? (currOutage.durationMin >= 60 
        ? `${Math.floor(currOutage.durationMin / 60)} год${currOutage.durationMin % 60 ? ` ${currOutage.durationMin % 60} хв` : ''}` 
        : `${currOutage.durationMin} хв`) 
    : '';

  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Статус енергопостачання | ОСББ "Новодарницьке"</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b1120;
      --card-bg: rgba(30, 41, 59, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, sans-serif; }
    body {
      background: radial-gradient(circle at 50% 0%, #1e293b, var(--bg) 80%);
      color: var(--text-main); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 14px;
    }
    .container { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 14px; }
    .header { display: flex; align-items: center; justify-content: space-between; padding: 6px 4px; }
    .title-block h1 { font-size: 1.15rem; font-weight: 700; }
    .title-block p { font-size: 0.78rem; color: var(--text-muted); }
    .live-badge { display: flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: #34d399; font-size: 0.75rem; font-weight: 600; padding: 4px 10px; border-radius: 20px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 10px #10b981; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
    .card { background: var(--card-bg); backdrop-filter: blur(12px); border: 1px solid var(--card-border); border-radius: 20px; padding: 18px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
    
    .status-banner { display: flex; align-items: center; gap: 14px; border-left: 5px solid ${state.bannerBorderColor}; }
    .status-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; background: ${state.bannerIconBg}; color: ${state.bannerIconColor}; flex-shrink: 0; }
    .status-info h2 { font-size: 1.08rem; font-weight: 700; }
    .status-info p { font-size: 0.8rem; color: var(--text-muted); }

    .gauge-wrapper { position: relative; width: 180px; height: 180px; margin: 8px auto 14px; display: flex; align-items: center; justify-content: center; }
    .gauge-svg { transform: rotate(-90deg); width: 100%; height: 100%; }
    .gauge-bg { fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 12; }
    .gauge-progress { fill: none; stroke: ${strokeColor}; stroke-width: 12; stroke-linecap: round; stroke-dasharray: 502; stroke-dashoffset: ${offset}; transition: stroke-dashoffset 1s ease; }
    .gauge-text { position: absolute; display: flex; flex-direction: column; align-items: center; }
    .gauge-val { font-size: 2.7rem; font-weight: 800; line-height: 1; }
    .gauge-unit { font-size: 1.05rem; color: var(--text-muted); }
    .gauge-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; }

    .forecast-box { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 14px; text-align: center; }
    .forecast-title { font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; letter-spacing: 0.5px; }
    .forecast-main { font-size: 1.45rem; font-weight: 800; color: ${state.id === SystemStateId.GRID_CHARGING ? '#34d399' : '#60a5fa'}; }
    .forecast-sub { font-size: 0.8rem; color: var(--text-muted); margin-top: 6px; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .metric { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 12px; }
    .metric-label { font-size: 0.72rem; color: var(--text-muted); }
    .metric-val { font-size: 1.25rem; font-weight: 700; margin-top: 2px; }

    /* JOURNAL STYLES */
    .journal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .journal-title { font-size: 0.82rem; font-weight: 700; color: var(--text-main); }
    .journal-summary { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    .journal-badge { background: rgba(15,23,42,0.5); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 8px 6px; text-align: center; }
    .jb-val { font-size: 1rem; font-weight: 700; color: #f8fafc; }
    .jb-lbl { font-size: 0.65rem; color: var(--text-muted); }

    .journal-tab { width: 100%; text-align: left; font-family: inherit; color: inherit; background: rgba(15,23,42,0.55); border-radius: 12px; padding: 9px 11px; cursor: pointer; transition: all 0.18s ease; }
    .journal-tab-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .journal-tab-dot { width: 9px; height: 9px; border-radius: 50%; background: #475569; flex-shrink: 0; transition: all 0.18s ease; }
    .journal-tab-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 3px; font-size: 0.65rem; color: var(--text-muted); }
    .journal-panel { display: flex; flex-direction: column; gap: 14px; }
    .journal-panel.is-hidden { display: none; }

    .event-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(15,23,42,0.4); border-radius: 10px; font-size: 0.78rem; margin-bottom: 6px; }
    .event-left { display: flex; align-items: center; gap: 8px; }
    .event-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; }
    .event-right { text-align: right; color: var(--text-muted); font-size: 0.72rem; }

    .tip-box { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); border-radius: 16px; padding: 12px; display: flex; gap: 10px; font-size: 0.8rem; color: #fef3c7; }
    .footer { text-align: center; font-size: 0.75rem; color: var(--text-muted); padding: 12px 0; }
    .btn { background: rgba(255,255,255,0.08); border: 1px solid var(--card-border); color: #fff; padding: 7px 14px; border-radius: 10px; cursor: pointer; font-weight: 600; margin-top: 6px; font-size: 0.75rem; }

    /* MONTHLY ARCHIVE TRIGGER & NATIVE MODAL DIALOG (Responsive + Symmetric Subgrid) */
    .archive-trigger-btn { width: 100%; margin-top: 9px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 13px; border-radius: 12px; background: linear-gradient(135deg, rgba(59,130,246,0.16), rgba(30,41,59,0.85)); border: 1px solid rgba(96,165,250,0.35); color: var(--text-main); font-family: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: transform 0.12s ease, border-color 0.18s ease, background 0.18s ease; }
    .archive-trigger-btn:hover { border-color: rgba(96,165,250,0.7); background: linear-gradient(135deg, rgba(59,130,246,0.25), rgba(30,41,59,0.92)); }
    .archive-trigger-btn:active { transform: scale(0.99); }
    .archive-trigger-left { display: flex; align-items: center; gap: 8px; text-align: left; }
    .archive-trigger-sub { display: block; font-size: 0.68rem; font-weight: 400; color: var(--text-muted); margin-top: 1px; }
    .archive-pill { display: inline-flex; align-items: center; gap: 5px; background: rgba(59,130,246,0.2); border: 1px solid rgba(96,165,250,0.35); color: #93c5fd; padding: 4px 9px; border-radius: 999px; font-size: 0.72rem; font-weight: 700; white-space: nowrap; flex-shrink: 0; }

    dialog.archive-modal { margin: auto; width: calc(100vw - 20px); max-width: min(94vw, 1140px); max-height: min(88vh, 860px); padding: 0; border: 1px solid rgba(255,255,255,0.14); border-radius: 22px; background: #0f172a; color: var(--text-main); box-shadow: 0 24px 64px rgba(0,0,0,0.68); overflow: hidden; }
    dialog.archive-modal[open] { display: flex; flex-direction: column; }
    dialog.archive-modal:modal { overscroll-behavior: contain; }
    dialog.archive-modal::backdrop { background: rgba(2,6,23,0.76); backdrop-filter: blur(6px); overflow: hidden; overscroll-behavior: contain; }

    .modal-head { padding: 14px 16px 12px; background: rgba(15,23,42,0.97); border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; }
    .modal-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .modal-title { font-size: 1.02rem; font-weight: 700; line-height: 1.25; }
    .modal-subtitle { font-size: 0.73rem; color: var(--text-muted); margin-top: 2px; }
    .modal-close-x { width: 32px; height: 32px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(30,41,59,0.8); color: var(--text-muted); font-size: 1rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: color 0.15s ease, background 0.15s ease; }
    .modal-close-x:hover { color: #fff; background: rgba(239,68,68,0.25); border-color: rgba(239,68,68,0.45); }

    .modal-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .modal-kpi { background: rgba(30,41,59,0.62); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 8px 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 2px; }
    .modal-kpi-val { font-size: 0.95rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
    .modal-kpi-sub { font-size: 0.69rem; color: #cbd5e1; font-weight: 500; font-variant-numeric: tabular-nums; }
    .modal-kpi-lbl { font-size: 0.66rem; color: var(--text-muted); }

    .filter-bar { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
    .filter-chip { padding: 7px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); background: rgba(30,41,59,0.55); color: var(--text-muted); font-family: inherit; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: all 0.15s ease; text-align: center; white-space: nowrap; }
    .filter-chip.is-active { background: rgba(59,130,246,0.22); border-color: rgba(96,165,250,0.65); color: #eff6ff; }
    .filter-chip.is-active-b { background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.65); color: #fecaca; }
    .filter-chip.is-active-v { background: rgba(245,158,11,0.18); border-color: rgba(245,158,11,0.65); color: #fde68a; }

    .modal-body { padding: 12px 16px 16px; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 10px; flex: 1; }
    .archive-status-note { font-size: 0.74rem; color: #93c5fd; background: rgba(59,130,246,0.12); border: 1px solid rgba(96,165,250,0.28); border-radius: 10px; padding: 8px 12px; text-align: center; }
    .archive-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; align-items: stretch; }

    /* Одноманітна симетрична картка події з 3 фіксованими регіонами */
    .archive-row { background: rgba(30,41,59,0.62); border: 1px solid rgba(255,255,255,0.08); border-top: 3px solid #64748b; border-radius: 14px; padding: 11px 12px; display: grid; grid-template-rows: auto auto auto; gap: 8px; }
    .archive-row.type-blackout { border-top-color: #ef4444; }
    .archive-row.type-voltage { border-top-color: #f59e0b; }
    .archive-row.is-ongoing { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.42); }
    .archive-row:nth-child(n + 10) { content-visibility: auto; contain-intrinsic-size: auto none auto 138px; }

    .archive-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .archive-when { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; min-width: 0; }
    .archive-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .archive-when .day { color: #cbd5e1; font-weight: 600; }
    .badge-dur { font-size: 0.7rem; font-weight: 700; color: #93c5fd; background: rgba(59,130,246,0.15); border: 1px solid rgba(96,165,250,0.22); padding: 2px 8px; border-radius: 7px; white-space: nowrap; flex-shrink: 0; font-variant-numeric: tabular-nums; }

    .archive-cause-band { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 24px; }
    .badge-cause { font-size: 0.7rem; font-weight: 600; padding: 3px 8px; border-radius: 7px; line-height: 1.25; }
    .badge-live { font-size: 0.65rem; font-weight: 700; color: #fecaca; background: rgba(239,68,68,0.28); padding: 2px 6px; border-radius: 6px; letter-spacing: 0.03em; text-transform: uppercase; }

    .archive-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 8px; }
    .archive-metric-box { background: rgba(15,23,42,0.52); border: 1px solid rgba(255,255,255,0.05); border-radius: 9px; padding: 5px 6px; text-align: center; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
    .am-val { font-size: 0.76rem; font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .am-sub { font-size: 0.63rem; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .modal-foot { padding: 10px 16px 12px; background: rgba(15,23,42,0.97); border-top: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; }
    .modal-foot-note { font-size: 0.7rem; color: var(--text-muted); }
    .btn-close-footer { padding: 7px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.08); color: #fff; font-family: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer; }
    .btn-close-footer:hover { background: rgba(255,255,255,0.14); }

    @media (min-width: 700px) {
      .modal-head { padding: 16px 20px 14px; }
      .modal-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
      .modal-body { padding: 14px 20px 18px; }
      .modal-foot { padding: 11px 20px 13px; }
      .archive-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      @supports (grid-template-rows: subgrid) {
        .archive-row { grid-template-rows: subgrid; grid-row: span 3; }
      }
      .filter-bar { max-width: 420px; }
    }

    @media (min-width: 1060px) {
      .archive-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title-block">
        <h1>ОСББ «Новодарницьке»</h1>
        <p>Резервне живлення будинку • 50 кВт</p>
      </div>
      <div class="live-badge" style="background: ${state.badgeBg}; border-color: ${state.badgeBorder}; color: ${state.badgeColor};">
        <div class="live-dot" style="background: ${state.dotColor}; box-shadow: 0 0 10px ${state.dotColor}; ${!state.isOnline ? 'animation:none;' : ''}"></div> ${state.badgeText}
      </div>
    </div>

    <!-- STATUS BANNER -->
    <div class="card status-banner">
      <div class="status-icon">${state.bannerIcon}</div>
      <div class="status-info">
        <h2 style="color: ${state.bannerIconColor};">${state.bannerTitle}</h2>
        <p>${state.bannerSubtitle}</p>
      </div>
    </div>

    <!-- HERO SECTION -->
    <div class="card" style="text-align:center;">
      <div class="gauge-wrapper">
        <svg class="gauge-svg" viewBox="0 0 180 180">
          <circle class="gauge-bg" cx="90" cy="90" r="80"></circle>
          <circle class="gauge-progress" cx="90" cy="90" r="80"></circle>
        </svg>
        <div class="gauge-text">
          <div><span class="gauge-val">${data.battery_soc ?? '--'}</span><span class="gauge-unit">%</span></div>
          <div class="gauge-sub">${state.gaugeSubtext}</div>
        </div>
      </div>

      <div class="forecast-box">
        ${!isOnline ? `
          <div class="forecast-title" style="color: #f59e0b;">⚠️ ОСТАННІЙ ЗБЕРЕЖЕНИЙ СТАН (${data.device_last_seen || data.updated_at})</div>
          <div class="forecast-main" style="color: #94a3b8;">~${data.est_hours_formatted}</div>
          <div class="forecast-sub">
            Поточний стан може відрізнятися: інвертор тимчасово не надсилає телеметрію в хмару.<br>
            <span style="opacity:0.85; font-size:0.75rem;">Показано останній зафіксований рівень заряду (${data.battery_soc ?? '--'}%).</span>
          </div>
        ` : (data.is_grid_on ? (data.is_charging ? `
          <div class="forecast-title">🔋 ЧАС ДО ПОВНОГО ЗАРЯДУ (100%)</div>
          <div class="forecast-main">~${data.time_to_full_formatted}</div>
          <div class="forecast-sub">
            Повний заряд орієнтовно о <strong>${data.time_to_full_est}</strong>.<br>
            <span style="opacity:0.85">Зараз запасу вистачить на <strong>~${data.est_hours_formatted}</strong> (при 100% — на <strong>~${data.full_est_hours_formatted || data.est_hours_formatted}</strong>).</span>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:4px; opacity:0.85;">*Розраховано за добовим графіком зміни дня і ночі (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} кВт вночі).</div>
          </div>
        ` : `
          <div class="forecast-title">🔋 РЕЗЕРВ АВТОНОМНОСТІ БУДИНКУ</div>
          <div class="forecast-main">~${data.full_est_hours_formatted || data.est_hours_formatted}</div>
          <div class="forecast-sub">
            АКБ повністю заряджено (100%) та готовий до резервного живлення критичних систем будинку (води, опалення, ліфтів та чергового освітлення).
            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px; opacity:0.9;">*Орієнтовна оцінка: від активного дня до повного добового циклу день/ніч (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} вночі) з порогом вимкнення 10%.</div>
          </div>
        `) : `
          <div class="forecast-title">⏳ ЗАЛИШОК АВТОНОМНОСТІ</div>
          <div class="forecast-main">~${data.est_hours_formatted}</div>
          <div class="forecast-sub">
            Орієнтовно <strong>${data.est_time_until}</strong>
            <div style="font-size:0.75rem; margin-top:5px; opacity:0.9;">Повний резерв при 100% АКБ: <strong>~${data.full_est_hours_formatted || data.est_hours_formatted}</strong>.</div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:4px; opacity:0.85;">*Оцінка враховує зміну споживання день/ніч (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} вночі) та поріг вимкнення 10%.</div>
          </div>
        `)}
      </div>
    </div>

    <!-- METRICS GRID -->
    <div class="grid">
      ${data.is_grid_on ? `
        ${data.is_charging ? `
          <div class="metric">
            <div class="metric-label">Потужність заряду АКБ</div>
            <div class="metric-val" style="color:#10b981;">+${data.charge_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Швидкість: ~${data.charge_rate_pct}% / год</div>
          </div>
          <div class="metric">
            <div class="metric-label">Споживання будинку</div>
            <div class="metric-val">${data.use_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Живиться від мережі</div>
          </div>
          <div class="metric">
            <div class="metric-label">Споживання з мережі</div>
            <div class="metric-val">${data.grid_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Будинок + зарядка АКБ</div>
          </div>
          <div class="metric">
            <div class="metric-label">Напруга АКБ</div>
            <div class="metric-val" style="color:#10b981;">${data.battery_voltage.toFixed(1)} <small style="font-size:0.7rem">В</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Йде активний заряд</div>
          </div>
        ` : `
          <div class="metric">
            <div class="metric-label">Споживання будинку</div>
            <div class="metric-val">${data.use_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Живиться від міської мережі</div>
          </div>
          <div class="metric">
            <div class="metric-label">Напруга АКБ</div>
            <div class="metric-val" style="color:#10b981;">${data.battery_voltage.toFixed(1)} <small style="font-size:0.7rem">В</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Буферний режим (100%)</div>
          </div>
          <div class="metric">
            <div class="metric-label">Витрачено за 24 год</div>
            <div class="metric-val">${data.discharge_24h_kwh || data.today_discharge_kwh} <small style="font-size:0.7rem">кВт·год</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Сумарний розряд за добу</div>
          </div>
          <div class="metric">
            <div class="metric-label">Ємність батареї</div>
            <div class="metric-val">~65 <small style="font-size:0.7rem">кВт·год</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Високовольтний блок</div>
          </div>
        `}
      ` : `
        <div class="metric">
          <div class="metric-label">Поточне навантаження</div>
          <div class="metric-val" style="color:#ef4444;">${data.use_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Живиться від батареї</div>
        </div>
        <div class="metric">
          <div class="metric-label">Витрачено за 24 год</div>
          <div class="metric-val">${data.discharge_24h_kwh || data.today_discharge_kwh} <small style="font-size:0.7rem">кВт·год</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Сумарний розряд</div>
        </div>
        <div class="metric">
          <div class="metric-label">Ємність батареї</div>
          <div class="metric-val">~65 <small style="font-size:0.7rem">кВт·год</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Високовольтний блок</div>
        </div>
        <div class="metric">
          <div class="metric-label">Темп розряду</div>
          <div class="metric-val" style="color:#f59e0b;">~${data.discharge_rate_pct} <small style="font-size:0.7rem">%/год</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">${data.discharge_rate_subtext || "Поточна швидкість"}</div>
        </div>
      `}
    </div>

    ${buildVoltageBarHTML(data.grid_voltages, data.load_voltages, data.is_grid_on)}

    <!-- OUTAGES STATS & CHARTS SECTION -->
    <div style="margin-top:10px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding:0 2px;">
        <div style="font-size:0.92rem; font-weight:700; color:var(--text-main);">
          📊 Журнал подій живлення
        </div>
        <div style="font-size:0.72rem; color:var(--text-muted);">
          На АКБ (24 год): <strong>${journal.totalHours24hFormatted || journal.totalHoursFormatted || '0 хв'}</strong>
        </div>
      </div>

      <!-- Перемикач журналу: Блекаути ДТЕК (за замовч.) vs Захист від напруги -->
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
        <button id="tab-blackout" type="button" onclick="selectJournalTab('blackout')" aria-pressed="true" class="journal-tab" style="background:rgba(239,68,68,0.12); border:1.5px solid rgba(239,68,68,0.65); box-shadow:0 0 0 1px rgba(239,68,68,0.2);">
          <div class="journal-tab-head">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:1rem;">🔴</span>
              <strong style="font-size:0.82rem; color:var(--text-main);">Блекаути ДТЕК</strong>
            </div>
            <span id="dot-blackout" class="journal-tab-dot" style="background:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,0.25);"></span>
          </div>
          <div style="font-size:1rem; font-weight:700; color:#f87171; margin-top:4px;">
            ${journal.blackoutCount24h || 0} <small style="font-size:0.68rem; font-weight:500; color:var(--text-muted);">(за 24 год)</small>
          </div>
          <div class="journal-tab-foot">
            <span>За тиждень: <strong>${journal.blackoutCountTotal || 0}</strong></span>
            <span id="state-blackout" style="color:#fca5a5; font-weight:600;">Показано ▾</span>
          </div>
        </button>

        <button id="tab-voltage" type="button" onclick="selectJournalTab('voltage')" aria-pressed="false" class="journal-tab" style="background:rgba(15,23,42,0.55); border:1px solid rgba(245,158,11,0.25);">
          <div class="journal-tab-head">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:1rem;">⚡</span>
              <strong style="font-size:0.82rem; color:var(--text-main);">Захист напруги</strong>
            </div>
            <span id="dot-voltage" class="journal-tab-dot"></span>
          </div>
          <div style="font-size:1rem; font-weight:700; color:#f59e0b; margin-top:4px;">
            ${journal.voltageSagCount24h || 0} <small style="font-size:0.68rem; font-weight:500; color:var(--text-muted);">(за 24 год)</small>
          </div>
          <div class="journal-tab-foot">
            <span>За тиждень: <strong>${journal.voltageSagCountTotal || 0}</strong></span>
            <span id="state-voltage" style="color:var(--text-muted);">Графіки ▸</span>
          </div>
        </button>
      </div>

      <!-- Кнопка відкриття повного списку подій за останній місяць (30 днів) -->
      <button id="open-archive-btn" type="button" class="archive-trigger-btn" command="show-modal" commandfor="monthlyEventsDialog" onclick="loadMonthlyArchive()">
        <span class="archive-trigger-left">
          <span style="font-size:1.05rem;">📅</span>
          <span>
            Всі події за місяць (30 днів)
            <span class="archive-trigger-sub">Блекаути ДТЕК та захисти напруги списком</span>
          </span>
        </span>
        <span id="archive-btn-pill" class="archive-pill">Список ▸</span>
      </button>
    </div>

    ${ongoingChart ? renderOutageCardHTML(ongoingChart, 'outageGrad_ongoing') : ''}

    <div id="panel-blackout" class="journal-panel">
      ${blackoutCharts.length === 0 ? `
        <div class="card" style="text-align:center; padding:24px 16px;">
          <div style="font-size:1.8rem; margin-bottom:6px;">🟢</div>
          <div style="font-size:0.92rem; font-weight:700; color:var(--text-main);">Зафіксованих відключень ДТЕК поки немає</div>
          <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">За останній тиждень тривалих блекаутів ДТЕК не було.</div>
        </div>
      ` : blackoutCharts.map((outage, idx) => renderOutageCardHTML(outage, `outageGrad_b_${idx}`)).join('')}
    </div>

    <div id="panel-voltage" class="journal-panel is-hidden">
      ${voltageCharts.length === 0 ? `
        <div class="card" style="text-align:center; padding:24px 16px;">
          <div style="font-size:1.8rem; margin-bottom:6px;">🟢</div>
          <div style="font-size:0.92rem; font-weight:700; color:var(--text-main);">Спрацювань захисту по напрузі поки немає</div>
          <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">Напруга міської мережі трималась у межах норми (195–255 В).</div>
        </div>
      ` : voltageCharts.map((outage, idx) => renderOutageCardHTML(outage, `outageGrad_v_${idx}`)).join('')}
    </div>

    <div class="tip-box" style="background: ${state.tipBg}; border-color: ${state.tipBorder}; color: ${state.tipColor};">
      <div>${state.tipIcon}</div>
      <div>
        ${state.tipHtml}
      </div>
    </div>

    <div class="footer">
      <div>
        ${isOnline 
          ? `Останнє оновлення: <strong>${data.updated_at}</strong>` 
          : `Останні дані від інвертора: <strong style="color:#f87171;">${data.device_last_seen || data.updated_at}</strong>`}
      </div>
      <div style="font-size:0.68rem; opacity:0.65; margin: 3px 0 6px;">
        ${isOnline ? 'Автооновлення кожні 5 хв' : 'Опитування хмари кожні 5 хв (очікування сигналу від інвертора)'}
      </div>
      <button class="btn" onclick="location.reload()">🔄 Оновити дані</button>
      <div style="margin-top:6px; font-size:0.68rem; opacity:0.55;">ОСББ «Новодарницьке» • Моніторинг 24/7</div>
      <div style="font-size:0.58rem; opacity:0.35; margin-top:3px; letter-spacing:0.5px;"><span title="Версія системи">v${data.version || '1.2.0'}</span></div>
    </div>
  </div>

  <!-- МОДАЛЬНЕ ВІКНО: СПИСОК ПОДІЙ ЗА 30 ДНІВ -->
  <dialog id="monthlyEventsDialog" class="archive-modal" closedby="any" aria-labelledby="monthlyDialogTitle">
    <div class="modal-head">
      <div class="modal-title-row">
        <div>
          <h2 id="monthlyDialogTitle" class="modal-title">📅 Архів подій за 30 днів</h2>
          <div id="archivePeriodSubtitle" class="modal-subtitle">Завантаження даних за останній місяць...</div>
        </div>
        <button type="button" class="modal-close-x" command="close" commandfor="monthlyEventsDialog" aria-label="Закрити вікно">✕</button>
      </div>

      <div class="modal-kpis">
        <div class="modal-kpi">
          <div id="archive-kpi-blackout" class="modal-kpi-val" style="color:#f87171;">—</div>
          <div id="archive-kpi-blackout-sub" class="modal-kpi-sub">—</div>
          <div class="modal-kpi-lbl">🔴 Блекаути ДТЕК</div>
        </div>
        <div class="modal-kpi">
          <div id="archive-kpi-voltage" class="modal-kpi-val" style="color:#f59e0b;">—</div>
          <div id="archive-kpi-voltage-sub" class="modal-kpi-sub">—</div>
          <div class="modal-kpi-lbl">⚡ Захист напруги</div>
        </div>
        <div class="modal-kpi">
          <div id="archive-kpi-avg" class="modal-kpi-val" style="color:#60a5fa;">—</div>
          <div class="modal-kpi-sub">середня потужність</div>
          <div class="modal-kpi-lbl">📊 Навант. при ДТЕК</div>
        </div>
        <div class="modal-kpi">
          <div id="archive-kpi-extremum" class="modal-kpi-val" style="color:#34d399;">—</div>
          <div id="archive-kpi-extremum-sub" class="modal-kpi-sub">—</div>
          <div class="modal-kpi-lbl">🔋 Мін. АКБ • пік</div>
        </div>
      </div>

      <div class="filter-bar" role="group" aria-label="Фільтр подій за типом">
        <button type="button" id="archive-filter-all" class="filter-chip is-active" data-filter="all" onclick="setArchiveFilter('all')">Усі</button>
        <button type="button" id="archive-filter-blackout" class="filter-chip" data-filter="blackout" onclick="setArchiveFilter('blackout')">🔴 ДТЕК</button>
        <button type="button" id="archive-filter-voltage" class="filter-chip" data-filter="voltage" onclick="setArchiveFilter('voltage')">⚡ Напруга</button>
      </div>
    </div>

    <div class="modal-body" id="archiveListBody">
      <div class="archive-status-note">⏳ Завантаження історії подій...</div>
    </div>

    <div class="modal-foot">
      <div class="modal-foot-note">Натисніть поза вікном або Esc, щоб закрити</div>
      <form method="dialog">
        <button type="submit" class="btn-close-footer" autofocus>Закрити</button>
      </form>
    </div>
  </dialog>

  <script>
    function selectJournalTab(tab) {
      const isB = (tab === 'blackout');
      const tabB = document.getElementById('tab-blackout');
      const tabV = document.getElementById('tab-voltage');
      const panelB = document.getElementById('panel-blackout');
      const panelV = document.getElementById('panel-voltage');
      if (!tabB || !tabV || !panelB || !panelV) return;

      tabB.setAttribute('aria-pressed', isB ? 'true' : 'false');
      tabV.setAttribute('aria-pressed', !isB ? 'true' : 'false');

      tabB.style.background = isB ? 'rgba(239,68,68,0.12)' : 'rgba(15,23,42,0.55)';
      tabB.style.border = isB ? '1.5px solid rgba(239,68,68,0.65)' : '1px solid rgba(239,68,68,0.22)';
      tabB.style.boxShadow = isB ? '0 0 0 1px rgba(239,68,68,0.2)' : 'none';
      document.getElementById('dot-blackout').style.background = isB ? '#ef4444' : '#475569';
      document.getElementById('dot-blackout').style.boxShadow = isB ? '0 0 0 3px rgba(239,68,68,0.25)' : 'none';
      const stB = document.getElementById('state-blackout');
      stB.textContent = isB ? 'Показано ▾' : 'Графіки ▸';
      stB.style.color = isB ? '#fca5a5' : 'var(--text-muted)';
      stB.style.fontWeight = isB ? '600' : '400';

      tabV.style.background = !isB ? 'rgba(245,158,11,0.12)' : 'rgba(15,23,42,0.55)';
      tabV.style.border = !isB ? '1.5px solid rgba(245,158,11,0.65)' : '1px solid rgba(245,158,11,0.22)';
      tabV.style.boxShadow = !isB ? '0 0 0 1px rgba(245,158,11,0.2)' : 'none';
      document.getElementById('dot-voltage').style.background = !isB ? '#f59e0b' : '#475569';
      document.getElementById('dot-voltage').style.boxShadow = !isB ? '0 0 0 3px rgba(245,158,11,0.25)' : 'none';
      const stV = document.getElementById('state-voltage');
      stV.textContent = !isB ? 'Показано ▾' : 'Графіки ▸';
      stV.style.color = !isB ? '#fcd34d' : 'var(--text-muted)';
      stV.style.fontWeight = !isB ? '600' : '400';

      panelB.classList.toggle('is-hidden', !isB);
      panelV.classList.toggle('is-hidden', isB);
    }

    let archiveState = null;
    let archiveLoadedAt = 0;
    const ARCHIVE_CLIENT_TTL_MS = 120000;
    let archiveFilter = 'all';
    let archiveLoadPromise = null;

    function escHtml(val) {
      return String(val ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function fmtShortDate(iso) {
      if (!iso || typeof iso !== 'string') return '';
      const p = iso.split('-');
      return p.length === 3 ? (p[2] + '.' + p[1]) : iso;
    }

    function renderArchiveCardMarkup(ev) {
      const isBlackout = (ev.eventType === 'BLACKOUT');
      const cardClass = 'archive-row ' + (isBlackout ? 'type-blackout' : 'type-voltage') + (ev.isOngoing ? ' is-ongoing' : '');
      const dotColor = ev.isOngoing ? '#ef4444' : (isBlackout ? '#ef4444' : '#f59e0b');
      const dayPrefix = ev.dayLabel ? '<span class="day">' + escHtml(ev.dayLabel) + ',</span>' : '';
      const timeText = ev.isOngoing ? ('з ' + escHtml(ev.start)) : (escHtml(ev.start) + ' — ' + escHtml(ev.end));
      const badgeStyle = 'color:' + escHtml(ev.eventBadgeColor || (isBlackout ? '#fca5a5' : '#fcd34d')) + '; background:' + escHtml(ev.eventBadgeBg || 'rgba(245,158,11,0.15)') + ';';
      const socMain = (ev.socDrain > 0) ? (ev.startSoc + '% ➔ ' + ev.minSoc + '%') : ((ev.startSoc ?? 100) + '%');
      const socSub = (ev.socDrain > 0) ? ('-' + ev.socDrain + '% АКБ') : '0% розряду';

      return (
        '<article class="' + cardClass + '">' +
          '<header class="archive-row-head">' +
            '<div class="archive-when">' +
              '<span class="archive-dot" style="background:' + dotColor + ';"></span>' +
              dayPrefix +
              '<span>' + timeText + '</span>' +
            '</div>' +
            '<span class="badge-dur">⏳ ' + escHtml(ev.durStr) + '</span>' +
          '</header>' +
          '<div class="archive-cause-band">' +
            '<span class="badge-cause" style="' + badgeStyle + '">' + escHtml(ev.eventLabel) + '</span>' +
            (ev.isOngoing ? '<span class="badge-live">● Зараз</span>' : '') +
          '</div>' +
          '<footer class="archive-metrics">' +
            '<div class="archive-metric-box">' +
              '<div class="am-val" style="color:#60a5fa;">' + escHtml(ev.avgKw) + ' кВт</div>' +
              '<div class="am-sub">пік ' + escHtml(ev.peakKw) + ' кВт</div>' +
            '</div>' +
            '<div class="archive-metric-box">' +
              '<div class="am-val" style="color:#f59e0b;">' + escHtml(ev.energyKwh) + ' кВт·год</div>' +
              '<div class="am-sub">витрата АКБ</div>' +
            '</div>' +
            '<div class="archive-metric-box">' +
              '<div class="am-val" style="color:#34d399;">' + escHtml(socMain) + '</div>' +
              '<div class="am-sub">' + escHtml(socSub) + '</div>' +
            '</div>' +
          '</footer>' +
        '</article>'
      );
    }

    function renderArchiveDialog() {
      if (!archiveState) return;
      const period = archiveState.period || {};
      const summary = archiveState.summary || {};
      const events = Array.isArray(archiveState.events) ? archiveState.events : [];

      const subEl = document.getElementById('archivePeriodSubtitle');
      if (subEl) {
        const range = period.fromDateStr && period.toDateStr
          ? (fmtShortDate(period.fromDateStr) + ' — ' + fmtShortDate(period.toDateStr))
          : 'Останні 30 днів';
        subEl.textContent = range + ' • Завантажено ' + (period.daysAvailable || 0) + ' дн.';
      }

      const kpiB = document.getElementById('archive-kpi-blackout');
      const kpiBSub = document.getElementById('archive-kpi-blackout-sub');
      const kpiV = document.getElementById('archive-kpi-voltage');
      const kpiVSub = document.getElementById('archive-kpi-voltage-sub');
      const kpiAvg = document.getElementById('archive-kpi-avg');
      const kpiExt = document.getElementById('archive-kpi-extremum');
      const kpiExtSub = document.getElementById('archive-kpi-extremum-sub');
      if (kpiB) kpiB.textContent = String(summary.blackoutCount || 0);
      if (kpiBSub) kpiBSub.textContent = summary.blackoutTotalFormatted || '0 хв';
      if (kpiV) kpiV.textContent = String(summary.voltageCount || 0);
      if (kpiVSub) kpiVSub.textContent = summary.voltageTotalFormatted || '0 хв';
      if (kpiAvg) kpiAvg.textContent = (summary.avgBlackoutKw || '0.0') + ' кВт';
      if (kpiExt) kpiExt.textContent = (summary.minSoc ?? 100) + '% АКБ';
      if (kpiExtSub) kpiExtSub.textContent = 'пік ' + (summary.maxPeakKw || '0.0') + ' кВт';

      const pill = document.getElementById('archive-btn-pill');
      if (pill && typeof summary.totalEvents === 'number') {
        pill.textContent = summary.totalEvents + ' подій ▸';
      }

      const fAll = document.getElementById('archive-filter-all');
      const fB = document.getElementById('archive-filter-blackout');
      const fV = document.getElementById('archive-filter-voltage');
      if (fAll) fAll.textContent = 'Усі (' + (summary.totalEvents || 0) + ')';
      if (fB) fB.textContent = '🔴 ДТЕК (' + (summary.blackoutCount || 0) + ')';
      if (fV) fV.textContent = '⚡ Напруга (' + (summary.voltageCount || 0) + ')';

      const filtered = archiveFilter === 'all'
        ? events
        : events.filter(ev => archiveFilter === 'blackout' ? ev.eventType === 'BLACKOUT' : ev.eventType !== 'BLACKOUT');

      const body = document.getElementById('archiveListBody');
      if (!body) return;

      const statusBanner = period.isPartial
        ? '<div class="archive-status-note">⏳ Дозавантажуємо архів з хмари Deye (залишилось ' + (period.remainingDays || 0) + ' дн.)...</div>'
        : '';

      if (filtered.length === 0) {
        body.innerHTML = statusBanner + '<div style="text-align:center; padding:24px 12px; color:var(--text-muted); font-size:0.82rem;">🟢 За вибраним фільтром подій не зафіксовано.</div>';
        return;
      }

      body.innerHTML = statusBanner + '<div class="archive-grid">' + filtered.map(renderArchiveCardMarkup).join('') + '</div>';
    }

    function setArchiveFilter(filter) {
      archiveFilter = filter;
      document.querySelectorAll('.filter-chip').forEach(btn => {
        btn.classList.remove('is-active', 'is-active-b', 'is-active-v');
        if (btn.getAttribute('data-filter') === filter) {
          btn.classList.add(filter === 'blackout' ? 'is-active-b' : filter === 'voltage' ? 'is-active-v' : 'is-active');
        }
      });
      renderArchiveDialog();
    }

    async function fetchArchivePass(depth) {
      const resp = await fetch('/api/archive');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const nextData = await resp.json();
      const prevDays = archiveState && archiveState.period ? (archiveState.period.daysAvailable || 0) : -1;
      archiveState = nextData;
      archiveLoadedAt = Date.now();
      renderArchiveDialog();
      const nextDays = nextData && nextData.period ? (nextData.period.daysAvailable || 0) : 0;
      if (nextData && nextData.period && nextData.period.isPartial && depth < 3 && nextDays > prevDays) {
        await fetchArchivePass(depth + 1);
      }
    }

    function loadMonthlyArchive() {
      const isFresh = Boolean(
        archiveState &&
        !(archiveState.period && archiveState.period.isPartial) &&
        (Date.now() - archiveLoadedAt < ARCHIVE_CLIENT_TTL_MS)
      );
      if (archiveState) {
        renderArchiveDialog();
        if (isFresh) return;
      }
      if (!archiveLoadPromise) {
        archiveLoadPromise = fetchArchivePass(0).catch(() => {
          const body = document.getElementById('archiveListBody');
          if (body && !archiveState) {
            body.innerHTML = '<div style="text-align:center; padding:24px 12px; color:#fca5a5; font-size:0.82rem;">⚠️ Не вдалося завантажити архів подій. Спробуйте ще раз.</div>';
          }
        }).finally(() => {
          archiveLoadPromise = null;
        });
      }
    }

    // Progressive enhancement fallbacks (Invoker Commands + Dialog closedby)
    (function initArchiveDialogEnhancements() {
      const modal = document.getElementById('monthlyEventsDialog');
      if (!modal) return;
      if (!('commandForElement' in HTMLButtonElement.prototype)) {
        document.querySelectorAll('button[commandfor="monthlyEventsDialog"]').forEach(btn => {
          btn.addEventListener('click', () => {
            if (btn.getAttribute('command') === 'close') {
              if (modal.open) modal.close();
            } else if (!modal.open && typeof modal.showModal === 'function') {
              modal.showModal();
            }
          });
        });
      }
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        const outside = (e, d) => {
          const r = d.getBoundingClientRect();
          return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        let pressedOutside = false;
        modal.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, modal); });
        modal.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, modal)) modal.close(); });
      }
    })();

    setTimeout(() => location.reload(), 300000);
  </script>
</body>
</html>`;
}
