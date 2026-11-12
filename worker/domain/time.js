/**
 * Централізований модуль роботи з часом та часовим поясом Києва (Europe/Kyiv).
 * Втілює Clean Time Architecture:
 * 1. Усі таймстемпи (TimestampSec, TimestampMs, epochSec) зберігаються та обчислюються ВИКЛЮЧНО в чистому UTC.
 * 2. Часовий пояс Europe/Kyiv застосовується ТІЛЬКИ на етапі відображення або вибірки локальної години/дати.
 * 3. Нативне Intl API автоматично враховує перехід на літній/зимовий час (DST).
 */

import { getKyivOffsetSec } from '../config.js';

export const KYIV_TIMEZONE = 'Europe/Kyiv';

const kyivTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: KYIV_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const kyivDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const kyivHourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: KYIV_TIMEZONE,
  hour: 'numeric',
  hour12: false
});

/**
 * Поточний системний час в чистих UTC секундах.
 * @returns {number}
 */
export function nowUtcSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Поточний системний час в чистих UTC мілісекундах.
 * @returns {number}
 */
export function nowUtcMs() {
  return Date.now();
}

/**
 * Перетворення UTC епох-секунд у київський час "HH:mm".
 * @param {number|Date} epochSec
 * @returns {string} e.g. "21:25"
 */
export function formatKyivTime(epochSec) {
  if (epochSec == null || Number.isNaN(Number(epochSec))) return '--:--';
  const d = typeof epochSec === 'number' ? new Date(epochSec * 1000) : epochSec;
  return kyivTimeFormatter.format(d);
}

/**
 * Перетворення UTC епох-секунд у київську дату "YYYY-MM-DD".
 * @param {number|Date} epochSec
 * @returns {string} e.g. "2026-11-11"
 */
export function formatKyivDate(epochSec) {
  if (epochSec == null || Number.isNaN(Number(epochSec))) return '';
  const d = typeof epochSec === 'number' ? new Date(epochSec * 1000) : epochSec;
  return kyivDateFormatter.format(d);
}

/**
 * Отримання поточної години в Києві (0..23) для чистого UTC таймстемпу.
 * @param {number|Date} epochSec
 * @returns {number} 0..23
 */
export function getKyivHour(epochSec) {
  if (epochSec == null || Number.isNaN(Number(epochSec))) return 0;
  const d = typeof epochSec === 'number' ? new Date(epochSec * 1000) : epochSec;
  return Number(kyivHourFormatter.format(d));
}

/**
 * Форматування людино-зрозумілої мітки дня ("Сьогодні", "Вчора", "Позавчора", або "DD.MM").
 * @param {string} dateStr Дата події "YYYY-MM-DD"
 * @param {string} todayDateStr Сьогоднішня дата "YYYY-MM-DD"
 * @param {string} yestDateStr Вчорашня дата "YYYY-MM-DD"
 * @param {string} dayBeforeDateStr Позавчорашня дата "YYYY-MM-DD"
 * @returns {string}
 */
export function formatKyivDayLabel(dateStr, todayDateStr, yestDateStr, dayBeforeDateStr) {
  if (!dateStr) return '';
  if (dateStr === todayDateStr) return 'Сьогодні';
  if (dateStr === yestDateStr) return 'Вчора';
  if (dateStr === dayBeforeDateStr) return 'Позавчора';
  const parts = dateStr.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : dateStr;
}

export { getKyivOffsetSec };
