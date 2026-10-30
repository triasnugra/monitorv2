import { runScrape } from './base.js';
import { extractTnv2Cards } from '../parsers/tnv2.js';

/**
 * tnv2: DOM dibuka di browser, lalu kartu dibaca oleh extractTnv2Cards.
 * HANYA kartu yang lolos gerbang v2 yang menjadi `items`; yang ditolak hanya dihitung di diagnostik.
 * Opsi deteksi tolak datang dari cfg.gate (config/sources.json).
 * extractTnv2Cards dikirim langsung ke page.evaluate (harus mandiri, tanpa closure).
 */
export const scrape = (page, cfg) => runScrape(page, cfg, extractTnv2Cards, cfg.gate ?? {});
