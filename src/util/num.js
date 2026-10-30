/**
 * Parse angka dari teks. Mengembalikan { value, ambiguous }.
 * Aturan:
 *  - '$', huruf (USDT, USD), spasi, '%' dibuang.
 *  - Ada '.' dan ',' sekaligus: pemisah yang muncul TERAKHIR = desimal.
 *  - Satu jenis pemisah muncul >1 kali: pemisah ribuan.
 *  - '.' tunggal: desimal ("1.144" = 1,144 -> sesuai contoh SUI).
 *  - ',' tunggal dengan tepat 3 digit di belakang (mis. "1,144"): AMBIGU. Dibaca sebagai ribuan
 *    (en-US) dan ditandai ambiguous=true; evaluator punya sanity-check harga sebagai jaring pengaman.
 *  - ',' tunggal lainnya: desimal.
 */
export function parseNumberDetailed(input) {
  if (typeof input === 'number') return { value: Number.isFinite(input) ? input : null, ambiguous: false };
  if (input == null) return { value: null, ambiguous: false };
  let s = String(input).replace(/\([^)]*\)/g, '').replace(/[A-Za-z$%\s\u00a0]/g, '');
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return { value: null, ambiguous: false };
  let ambiguous = false;
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const th = dec === '.' ? ',' : '.';
    s = s.split(th).join('').replace(dec, '.');
  } else if (commas > 1 || dots > 1) {
    s = s.replace(/[.,]/g, '');
  } else if (commas === 1) {
    const after = s.split(',')[1];
    if (after.length === 3 && !/^-?0,/.test(s)) { ambiguous = true; s = s.replace(',', ''); }
    else s = s.replace(',', '.');
  }
  const v = Number(s);
  return { value: Number.isFinite(v) ? v : null, ambiguous };
}
export const parseNumber = (x) => parseNumberDetailed(x).value;
