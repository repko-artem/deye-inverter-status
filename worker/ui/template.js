/**
 * Генератор HTML-сторінки моніторингу статусу ОСББ "Новодарницьке".
 * Ізольований презентаційний шар (UI / View).
 */

export function renderHTML(data) {
  const soc = data.battery_soc;
  const strokeColor = data.is_charging ? '#10b981' : (soc > 50 ? '#3b82f6' : (soc > 25 ? '#f59e0b' : '#ef4444'));
  const offset = 502 - (soc / 100) * 502;
  const outages = data.outages || [];
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
    
    .status-banner { display: flex; align-items: center; gap: 14px; border-left: 5px solid ${data.is_grid_on ? 'var(--success)' : 'var(--danger)'}; }
    .status-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; background: ${data.is_grid_on ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${data.is_grid_on ? 'var(--success)' : 'var(--danger)'}; flex-shrink: 0; }
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
    .forecast-main { font-size: 1.45rem; font-weight: 800; color: ${data.is_charging ? '#34d399' : '#60a5fa'}; }
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

    .event-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(15,23,42,0.4); border-radius: 10px; font-size: 0.78rem; margin-bottom: 6px; }
    .event-left { display: flex; align-items: center; gap: 8px; }
    .event-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; }
    .event-right { text-align: right; color: var(--text-muted); font-size: 0.72rem; }

    .tip-box { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); border-radius: 16px; padding: 12px; display: flex; gap: 10px; font-size: 0.8rem; color: #fef3c7; }
    .footer { text-align: center; font-size: 0.75rem; color: var(--text-muted); padding: 12px 0; }
    .btn { background: rgba(255,255,255,0.08); border: 1px solid var(--card-border); color: #fff; padding: 7px 14px; border-radius: 10px; cursor: pointer; font-weight: 600; margin-top: 6px; font-size: 0.75rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title-block">
        <h1>ОСББ «Новодарницьке»</h1>
        <p>Резервне живлення будинку • 50 кВт</p>
      </div>
      <div class="live-badge"><div class="live-dot"></div> LIVE</div>
    </div>

    <!-- STATUS BANNER -->
    <div class="card status-banner">
      <div class="status-icon">${data.is_charging ? '⚡' : (data.is_grid_on ? '🟢' : '🔴')}</div>
      <div class="status-info">
        <h2>
          ${data.is_charging ? 'Міська мережа активна • Заряд АКБ' : (data.is_grid_on ? 'Міська мережа активна' : `Відключення світла ${outageStartStr}`.trim())}
        </h2>
        <p>
          ${data.is_charging 
            ? `Потужність заряджання: +${data.charge_power_kw.toFixed(1)} кВт (напруга: ${data.battery_voltage} В)` 
            : (data.is_grid_on 
              ? 'Батарея в режимі очікування (100% готовність)' 
              : `${outageDurStr ? `Триває ${outageDurStr} • ` : ''}Старт із ${currOutage ? currOutage.startSoc : soc}%`)}
        </p>
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
          <div><span class="gauge-val">${data.battery_soc}</span><span class="gauge-unit">%</span></div>
          <div class="gauge-sub">${data.is_charging ? '⚡ Заряджання' : (data.is_grid_on ? '🟢 Готовність' : '🔴 Розряд АКБ')}</div>
        </div>
      </div>

      <div class="forecast-box">
        ${data.is_grid_on ? (data.is_charging ? `
          <div class="forecast-title">🔋 ЧАС ДО ПОВНОГО ЗАРЯДУ (100%)</div>
          <div class="forecast-main">~${data.time_to_full_formatted}</div>
          <div class="forecast-sub">
            Повний заряд орієнтовно о <strong>${data.time_to_full_est}</strong>.<br>
            <span style="opacity:0.85">Поточного резерву вже вистачить на <strong>~${data.est_hours_formatted}</strong> автономії.</span>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:4px; opacity:0.85;">*Розраховано за добовим графіком зміни дня і ночі (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} кВт вночі).</div>
          </div>
        ` : `
          <div class="forecast-title">🔋 РЕЗЕРВ АВТОНОМНОСТІ БУДИНКУ</div>
          <div class="forecast-main">~${data.est_hours_formatted}</div>
          <div class="forecast-sub">
            АКБ повністю заряджено (100%) та готовий до резервного живлення критичних систем будинку (води, опалення, ліфтів та чергового освітлення).
            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px; opacity:0.9;">*Орієнтовна оцінка: від активного дня до повного добового циклу день/ніч (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} вночі) та буфером 15%.</div>
          </div>
        `) : `
          <div class="forecast-title">⏳ ПРОГНОЗ АВТОНОМНОСТІ БУДИНКУ</div>
          <div class="forecast-main">~${data.est_hours_formatted}</div>
          <div class="forecast-sub">
            Орієнтовно <strong>${data.est_time_until}</strong>
            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px; opacity:0.9;">*Орієнтовна оцінка: від активного дня до повного добового циклу день/ніч (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} вночі) та буфером 15%.</div>
          </div>
        `}
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

    <!-- OUTAGES STATS & CHARTS SECTION -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; padding:0 2px;">
      <div style="font-size:0.9rem; font-weight:700; color:var(--text-main);">
        📊 Останні відключення (до 3)
      </div>
      <div style="font-size:0.72rem; color:var(--text-muted);">
        Всього на АКБ (24 год): <strong>${journal.totalHours24hFormatted || journal.totalHoursFormatted || '0 хв'}</strong>
      </div>
    </div>

    ${outages.length === 0 ? `
      <div class="card" style="text-align:center; padding:24px 16px;">
        <div style="font-size:1.8rem; margin-bottom:6px;">🟢</div>
        <div style="font-size:0.92rem; font-weight:700; color:var(--text-main);">Зафіксованих відключень поки немає</div>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">Будинок безперервно живиться від міської електромережі.</div>
      </div>
    ` : outages.map((outage, idx) => `
      <div class="card">
        <!-- Outage Title & Duration -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="width:9px; height:9px; border-radius:50%; background:${outage.isOngoing ? '#ef4444' : '#64748b'}; box-shadow:${outage.isOngoing ? '0 0 8px #ef4444' : 'none'};"></span>
            <strong style="font-size:0.88rem; color:var(--text-main);">
              ${outage.isOngoing ? `Триває зараз: ${outage.dayLabel && outage.dayLabel !== 'Сьогодні' ? `<span style="color:#94a3b8; font-weight:500;">${outage.dayLabel},</span> ` : ''}з ${outage.start}` : `Відключення: ${outage.dayLabel ? `<span style="color:#94a3b8; font-weight:500;">${outage.dayLabel},</span> ` : ''}${outage.start} — ${outage.end}`}
            </strong>
          </div>
          <div style="font-size:0.72rem; color:#60a5fa; font-weight:700; background:rgba(59,130,246,0.12); padding:3px 8px; border-radius:8px;">
            ⏳ ${outage.durStr}
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
              <linearGradient id="outageGrad_${idx}" x1="0" y1="0" x2="0" y2="1">
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
            <path d="${outage.areaD}" fill="url(#outageGrad_${idx})" />

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
      </div>
    `).join('')}

    <div class="tip-box">
      <div>💡</div>
      <div>
        ${data.is_grid_on ? (data.is_charging ? `
          <strong>Статус:</strong> Міська мережа активна. Акумулятор заряджається високою потужністю, щоб бути готовим до можливих відключень.
        ` : `
          <strong>Статус:</strong> Міська мережа активна. Акумулятор повністю заряджений (100%) та готовий до захисту критичної інфраструктури.
        `) : `
          <strong>Порада для мешканців:</strong> Будинок перейшов на резервне живлення від батареї (працюють насоси води, опалення, ліфти та чергове освітлення). Якщо є можливість піднятися сходами на свій поверх — це суттєво заощаджує заряд для безперебійного водопостачання та тепла для всього будинку!
        `}
      </div>
    </div>

    <div class="footer">
      <div>Останнє оновлення: <strong>${data.updated_at}</strong></div>
      <div style="font-size:0.68rem; opacity:0.65; margin: 3px 0 6px;">Автооновлення кожні 60 сек</div>
      <button class="btn" onclick="location.reload()">🔄 Оновити дані</button>
      <div style="margin-top:6px; opacity:0.6;">ОСББ «Новодарницьке» • Моніторинг 24/7</div>
    </div>
  </div>
  <script>
    setTimeout(() => location.reload(), 60000);
  </script>
</body>
</html>`;
}
