export const MIN = 60_000;
const WIB_OFFSET_MS = 7 * 3600_000; // Asia/Jakarta = UTC+7, tanpa DST

export const toIso = (ms) => new Date(ms).toISOString();

/** ISO/ms -> 'YYYY-MM-DD HH:mm' dalam WIB. null jika tidak valid. */
export function toWib(input) {
  if (input == null) return null;
  const ms = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Parse waktu dari teks sumber. Hanya menerima format dengan zona eksplisit
 * (ISO dengan Z/offset, atau 'YYYY-MM-DD HH:mm WIB|UTC'). Tanpa zona -> null (tidak menebak).
 */
export function parseTime(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(WIB|UTC)$/i);
  if (!m) return null;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return m[7].toUpperCase() === 'WIB' ? base - WIB_OFFSET_MS : base;
}

export const minutesBetween = (aIso, bIso) =>
  aIso && bIso ? (Date.parse(bIso) - Date.parse(aIso)) / MIN : null;
