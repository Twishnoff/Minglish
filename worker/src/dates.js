import { CONFIG } from './config.js';

// Returns "today" as a YYYY-MM-DD string in the configured timezone
// (Pacific), regardless of where the Worker happens to be running.
export function pacificDateString(date = new Date()) {
  // en-CA locale formats as YYYY-MM-DD, which is what we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Subtracts `days` calendar days from a YYYY-MM-DD string and returns a
// new YYYY-MM-DD string. Does simple UTC-noon arithmetic to sidestep DST
// edge cases -- fine for day-granularity cooldown/streak math.
export function subtractDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

export function isOnOrBefore(dateStr, otherDateStr) {
  return dateStr <= otherDateStr; // YYYY-MM-DD strings sort lexicographically
}

// Adds `days` calendar days to a YYYY-MM-DD string and returns a new
// YYYY-MM-DD string. Same UTC-noon approach as subtractDays, for the same
// DST-safety reason.
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
