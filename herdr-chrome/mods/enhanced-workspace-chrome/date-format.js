/**
 * Pure date and time formatting utilities for Enhanced Workspace Chrome.
 */

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/**
 * Formats a Date instance into time and date parts.
 * @param {Date} [date]
 * @returns {{ time: string, date: string, fullDate: string, isoTimestamp: string }}
 */
export function formatClock(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const weekday = WEEKDAYS[date.getDay()] ?? "";

  return {
    time: `${hours}:${minutes}:${seconds}`,
    date: `${month}/${day} ${weekday}`,
    fullDate: `${year}/${month}/${day} ${weekday}`,
    isoTimestamp: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
  };
}
