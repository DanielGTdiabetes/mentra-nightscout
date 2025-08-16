"use strict";
// src/index.js — Nightscout MentraOS v2.10.3-combined
// SDK 2.1.18 — ROBUST + FALLBACK ENDPOINTS + HEAD-UP DISPLAY + MG/MMOL SYNC
// + SPARKLINE CHARTS + CACHING (LOCAL HISTORY) + COMBINED VIEW (TEXT+SPARKLINE) BMP 576x135
// v2.10.3 — FIXED: Render fallback logic for empty data & improved rendering flow.

require("dotenv").config();

const { AppServer } = require("@mentra/sdk");
const axios = require("axios");

/* ---------- HARD SHIM: evita crash si el SDK invoca método inexistente ---------- */
// Mantener como PRIMER bloque del archivo.
if (typeof Object.prototype.updateSettingsForTesting !== "function") {
  Object.defineProperty(Object.prototype, "updateSettingsForTesting", {
    value: async function () { /* noop compat */ },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
/* ------------------------------------------------------------------------------- */

const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error("❌ MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

const UNITS = { MGDL: "mg/dL", MMOL: "mmol/L" };

// Umbrales críticos de seguridad (hard-coded para protección del usuario)
const CRITICAL_THRESHOLDS = {
  LOW_MGDL: 70,
  HIGH_MGDL: 250
};

// --- Dimensiones de bitmaps optimizadas para G1B ---
const BMP_WIDTH = 576;
const BMP_HEIGHT = 135;

// Zona de layout (texto a la izquierda, sparkline a la derecha)
const LAYOUT = {
  padding: 8,
  // Ajuste las coordenadas Y para bajar el contenido
  text: { x: 12, y: 55, line: 10, scale: 2 }, 
  spark: { x: 280, y: 40, width: 576 - 280 - 8, height: 90 }, // ~288px de ancho
  // Habilita el modo de depuración para dibujar bordes de los elementos
  DEBUG: false,
};

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions = new Map();
    this.alertHistory = new Map();
    this.headUpLastShown = new Map();
    this.glucoseHistory = new Map();
    this.headUpTimeout = new Map(); // Para controlar el auto-ocultado
  }

  /* ---------------- helpers ---------------- */
  parseSlicerValue(val, fallback) {
    const n = (typeof val === 'object' && val !== null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
  }
  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  }

  // --- Helpers de sincronización mg/dL <-> mmol/L ---
  syncFromMmolToMg(mmol, min = 40, max = 400) {
    const mg = Math.round((Number(mmol) || 0) * 18);
    return Math.max(min, Math.min(max, mg));
  }
  syncFromMgToMmol(mg, min = 2, max = 30) {
    const mmol = Number(((Number(mg) || 0) / 18).toFixed(1));
    return Math.max(min, Math.min(max, mmol));
  }
  isDifferent(a, b, tol = 0.1) {
    return Math.abs(Number(a) - Number(b)) > tol;
  }

  /* ---------------- Util para alarmas ---------------- */
  getAlertLimits(settings) {
    if (settings.units === UNITS.MMOL) {
      return { low: Math.round(settings.low_alert_mmol * 18), high: Math.round(settings.high_alert_mmol * 18) };
    }
    return { low: Math.round(settings.low_alert_mg), high: Math.round(settings.high_alert_mg) };
  }

  alertLimitsChanged(oldSettings, newSettings) {
    if (!oldSettings) return false;
    return (
      oldSettings.low_alert_mg !== newSettings.low_alert_mg ||
      oldSettings.high_alert_mg !== newSettings.high_alert_mg ||
      oldSettings.low_alert_mmol !== newSettings.low_alert_mmol ||
      oldSettings.high_alert_mmol !== newSettings.high_alert_mmol ||
      oldSettings.units !== newSettings.units
    );
  }

  /* ---------------- Motor BMP + Fuente 5×7 ---------------- */

  createBitmapCanvas(width, height) {
    const bytesPerRow = Math.ceil(width / 8);
    const totalBytes = bytesPerRow * height;
    return new Uint8Array(totalBytes).fill(0);
  }

  setPixel(bitmap, width, height, x, y, white = true) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const bytesPerRow = Math.ceil(width / 8);
    const byteIndex = y * bytesPerRow + Math.floor(x / 8);
    const bitIndex = 7 - (x % 8);
    if (byteIndex < 0 || byteIndex >= bitmap.length) return;
    if (white) bitmap[byteIndex] |= (1 << bitIndex);
    else bitmap[byteIndex] &= ~(1 << bitIndex);
  }

  drawLine(bitmap, width, height, x1, y1, x2, y2) {
    let dx = Math.abs(x2 - x1), sx = x1 < x2 ? 1 : -1;
    let dy = -Math.abs(y2 - y1), sy = y1 < y2 ? 1 : -1;
    let err = dx + dy, e2;
    while (true) {
      this.setPixel(bitmap, width, height, x1, y1, true);
      if (x1 === x2 && y1 === y2) break;
      e2 = 2 * err;
      if (e2 >= dy) { err += dy; x1 += sx; }
      if (e2 <= dx) { err += dx; y1 += sy; }
    }
  }

  drawRect(bitmap, width, height, x, y, w, h) {
    this.drawLine(bitmap, width, height, x, y, x + w, y);
    this.drawLine(bitmap, width, height, x, y + h, x + w, y + h);
    this.drawLine(bitmap, width, height, x, y, x, y + h);
    this.drawLine(bitmap, width, height, x + w, y, x + w, y + h);
  }

  drawCircle(bitmap, width, height, cx, cy, r) {
    for (let x = -r; x <= r; x++) {
      for (let y = -r; y <= r; y++) {
        if (x * x + y * y <= r * r) this.setPixel(bitmap, width, height, cx + x, cy + y, true);
      }
    }
  }

  // Fuente 5x7
  FONT5x7 = (() => {
    const map = {};
    const def = (ch, rows) => { map[ch] = rows; };
    const D = {
      "0":[0x1E,0x21,0x23,0x25,0x29,0x31,0x1E], "1":[0x00,0x21,0x3F,0x01,0x00,0x00,0x00],
      "2":[0x23,0x25,0x29,0x29,0x29,0x29,0x31], "3":[0x22,0x41,0x49,0x49,0x49,0x49,0x36],
      "4":[0x0C,0x14,0x24,0x24,0x3F,0x04,0x04], "5":[0x72,0x51,0x51,0x51,0x51,0x51,0x4E],
      "6":[0x1E,0x29,0x49,0x49,0x49,0x49,0x06], "7":[0x40,0x47,0x48,0x50,0x60,0x40,0x40],
      "8":[0x36,0x49,0x49,0x49,0x49,0x49,0x36], "9":[0x30,0x49,0x49,0x49,0x49,0x4A,0x3C],
      "A":[0x3F,0x48,0x48,0x48,0x48,0x48,0x3F], "B":[0x3F,0x49,0x49,0x49,0x49,0x49,0x36],
      "C":[0x1E,0x21,0x41,0x41,0x41,0x41,0x22], "D":[0x3F,0x41,0x41,0x41,0x41,0x22,0x1C],
      "E":[0x3F,0x49,0x49,0x49,0x49,0x41,0x41], "F":[0x3F,0x48,0x48,0x48,0x48,0x40,0x40],
      "G":[0x1E,0x21,0x41,0x49,0x49,0x2F,0x0E], "H":[0x3F,0x08,0x08,0x08,0x08,0x08,0x3F],
      "I":[0x00,0x41,0x41,0x3F,0x41,0x41,0x00], "J":[0x02,0x01,0x01,0x01,0x01,0x3E,0x00],
      "K":[0x3F,0x08,0x14,0x22,0x41,0x00,0x00], "L":[0x3F,0x01,0x01,0x01,0x01,0x01,0x01],
      "M":[0x3F,0x20,0x10,0x08,0x10,0x20,0x3F], "N":[0x3F,0x20,0x10,0x08,0x04,0x02,0x3F],
      "O":[0x1E,0x21,0x41,0x41,0x41,0x21,0x1E], "P":[0x3F,0x48,0x48,0x48,0x48,0x30,0x00],
      "Q":[0x1E,0x21,0x41,0x45,0x42,0x21,0x1E], "R":[0x3F,0x48,0x4C,0x4A,0x49,0x31,0x00],
      "S":[0x32,0x49,0x49,0x49,0x49,0x49,0x26], "T":[0x40,0x40,0x40,0x3F,0x40,0x40,0x40],
      "U":[0x3E,0x01,0x01,0x01,0x01,0x01,0x3E], "V":[0x3C,0x02,0x01,0x01,0x01,0x02,0x3C],
      "W":[0x3E,0x01,0x06,0x18,0x06,0x01,0x3E], "X":[0x22,0x14,0x08,0x08,0x14,0x22,0x00],
      "Y":[0x20,0x10,0x08,0x07,0x08,0x10,0x20], "Z":[0x23,0x25,0x29,0x31,0x21,0x21,0x21],
      " ":[0x00,0x00,0x00,0x00,0x00,0x00,0x00], ":":[0x00,0x00,0x24,0x00,0x24,0x00,0x00],
      "/":[0x01,0x02,0x04,0x08,0x10,0x20,0x00], "-":[0x00,0x00,0x04,0x04,0x04,0x00,0x00],
      ".":[0x00,0x00,0x00,0x20,0x00,0x00,0x00], "m":[0x00,0x1F,0x10,0x0F,0x10,0x0F,0x00],
      "g":[0x00,0x0C,0x12,0x12,0x0E,0x01,0x1E], "d":[0x00,0x0F,0x10,0x10,0x10,0x0F,0x00],
      "L":[0x3F,0x01,0x01,0x01,0x01,0x01,0x01], "h":[0x00,0x3F,0x08,0x08,0x08,0x07,0x00],
      "a":[0x00,0x0C,0x1A,0x1A,0x12,0x04,0x00], "c":[0x00,0x0C,0x12,0x12,0x12,0x00,0x00],
      "e":[0x00,0x0C,0x1A,0x1A,0x12,0x04,0x00], "s":[0x00,0x14,0x1A,0x1A,0x12,0x00,0x00],
      "(": [0x00,0x00,0x1E,0x21,0x00,0x00,0x00], ")": [0x00,0x00,0x21,0x1E,0x00,0x00,0x00],
      "↑":[0x04,0x06,0x05,0x1C,0x05,0x06,0x04], "↓":[0x10,0x30,0x50,0x0F,0x50,0x30,0x10],
      "→":[0x00,0x08,0x0C,0x7E,0x0C,0x08,0x00], "↗":[0x00,0x06,0x05,0x78,0x00,0x00,0x00],
      "↘":[0x00,0x00,0x00,0x78,0x05,0x06,0x00], "⇈":[0x04,0x06,0x05,0x1C,0x05,0x06,0x04],
      "⇊":[0x10,0x30,0x50,0x0F,0x50,0x30,0x10]
    };
    Object.keys(D).forEach(k => def(k, D[k]));
    return map;
  })();

  drawChar5x7(bitmap, width, height, x, y, ch, scale = 1) {
    const glyph = this.FONT5x7[ch] || this.FONT5x7[" "];
    for (let row = 0; row < 7; row++) {
      const rowBits = glyph[row] || 0;
      for (let col = 0; col < 5; col++) {
        const on = (rowBits >> (4 - col)) & 1;
        if (on) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              this.setPixel(bitmap, width, height, x + col * scale + dx, y + row * scale + dy, true);
            }
          }
        }
      }
    }
    return 5 * scale;
  }

  drawString5x7(bitmap, width, height, x, y, text, scale = 1, letterSpacing = 1) {
    let cursor = x;
    for (const ch of String(text)) {
      cursor += this.drawChar5x7(bitmap, width, height, cursor, y, ch, scale) + letterSpacing;
    }
    return cursor - x;
  }

  bitmapToBase64(bitmap, width, height) {
    const bytesPerRowNoPad = Math.ceil(width / 8);
    const rowSize = Math.ceil(width / 32) * 4;
    const imageSize = rowSize * height;
    const fileSize = 62 + imageSize;
    const header = new Uint8Array(62);
    const view = new DataView(header.buffer);
    header[0] = 0x42; header[1] = 0x4D;
    view.setUint32(2, fileSize, true);
    view.setUint32(6, 0, true);
    view.setUint32(10, 62, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 1, true);
    view.setUint32(30, 0, true);
    view.setUint32(34, imageSize, true);
    view.setInt32(38, 2835, true);
    view.setInt32(42, 2835, true);
    view.setUint32(46, 2, true);
    view.setUint32(50, 2, true);
    header[54] = 0x00; header[55] = 0x00; header[56] = 0x00; header[57] = 0x00;
    header[58] = 0xFF; header[59] = 0xFF; header[60] = 0xFF; header[61] = 0x00;
    const result = new Uint8Array(fileSize);
    result.set(header, 0);
    for (let y = 0; y < height; y++) {
      const srcOffset = y * bytesPerRowNoPad;
      const dstOffset = 62 + (height - 1 - y) * rowSize;
      result.set(bitmap.subarray(srcOffset, srcOffset + bytesPerRowNoPad), dstOffset);
    }
    return Buffer.from(result.buffer).toString('base64');
  }

  /* ---------------- Sparkline Chart Generation (optimizada) ---------------- */

  // Downsample simple (mantén como máximo N puntos equiespaciados)
  downsample(points, maxPoints) {
    if (!points || points.length <= maxPoints) return points || [];
    const out = [];
    const step = (points.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
      out.push(points[Math.round(i * step)]);
    }
    return out;
  }

  drawAlertZones(bitmap, width, height, rect, limits, minValue, maxValue) {
    const { x, y, w, h } = rect;
    const range = maxValue - minValue || 1;
    // LOW (rayado inferior)
    if (limits.low > minValue) {
      const lowY = y + h - Math.round(((limits.low - minValue) / range) * h);
      for (let yy = lowY; yy < y + h; yy += 3) {
        for (let xx = x; xx < x + w; xx += 6) this.setPixel(bitmap, width, height, xx, yy, true);
      }
    }
    // HIGH (rayado superior)
    if (limits.high < maxValue) {
      const highY = y + h - Math.round(((limits.high - minValue) / range) * h);
      for (let yy = y; yy < highY; yy += 3) {
        for (let xx = x; xx < x + w; xx += 6) this.setPixel(bitmap, width, height, xx, yy, true);
      }
    }
  }

  generateSparklineBitmap(history, settings, canvasW = BMP_WIDTH, canvasH = BMP_HEIGHT) {
    const bitmap = this.createBitmapCanvas(canvasW, canvasH);
    const sx = LAYOUT.spark.x, sy = LAYOUT.spark.y, sw = LAYOUT.spark.width, sh = LAYOUT.spark.height;

    const points = (history || []).map(h => ({ sgv: h.sgv }));
    const ds = this.downsample(points, 64); // 64 puntos máx para reducir CPU
    if (ds.length < 2) return this.bitmapToBase64(bitmap, canvasW, canvasH);

    const values = ds.map(p => p.sgv);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue || 1;

    // Marco de sparkline
    this.drawRect(bitmap, canvasW, canvasH, sx, sy, sw - 1, sh - 1);

    // Zonas LOW/HIGH (rayadas)
    const limits = this.getAlertLimits(settings);
    this.drawAlertZones(bitmap, canvasW, canvasH, { x: sx + 1, y: sy + 1, w: sw - 2, h: sh - 2 }, limits, minValue, maxValue);

    // Línea
    const n = ds.length;
    for (let i = 0; i < n - 1; i++) {
      const x1 = sx + 1 + Math.round(i * (sw - 3) / (n - 1));
      const y1 = sy + 1 + (sh - 3) - Math.round(((ds[i].sgv - minValue) / range) * (sh - 3));
      const x2 = sx + 1 + Math.round((i + 1) * (sw - 3) / (n - 1));
      const y2 = sy + 1 + (sh - 3) - Math.round(((ds[i + 1].sgv - minValue) / range) * (sh - 3));
      this.drawLine(bitmap, canvasW, canvasH, x1, y1, x2, y2);
    }

    // Punto final
    const lastX = sx + 1 + Math.round((n - 1) * (sw - 3) / (n - 1));
    const lastY = sy + 1 + (sh - 3) - Math.round(((ds[n - 1].sgv - minValue) / range) * (sh - 3));
    this.drawCircle(bitmap, canvasW, canvasH, lastX, lastY, 2);

    return this.bitmapToBase64(bitmap, canvasW, canvasH);
  }

  /* ---------------- Vista combinada (texto + sparkline en un BMP) ---------------- */

  getTrendArrow(dir) {
    const map = {
      'DoubleUp': '⇈', 'SingleUp': '↑', 'FortyFiveUp': '↗',
      'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '↓', 'DoubleDown': '⇊',
      'NONE': '-', 'NOT COMPUTABLE': '→',
    };
    return map[dir] || '→';
  }
  convertToDisplay(mgdlValue, targetUnit) {
    if (targetUnit === UNITS.MMOL) return (mgdlValue / 18).toFixed(1);
    return Math.round(mgdlValue);
  }
  getLanguageSettings(settings) {
    const langMap = {
      es: { locale: 'es-ES', timezone: 'Europe/Madrid' },
      en: { locale: 'en-US', timezone: 'America/New_York' },
    };
    return langMap[settings.language] || langMap['en'];
  }
  validateTimezone(tz) {
    const valid = [
      'Europe/Madrid', 'Atlantic/Canary', 'Europe/London', 'Europe/Paris',
      'Europe/Berlin', 'Europe/Rome', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
      'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
    ];
    return valid.includes(tz) ? tz : 'UTC';
  }

  async formatForG1(data, settings) {
    const display = this.convertToDisplay(data.sgv, settings.units);
    const trend = this.getTrendArrow(data.direction);
    const langSettings = this.getLanguageSettings(settings);
    const timezone = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const readingTime = new Date(data.date);
    const timeStr = readingTime.toLocaleTimeString(langSettings.locale, {
      timeZone: timezone, hour: '2-digit', minute: '2-digit'
    });
    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const lang = settings.language || 'en';
    const timeAgo = minutesAgo <= 1 ? (lang === 'es' ? 'ahora' : 'now') : (lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    return { line1: `${display} ${settings.units} ${trend}`, line2: `${timeStr} (${timeAgo})` };
  }

  generateCombinedBitmap(history, lastReading, settings) {
    const bitmap = this.createBitmapCanvas(BMP_WIDTH, BMP_HEIGHT);
    const lang = settings.language || 'en';
    
    // --- DEBUG: Dibuja un borde de depuración para visualizar el bitmap y las zonas de layout ---
    if (LAYOUT.DEBUG) {
        this.drawRect(bitmap, BMP_WIDTH, BMP_HEIGHT, 0, 0, BMP_WIDTH - 1, BMP_HEIGHT - 1);
        const { x, y, width, height } = LAYOUT.spark;
        this.drawRect(bitmap, BMP_WIDTH, BMP_HEIGHT, x, y, width - 1, height - 1);
    }

    // Lógica de fallback: si no hay datos de lectura, muestra un mensaje de estado
    if (!lastReading) {
      const statusMessage = lang === 'es' ? "Cargando..." : "Loading...";
      const x = Math.floor((BMP_WIDTH - statusMessage.length * (5 * LAYOUT.text.scale + 1)) / 2);
      this.drawString5x7(bitmap, BMP_WIDTH, BMP_HEIGHT, x, LAYOUT.text.y, statusMessage, LAYOUT.text.scale, 1);
      return this.bitmapToBase64(bitmap, BMP_WIDTH, BMP_HEIGHT);
    }
    
    // Texto principal
    const { line1, line2 } = { ...{ line1: '', line2: '' }, ...((() => {
      // utilizamos la versión sync del formatter (mismos cálculos pero inline)
      const display = this.convertToDisplay(lastReading.sgv, settings.units);
      const trend = this.getTrendArrow(lastReading.direction);
      const langSettings = this.getLanguageSettings(settings);
      const timezone = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
      const readingTime = new Date(lastReading.date);
      const timeStr = readingTime.toLocaleTimeString(langSettings.locale, {
        timeZone: timezone, hour: '2-digit', minute: '2-digit'
      });
      const minutesAgo = Math.floor((Date.now() - lastReading.date) / 60000);
      const timeAgo = minutesAgo <= 1 ? (lang === 'es' ? 'ahora' : 'now') : (lang === 'es' ? `${minutesAgo}m ago` : `${minutesAgo}m ago`);
      return { line1: `${display} ${settings.units} ${trend}`, line2: `${timeStr} (${timeAgo})` };
    })()) };
    // Render texto (escala 2 para línea 1, escala 1 para línea 2)
    const s2 = LAYOUT.text.scale;
    this.drawString5x7(bitmap, BMP_WIDTH, BMP_HEIGHT, LAYOUT.text.x, LAYOUT.text.y, line1, s2, 1);
    this.drawString5x7(bitmap, BMP_WIDTH, BMP_HEIGHT, LAYOUT.text.x, LAYOUT.text.y + 9 * s2 + 6, line2, 1, 1);

    // Sparkline a la derecha (usa el mismo motor que la versión independiente)
    const points = this.downsample((history || []).map(h => ({ sgv: h.sgv })), 64);
    if (points.length >= 2) {
      const values = points.map(p => p.sgv);
      const minValue = Math.min(...values);
      const maxValue = Math.max(...values);
      const range = maxValue - minValue || 1;
      const sx = LAYOUT.spark.x, sy = LAYOUT.spark.y, sw = LAYOUT.spark.width, sh = LAYOUT.spark.height;
      // Marco
      this.drawRect(bitmap, BMP_WIDTH, BMP_HEIGHT, sx, sy, sw - 1, sh - 1);
      // Zonas
      const limits = this.getAlertLimits(settings);
      this.drawAlertZones(bitmap, BMP_WIDTH, BMP_HEIGHT, { x: sx + 1, y: sy + 1, w: sw - 2, h: sh - 2 }, limits, minValue, maxValue);
      // Línea
      const n = points.length;
      for (let i = 0; i < n - 1; i++) {
        const x1 = sx + 1 + Math.round(i * (sw - 3) / (n - 1));
        const y1 = sy + 1 + (sh - 3) - Math.round(((points[i].sgv - minValue) / range) * (sh - 3));
        const x2 = sx + 1 + Math.round((i + 1) * (sw - 3) / (n - 1));
        const y2 = sy + 1 + (sh - 3) - Math.round(((points[i + 1].sgv - minValue) / range) * (sh - 3));
        this.drawLine(bitmap, BMP_WIDTH, BMP_HEIGHT, x1, y1, x2, y2);
      }
      // Punto final
      const lastX = sx + 1 + Math.round((n - 1) * (sw - 3) / (n - 1));
      const lastY = sy + 1 + (sh - 3) - Math.round(((points[n - 1].sgv - minValue) / range) * (sh - 3));
      this.drawCircle(bitmap, BMP_WIDTH, BMP_HEIGHT, lastX, lastY, 2);
    }
    return this.bitmapToBase64(bitmap, BMP_WIDTH, BMP_HEIGHT);
  }

  /* ---------------- settings (lectura directa del store) ---------------- */
  async getUserSettings(session) {
    try {
      const [ url, token, updateInterval, lowMg, highMg, lowMmol, highMmol, alertsEnabled, language, timezone, units, enable_head_up_display, enable_sparkline_display, display_duration_ms, dashboard_duration_ms, alert_duration_ms ] = await Promise.all([
        session.settings.get('nightscout_url'),
        session.settings.get('nightscout_token'),
        session.settings.get('update_interval'),
        session.settings.get('low_alert_mg'),
        session.settings.get('high_alert_mg'),
        session.settings.get('low_alert_mmol'),
        session.settings.get('high_alert_mmol'),
        session.settings.get('alerts_enabled'),
        session.settings.get('language'),
        session.settings.get('timezone'),
        session.settings.get('units'),
        session.settings.get('enable_head_up_display'),
        session.settings.get('enable_sparkline_display'),
        session.settings.get('display_duration_ms'),
        session.settings.get('dashboard_duration_ms'),
        session.settings.get('alert_duration_ms'),
      ]);

      const settings = {
        nightscout_url: url,
        nightscout_token: token,
        update_interval: this.validateSlicerValue(updateInterval, 1, 60, 5),
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 100, 80),
        high_alert_mg: this.validateSlicerValue(highMg, 150, 400, 180),
        low_alert_mmol: this.validateSlicerValue(lowMmol, 2.2, 5.5, 4.4),
        high_alert_mmol: this.validateSlicerValue(highMmol, 8.3, 22.2, 10.0),
        alerts_enabled: alertsEnabled === true,
        language: language || 'en',
        timezone: timezone || '',
        units: units || UNITS.MGDL,
        display_duration_ms: this.validateSlicerValue(display_duration_ms, 1, 60, 30) * 1000,
        dashboard_duration_ms: this.validateSlicerValue(dashboard_duration_ms, 1, 60, 30) * 1000,
        alert_duration_ms: this.validateSlicerValue(alert_duration_ms, 1, 60, 30) * 1000,
      };
      
      // La configuración de los switches es un caso especial
      const [enable_head_up_display_obj, enable_sparkline_display_obj] = await Promise.all([
          session.settings.get('enable_head_up_display'),
          session.settings.get('enable_sparkline_display'),
      ]);
      settings.enable_head_up_display = (typeof enable_head_up_display_obj === 'object' && enable_head_up_display_obj !== null) ? enable_head_up_display_obj.value : enable_head_up_display_obj;
      settings.enable_sparkline_display = (typeof enable_sparkline_display_obj === 'object' && enable_sparkline_display_obj !== null) ? enable_sparkline_display_obj.value : enable_sparkline_display_obj;


      if (!settings.nightscout_url) {
        throw new Error('Nightscout URL no está configurada.');
      }
      return settings;
    } catch (e) {
      console.error('Error al obtener la configuración del usuario:', e);
      throw e;
    }
  }

  /* ---------------- Handlers de eventos de MentraOS ---------------- */
  async onHeadPosition(session) {
    const userId = session.userId;
    const { enable_head_up_display, display_duration_ms } = await this.getUserSettings(session);

    if (enable_head_up_display) {
      const now = Date.now();
      const lastShown = this.headUpLastShown.get(userId) || 0;
      
      // La lógica del onHeadPosition se activa cuando levantas la cabeza
      // Si el display ya está activo y dentro del tiempo de visualización, no hacemos nada.
      // Si el display está oculto o ha expirado, lo mostramos.
      if (now - lastShown > display_duration_ms) {
        this.headUpLastShown.set(userId, now);

        // Limpia el temporizador anterior si existe para evitar conflictos
        if (this.headUpTimeout.has(userId)) {
          clearTimeout(this.headUpTimeout.get(userId));
        }

        // Establece un nuevo temporizador para ocultar el bitmap después de `display_duration_ms`
        this.headUpTimeout.set(userId, setTimeout(async () => {
          await this.render(session, { forceHide: true });
          this.headUpTimeout.delete(userId);
        }, display_duration_ms));

        // Renderiza el bitmap inmediatamente para mostrarlo
        await this.render(session, { forceShow: true });
      }
    }
  }
  
  async onDashboardExit(session) {
      // Oculta el HUD cuando el usuario sale del dashboard
      await this.render(session, { forceHide: true });
  }

  async onSettingsUpdated(session) {
    const userId = session.userId;
    const settings = await this.getUserSettings(session);
    this.sessions.set(userId, { ...this.sessions.get(userId), settings });
    this.log(session, 'Configuración actualizada');
    await this.render(session, { forceShow: false });
  }

  async onAppReady(session) {
    this.log(session, "App ready");
  }

  async onAppStart(session) {
    const userId = session.userId;
    this.sessions.set(userId, { session, userId, settings: {} });
    try {
      const settings = await this.getUserSettings(session);
      this.sessions.set(userId, { ...this.sessions.get(userId), settings });
      this.log(session, 'App iniciada. Configuración cargada.');
      await this.render(session);
    } catch (e) {
      this.log(session, `Error al iniciar: ${e.message}`);
    }
  }
  async onAppExit(session) {
    const userId = session.userId;
    this.sessions.delete(userId);
    this.alertHistory.delete(userId);
    this.headUpLastShown.delete(userId);
    this.glucoseHistory.delete(userId);
    if (this.headUpTimeout.has(userId)) {
      clearTimeout(this.headUpTimeout.get(userId));
      this.headUpTimeout.delete(userId);
    }
    this.log(session, "App cerrada");
  }
  
  async render(session, { forceHide = false, forceShow = false } = {}) {
    const userId = session.userId;
    const { enable_head_up_display, display_duration_ms } = await this.getUserSettings(session);
    
    // Si no está activado, o si se fuerza el ocultamiento, oculta el bitmap
    if (forceHide || !enable_head_up_display || !session.session) {
      return session.sendBitmap({
        bitmap: null,
        position: 'HeadUpDisplay',
        id: 'glucose-combined',
      });
    }

    // Lógica para mostrar el bitmap
    const now = Date.sno();
    const lastShown = this.headUpLastShown.get(userId) || 0;
    const isShowingDueToHeadUp = (now - lastShown) <= display_duration_ms;
    
    if (enable_head_up_display && (isShowingDueToHeadUp || forceShow)) {
      const lastReading = this.glucoseHistory.get(userId)?.lastReading;
      const history = this.glucoseHistory.get(userId)?.history;
      
      const combinedBitmapBase64 = this.generateCombinedBitmap(history, lastReading, await this.getUserSettings(session));

      await session.sendBitmap({
        bitmap: combinedBitmapBase64,
        position: 'HeadUpDisplay',
        id: 'glucose-combined',
      });
    }
  }


  async onDataUpdated(session, { nightscoutData }) {
    const userId = session.userId;
    const { settings } = this.sessions.get(userId);
    if (!settings) {
      this.log(session, "No se encontró la configuración, re-cargando...");
      await this.onAppStart(session);
      return;
    }
    const oldReading = this.glucoseHistory.get(userId)?.lastReading || null;
    const currentReading = nightscoutData.currentReading;
    const history = nightscoutData.history;

    if (!currentReading) {
      this.log(session, "No hay datos de glucosa disponibles. Intente de nuevo más tarde.");
      // Renderiza con un mensaje de error o estado de "cargando..."
      await this.render(session, { forceShow: false }); 
      return;
    }

    this.glucoseHistory.set(userId, { lastReading: currentReading, history });

    await this.render(session, { forceShow: false }); // Renderiza la pantalla principal si se actualiza el dashboard

    // Lógica de alertas
    const limits = this.getAlertLimits(settings);
    const mgdlValue = currentReading.sgv;

    if (settings.alerts_enabled) {
      const isLowAlert = mgdlValue <= limits.low && (!oldReading || oldReading.sgv > limits.low);
      const isHighAlert = mgdlValue >= limits.high && (!oldReading || oldReading.sgv < limits.high);

      if (isLowAlert || isHighAlert) {
        // Envia alerta, ya sea de voz o visual
        const alertType = isLowAlert ? 'low' : 'high';
        const msg = alertType === 'low'
          ? (settings.language === 'es' ? `Glucosa baja: ${this.convertToDisplay(mgdlValue, settings.units)} ${settings.units}` : `Low glucose: ${this.convertToDisplay(mgdlValue, settings.units)} ${settings.units}`)
          : (settings.language === 'es' ? `Glucosa alta: ${this.convertToDisplay(mgdlValue, settings.units)} ${settings.units}` : `High glucose: ${this.convertToDisplay(mgdlValue, settings.units)} ${settings.units}`);

        await session.sendAudio({
          text: msg,
          priority: 'high',
          duration_ms: settings.alert_duration_ms
        });

        // Limpia el historial para que la alerta no se dispare de nuevo inmediatamente
        this.alertHistory.set(userId, { type: alertType, timestamp: Date.now() });
      }
    }
  }

  async onVoiceCommand(session, command) {
    const lang = session.settings.language || 'en';
    const lastReading = this.glucoseHistory.get(session.userId)?.lastReading;

    if (command.toLowerCase().includes(lang === 'es' ? 'glucosa' : 'glucose')) {
      if (!lastReading) {
        return session.sendAudio({ text: lang === 'es' ? 'No hay datos de glucosa disponibles.' : 'No glucose data available.' });
      }

      const { line1, line2 } = await this.formatForG1(lastReading, await this.getUserSettings(session));
      return session.sendAudio({ text: `${line1}. ${line2}.` });
    }
  }

  async fetchGlucoseData(session) {
    const { nightscout_url, nightscout_token, update_interval } = await this.getUserSettings(session);
    const userId = session.userId;
    const historyMins = 60 * 3; // 3 horas de historial
    const url = `${nightscout_url}/api/v1/entries.json?token=${nightscout_token}&count=${Math.ceil(historyMins / update_interval)}`;
    const errorMessages = {
      es: {
        networkError: 'Error de red al conectar con Nightscout.',
        invalidToken: 'Token de Nightscout inválido.',
        connectionFailed: 'No se pudo conectar con Nightscout.',
      },
      en: {
        networkError: 'Network error connecting to Nightscout.',
        invalidToken: 'Invalid Nightscout token.',
        connectionFailed: 'Failed to connect to Nightscout.',
      }
    };
    const lang = (await this.getUserSettings(session)).language || 'en';

    try {
      const response = await axios.get(url, { timeout: 10000 });
      if (response.status !== 200 || !Array.isArray(response.data)) {
        throw new Error('Respuesta de Nightscout inválida.');
      }
      const allReadings = response.data.map(d => ({
        sgv: d.sgv,
        date: d.date,
        direction: d.direction,
      }));
      const lastReading = allReadings[0];
      const history = allReadings.slice(1);

      return { success: true, data: { currentReading: lastReading, history } };
    } catch (e) {
      let errorMsg = errorMessages[lang].connectionFailed;
      if (e.response) {
        if (e.response.status === 401) errorMsg = errorMessages[lang].invalidToken;
      } else if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND') {
        errorMsg = errorMessages[lang].networkError;
      } else if (e.message.includes('No hay datos')) { // Manejar el caso de "No hay datos"
        errorMsg = lang === 'es' ? "No hay datos de glucosa disponibles." : "No glucose data available.";
      }
      return { success: false, error: errorMsg };
    }
  }

  getGlucoseStatusText(value, settings, lang) {
    const limits = this.getAlertLimits(settings);
    if (value < CRITICAL_THRESHOLDS.LOW_MGDL) { return lang === 'es' ? 'Crítico Bajo' : 'Critical Low'; }
    if (value > CRITICAL_THRESHOLDS.HIGH_MGDL) { return lang === 'es' ? 'Crítico Alto' : 'Critical High'; }
    if (value <= limits.low) return lang === 'es' ? 'Bajo' : 'Low';
    if (value >= limits.high) return lang === 'es' ? 'Alto' : 'High';
    return 'Normal';
  }
}

/* ---------------- init ---------------- */
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server.start().catch(err => {
  console.error('❌ Error iniciando servidor:', err);
  process.exit(1);
});

console.log('🚀 Nightscout MentraOS v2.10.3-combined — FIXED: Render fallback logic & improved rendering flow');
