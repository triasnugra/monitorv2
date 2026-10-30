import { runScrape } from './base.js';
import { extractCryptoCards } from '../parsers/crypto.js';

// Mesin 1: DOM dibuka di browser, lalu kartu dibaca dengan extractCryptoCards (struktur terverifikasi).
export const scrape = (page, cfg) => runScrape(page, cfg, extractCryptoCards);
