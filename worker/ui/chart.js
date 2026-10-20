import { CONFIG } from '../config.js';

/**
 * Побудова SVG графіка споживання та рівня заряду АКБ для події відключення.
 */
export function buildOutageChart(e, records, eventNumber, config = CONFIG) {
  const kyivOffsetSec = config.TIME.KYIV_OFFSET_SEC;
  const startIdx = Math.max(0, e.startIndex);
  const endIdx = Math.min(records.length - 1, e.endIndex ?? (records.length - 1));
  const rawSlice = records.slice(startIdx, endIdx + 1);
  if (!rawSlice || rawSlice.length === 0) return null;

  const points = rawSlice.map(r => {
    const d = new Date((r.dateTime + kyivOffsetSec) * 1000);
    const time = d.toISOString().substring(11, 16);
    const useKw = Math.max(0, (r.usePower || 0) / 1000.0);
    const soc = Math.round(r.batterySoc || 75);
    return { time, useKw, soc };
  });

  const avgKwVal = points.reduce((sum, p) => sum + p.useKw, 0) / points.length;
  const avgKw = avgKwVal.toFixed(1);

  let peakPoint = points[0];
  for (const p of points) {
    if (p.useKw > peakPoint.useKw) peakPoint = p;
  }
  const peakKw = peakPoint.useKw.toFixed(1);

  // SVG Chart: ViewBox 0 0 520 175
  const xStart = 35, xEnd = 505, yTop = 22, yBottom = 145;
  const maxKw = Math.max(8, Math.ceil(peakPoint.useKw * 1.15));

  const getX = (i) => points.length <= 1 
    ? Math.round((xStart + xEnd) / 2) 
    : Math.round(xStart + (i / (points.length - 1)) * (xEnd - xStart));

  const getYPower = (kw) => Math.round(yBottom - (kw / maxKw) * (yBottom - yTop));

  // Шкала SOC для цього відключення: розтягуємо між minSoc-4 і maxSoc+2 для контрастності
  const minSoc = Math.min(...points.map(p => p.soc));
  const maxSoc = Math.max(...points.map(p => p.soc));
  const socRange = Math.max(10, maxSoc - minSoc + 4);
  const getYSoc = (soc) => Math.round(yTop + 6 + ((maxSoc - soc) / socRange) * (yBottom - yTop - 12));

  let pathD = `M ${getX(0)} ${getYPower(points[0].useKw)}`;
  let areaD = `M ${getX(0)} ${yBottom} L ${getX(0)} ${getYPower(points[0].useKw)}`;
  let socD = `M ${getX(0)} ${getYSoc(points[0].soc)}`;

  for (let i = 1; i < points.length; i++) {
    const x = getX(i);
    const yP = getYPower(points[i].useKw);
    const yS = getYSoc(points[i].soc);
    pathD += ` L ${x} ${yP}`;
    areaD += ` L ${x} ${yP}`;
    socD += ` L ${x} ${yS}`;
  }
  areaD += ` L ${getX(points.length - 1)} ${yBottom} Z`;

  // Координати піка
  const peakIdx = points.indexOf(peakPoint);
  const peakX = getX(peakIdx);
  const peakY = getYPower(peakPoint.useKw);

  // Лінія середнього споживання
  const yAvg = getYPower(avgKwVal);

  // Часові мітки осі X (до 5 рівновіддалених)
  const numLabels = Math.min(5, points.length);
  const labelIndices = [];
  for (let k = 0; k < numLabels; k++) {
    const idx = Math.min(points.length - 1, Math.round((k / (numLabels - 1 || 1)) * (points.length - 1)));
    if (!labelIndices.includes(idx)) labelIndices.push(idx);
  }

  const labelsSvg = labelIndices.map(idx => {
    const p = points[idx];
    const isFirst = (idx === 0);
    const isLast = (idx === points.length - 1);
    const anchor = isFirst ? 'start' : (isLast ? 'end' : 'middle');
    const xPos = isFirst ? xStart : (isLast ? xEnd : getX(idx));
    return `<text x="${xPos}" y="162" fill="#94a3b8" font-size="8.5" text-anchor="${anchor}">${p.time}</text>`;
  }).join('');

  const durStr = e.durationMin >= 60 
    ? `${Math.floor(e.durationMin / 60)} год ${e.durationMin % 60} хв` 
    : `${e.durationMin} хв`;

  const energyKwh = (rawSlice.reduce((sum, r) => {
    const dis = Math.max(0, (r.dischargePower || r.batteryPower || r.usePower || 0));
    return sum + (dis / 1000.0) * (5 / 60.0);
  }, 0)).toFixed(1);

  return {
    eventNum: eventNumber,
    isOngoing: e.isOngoing || false,
    dayLabel: e.dayLabel || "",
    start: e.start,
    end: e.end,
    durStr,
    durationMin: e.durationMin,
    startSoc: e.startSoc,
    minSoc: e.minSoc,
    socDrain: Math.max(0, e.startSoc - e.minSoc),
    energyKwh,
    avgKw,
    peakKw,
    peakTime: peakPoint.time,
    peakX,
    peakY,
    yAvg,
    maxKw,
    midKw: Math.round(maxKw / 2),
    pathD,
    areaD,
    socD,
    labelsSvg
  };
}
