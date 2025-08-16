"use strict";
// src/index.js — Nightscout MentraOS v2.10.0-combined
// SDK 2.1.18 — ROBUST + FALLBACK ENDPOINTS + HEAD-UP DISPLAY + MG/MMOL SYNC
// + SPARKLINE CHARTS + CACHING (LOCAL HISTORY) + COMBINED VIEW (TEXT+SPARKLINE) BMP 576x135

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
  text: { x: 12, y: 14, line: 10, scale: 2 }, // fuente 5x7, escalada x2 para el valor
  spark: { x: 280, y: 8, width: 576 - 280 - 8, height: 119 } // ~288px de ancho
};

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions = new Map();
    this.alertHistory = new Map();
    this.headUpLastShown = new Map();
    this.glucoseHistory = new Map();
    this.lastHeadUp = new Map(); // secuencia "arriba -> abajo"
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

  // Fuente 5x7 mínima (ASCII básico 32..90 + set ampliable). 1 = pixel on.
  // Para brevedad incluimos dígitos, letras mayúsculas básicas, símbolos usados.
  // Cada char = 5 columnas, 7 filas. Se puede ampliar si lo necesitas.
  FONT5x7 = (() => {
    const map = {};
    const def = (ch, rows) => { map[ch] = rows; };
    const D = {
      "0":[0x1E,0x21,0x23,0x25,0x29,0x31,0x1E],
      "1":[0x00,0x21,0x3F,0x01,0x00,0x00,0x00],
      "2":[0x23,0x25,0x29,0x29,0x29,0x29,0x31],
      "3":[0x22,0x41,0x49,0x49,0x49,0x49,0x36],
      "4":[0x0C,0x14,0x24,0x24,0x3F,0x04,0x04],
      "5":[0x72,0x51,0x51,0x51,0x51,0x51,0x4E],
      "6":[0x1E,0x29,0x49,0x49,0x49,0x49,0x06],
      "7":[0x40,0x47,0x48,0x50,0x60,0x40,0x40],
      "8":[0x36,0x49,0x49,0x49,0x49,0x49,0x36],
      "9":[0x30,0x49,0x49,0x49,0x49,0x4A,0x3C],
      "A":[0x3F,0x48,0x48,0x48,0x48,0x48,0x3F],
      "B":[0x3F,0x49,0x49,0x49,0x49,0x49,0x36],
      "C":[0x1E,0x21,0x41,0x41,0x41,0x41,0x22],
      "D":[0x3F,0x41,0x41,0x41,0x41,0x22,0x1C],
      "E":[0x3F,0x49,0x49,0x49,0x49,0x41,0x41],
      "F":[0x3F,0x48,0x48,0x48,0x48,0x40,0x40],
      "G":[0x1E,0x21,0x41,0x49,0x49,0x2F,0x0E],
      "H":[0x3F,0x08,0x08,0x08,0x08,0x08,0x3F],
      "I":[0x00,0x41,0x41,0x3F,0x41,0x41,0x00],
      "J":[0x02,0x01,0x01,0x01,0x01,0x3E,0x00],
      "K":[0x3F,0x08,0x14,0x22,0x41,0x00,0x00],
      "L":[0x3F,0x01,0x01,0x01,0x01,0x01,0x01],
      "M":[0x3F,0x20,0x10,0x08,0x10,0x20,0x3F],
      "N":[0x3F,0x20,0x10,0x08,0x04,0x02,0x3F],
      "O":[0x1E,0x21,0x41,0x41,0x41,0x21,0x1E],
      "P":[0x3F,0x48,0x48,0x48,0x48,0x30,0x00],
      "Q":[0x1E,0x21,0x41,0x45,0x42,0x21,0x1E],
      "R":[0x3F,0x48,0x4C,0x4A,0x49,0x31,0x00],
      "S":[0x32,0x49,0x49,0x49,0x49,0x49,0x26],
      "T":[0x40,0x40,0x40,0x3F,0x40,0x40,0x40],
      "U":[0x3E,0x01,0x01,0x01,0x01,0x01,0x3E],
      "V":[0x3C,0x02,0x01,0x01,0x01,0x02,0x3C],
      "W":[0x3E,0x01,0x06,0x18,0x06,0x01,0x3E],
      "X":[0x22,0x14,0x08,0x08,0x14,0x22,0x00],
      "Y":[0x20,0x10,0x08,0x07,0x08,0x10,0x20],
      "Z":[0x23,0x25,0x29,0x31,0x21,0x21,0x21],
      " ":[0x00,0x00,0x00,0x00,0x00,0x00,0x00],
      ":":[0x00,0x00,0x24,0x00,0x24,0x00,0x00],
      "/":[0x01,0x02,0x04,0x08,0x10,0x20,0x00],
      "-":[0x00,0x00,0x04,0x04,0x04,0x00,0x00],
      ".":[0x00,0x00,0x00,0x20,0x00,0x00,0x00],
      "m":[0x00,0x1F,0x10,0x0F,0x10,0x0F,0x00],
      "g":[0x00,0x0C,0x12,0x12,0x0E,0x01,0x1E],
      "d":[0x00,0x0F,0x10,0x10,0x10,0x0F,0x00],
      "L":[0x3F,0x01,0x01,0x01,0x01,0x01,0x01],
      "h":[0x00,0x3F,0x08,0x08,0x08,0x07,0x00],
      "a":[0x00,0x0C,0x12,0x12,0x12,0x1E,0x00],
      "c":[0x00,0x0C,0x12,0x12,0x12,0x00,0x00],
      "e":[0x00,0x0C,0x1A,0x1A,0x12,0x04,0x00],
      "s":[0x00,0x14,0x1A,0x1A,0x12,0x00,0x00],
      "(": [0x00,0x00,0x1E,0x21,0x00,0x00,0x00],
      ")": [0x00,0x00,0x21,0x1E,0x00,0x00,0x00],
      "↑":[0x04,0x06,0x05,0x1C,0x05,0x06,0x04],
      "↓":[0x10,0x30,0x50,0x0F,0x50,0x30,0x10],
      "→":[0x00,0x08,0x0C,0x7E,0x0C,0x08,0x00],
      "↗":[0x00,0x06,0x05,0x78,0x00,0x00,0x00],
      "↘":[0x00,0x00,0x00,0x78,0x05,0x06,0x00],
      "⇈":[0x04,0x06,0x05,0x1C,0x05,0x06,0x04], // aproximación
      "⇊":[0x10,0x30,0x50,0x0F,0x50,0x30,0x10]  // aproximación
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
      const lang = settings.language || 'en';
      const timeAgo = minutesAgo <= 1 ? (lang === 'es' ? 'ahora' : 'now') : (lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
      return { line1: `${display} ${settings.units} ${trend}`, line2: `${timeStr} (${timeAgo})` };
    })()) };

    // Render texto (escala 2 para línea 1, escala 1 para línea 2)
    const s2 = LAYOUT.text.scale;
    this.drawString5x7(bitmap, BMP_WIDTH, BMP_HEIGHT, LAYOUT.text.x, LAYOUT.text.y, line1, s2, 1);
    this.drawString5x7(bitmap, BMP_WIDTH, BMP_HEIGHT, LAYOUT.text.x, LAYOUT.text.y + 9 * s2 + 6, line2, 1, 1);

    // Sparkline a la derecha (usa el mismo motor que la versión independiente)
    const bmpWithSpark = this.generateSparklineBitmap(history, settings, BMP_WIDTH, BMP_HEIGHT);
    // generateSparklineBitmap ya devuelve el BMP completo en base64;
    // pero como hemos dibujado texto antes, necesitamos fusionar en el mismo lienzo.
    // Para evitar doble pasada costosa, re-dibujamos sparkline directamente aquí:

    // Volvemos a pintar sparkline (sin re-crear BMP):
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
      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units,
        enable_head_up_display, enable_sparkline_display,
        display_duration_ms, dashboard_duration_ms, alert_duration_ms
      ] = await Promise.all([
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
        session.settings.get('alert_duration_ms')
      ]);

      const finalUrl = String(url || '').trim() || '';
      const finalToken = String(token || '').trim() || '';
      console.log(`🔍 Settings - URL:${finalUrl ? '[SET]' : '[EMPTY]'} Token:${finalToken ? '[SET]' : '[EMPTY]'} Units:${units || 'mg/dL'} Sparkline:${enable_sparkline_display ? 'ON' : 'OFF'}`);

      const result = {
        nightscoutUrl: finalUrl,
        nightscoutToken: finalToken,
        updateInterval: this.parseSlicerValue(updateInterval, 5),
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 90, 70),
        high_alert_mg: this.validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: this.validateSlicerValue(lowMmol, 2, 5, 3.9),
        high_alert_mmol: this.validateSlicerValue(highMmol, 8, 30, 13.9),
        alertsEnabled: (alertsEnabled === true || alertsEnabled === 'true' || alertsEnabled === 1 || alertsEnabled === '1'),
        language: language || 'en',
        timezone: timezone || null,
        units: units || UNITS.MGDL,
        enable_head_up_display: (enable_head_up_display === true || enable_head_up_display === 'true' || enable_head_up_display === 1 || enable_head_up_display === '1'),
        enable_sparkline_display: (enable_sparkline_display === true || enable_sparkline_display === 'true' || enable_sparkline_display === 1 || enable_sparkline_display === '1'),
        display_duration_ms: this.validateSlicerValue(display_duration_ms, 1000, 30000, 5000),
        dashboard_duration_ms: this.validateSlicerValue(dashboard_duration_ms, 1000, 30000, 10000),
        alert_duration_ms: this.validateSlicerValue(alert_duration_ms, 5000, 60000, 15000)
      };

      try {
        if (result.units === UNITS.MMOL) {
          const mgLow = this.syncFromMmolToMg(result.low_alert_mmol);
          const mgHigh = this.syncFromMmolToMg(result.high_alert_mmol);
          if (this.isDifferent(result.low_alert_mg, mgLow) || this.isDifferent(result.high_alert_mg, mgHigh)) {
            await Promise.all([
              session.settings.set('low_alert_mg', mgLow),
              session.settings.set('high_alert_mg', mgHigh),
            ]);
            result.low_alert_mg = mgLow;
            result.high_alert_mg = mgHigh;
          }
        } else { // mg/dL
          const mmolLow = this.syncFromMgToMmol(result.low_alert_mg);
          const mmolHigh = this.syncFromMgToMmol(result.high_alert_mg);
          if (this.isDifferent(result.low_alert_mmol, mmolLow) || this.isDifferent(result.high_alert_mmol, mmolHigh)) {
            await Promise.all([
              session.settings.set('low_alert_mmol', mmolLow),
              session.settings.set('high_alert_mmol', mmolHigh),
            ]);
            result.low_alert_mmol = mmolLow;
            result.high_alert_mmol = mmolHigh;
          }
        }
      } catch (e) {
        session?.logger?.debug?.('Sync (startup) skipped/failed', { err: e?.message });
      }

      return result;
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '', nightscoutToken: '',
        updateInterval: 5,
        low_alert_mg: 70, high_alert_mg: 250,
        low_alert_mmol: 3.9, high_alert_mmol: 13.9,
        alertsEnabled: true, language: 'en', timezone: null, units: UNITS.MGDL,
        enable_head_up_display: false, enable_sparkline_display: false,
        display_duration_ms: 5000, dashboard_duration_ms: 10000, alert_duration_ms: 15000
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    const units = o.units || UNITS.MGDL;
    console.log(`🔍 Settings parseados - Units:${units} Sparkline:${o.enable_sparkline_display ? 'ON' : 'OFF'}`);

    return {
      nightscoutUrl: String(o.nightscout_url || '').trim() || '',
      nightscoutToken: String(o.nightscout_token || '').trim() || '',
      updateInterval: this.parseSlicerValue(o.update_interval, 5),
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 40, 90, 70),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, 250),
      low_alert_mmol: this.validateSlicerValue(o.low_alert_mmol, 2, 5, 3.9),
      high_alert_mmol: this.validateSlicerValue(o.high_alert_mmol, 8, 30, 13.9),
      alertsEnabled: (o.alerts_enabled === true || o.alerts_enabled === 'true' || o.alerts_enabled === 1 || o.alerts_enabled === '1'),
      language: o.language || 'en',
      timezone: o.timezone || null,
      units,
      enable_head_up_display: (o.enable_head_up_display === true || o.enable_head_up_display === 'true' || o.enable_head_up_display === 1 || o.enable_head_up_display === '1'),
      enable_sparkline_display: (o.enable_sparkline_display === true || o.enable_sparkline_display === 'true' || o.enable_sparkline_display === 1 || o.enable_sparkline_display === '1'),
      display_duration_ms: this.validateSlicerValue(o.display_duration_ms, 1000, 30000, 5000),
      dashboard_duration_ms: this.validateSlicerValue(o.dashboard_duration_ms, 1000, 30000, 10000),
      alert_duration_ms: this.validateSlicerValue(o.alert_duration_ms, 5000, 60000, 15000)
    };
  }

  /* ---------------- Glucose History Management ---------------- */
  addToGlucoseHistory(sessionId, reading) {
    if (!this.glucoseHistory.has(sessionId)) {
      this.glucoseHistory.set(sessionId, []);
    }
    const history = this.glucoseHistory.get(sessionId);
    history.push({ sgv: reading.sgv, date: reading.date });
    if (history.length > 120) history.splice(0, history.length - 120); // ~10h si cada 5min
    this.glucoseHistory.set(sessionId, history);
  }

  // ⚡ Pre-cargar historial para que haya gráfica desde el inicio
  async preloadHistory(sessionId, settings, points = 24) {
    try {
      const readings = await this.getGlucoseData(settings, points);
      readings.reverse().forEach(r => this.addToGlucoseHistory(sessionId, r));
    } catch (e) {
      this.sessions.get(sessionId)?.session?.logger?.debug?.('Preload history failed', { err: e?.message });
    }
  }

  /* ---------------- Data con fallbacks ---------------- */
  async getGlucoseData(settings, count = 1) {
    let u = settings.nightscoutUrl;
    if (!u) throw new Error('URL no configurada');
    if (!u.startsWith('http')) u = 'https://' + u;
    u = u.replace(/\/$/, '');
    const endpoints = [
      `${u}/api/v1/entries/sgv.json?count=${count}`,
      `${u}/api/v1/entries.json?count=${count}`,
      count === 1 ? `${u}/api/v1/entries/current.json` : null
    ].filter(Boolean);
    let lastError;
    for (const endpoint of endpoints) {
      try {
        console.log(`🔍 Trying endpoint: ${endpoint}`);
        const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
        const { data } = await axios.get(endpoint, {
          params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.10.0-combined' }
        });
        const arr = Array.isArray(data) ? data : (data ? [data] : []);
        if (arr.length === 0) throw new Error('Empty response');
        return arr.map(r => ({
          sgv: Number(r.sgv ?? r.glucose),
          date: typeof r.date === 'string' ? new Date(r.date).getTime() : r.date,
          direction: r.direction || r.trend || 'NONE'
        })).filter(r => Number.isFinite(r.sgv) && r.date);
      } catch (e) {
        if (e?.response?.status === 404) console.log(`⚠️ 404: ${endpoint}`);
        else if (e?.code === 'ECONNABORTED') console.log(`⏱️ Timeout: ${endpoint}`);
        else if (e?.response?.status === 401 || e?.response?.status === 403) console.warn(`❌ Auth Error: ${endpoint}`);
        else console.warn(`❌ ${endpoint} - ${e.message}`);
        lastError = e;
        continue;
      }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------------- Manejador de errores para displays ---------------- */
  handleDisplayError(session, error, settings, duration, isAlert = false) {
    const errorMsg =
      error.message.includes('URL no configurada') ? { en: `Nightscout URL not set\nCheck settings`, es: `URL de Nightscout no configurada\nRevisa ajustes` } :
      (error.message.includes('Sin datos') || error.message.includes('Empty response')) ? { en: `No glucose data available\nCheck your settings`, es: `No hay datos de glucosa\nRevisa tus ajustes` } :
      (error.message.includes('timeout') || error.message.includes('ECONNABORTED') || error.message.includes('connect') || error.message.includes('ECONNREFUSED')) ? { en: `Cannot connect to Nightscout\nCheck URL and token`, es: `No se puede conectar\nRevisa URL y token` } :
      (error.message.includes('Auth Error')) ? { en: `Invalid token or permissions\nCheck your settings`, es: `Token o permisos inválidos\nRevisa tus ajustes` } :
      { en: `Error loading glucose data\nCheck your settings`, es: `Error cargando datos\nRevisa tu configuración` };
    const msg = errorMsg[settings.language] || errorMsg.en;
    session.layouts.showTextWall(msg, { durationMs: duration });
    session.logger?.error(error, isAlert ? 'Failed to show alert' : 'Failed to show display');
  }

  /* ---------------- Display Methods ---------------- */
  async showGlucoseDisplay(session, sessionId, settings, opts = {}) {
    const { duration = null, isAlert = false, mode = 'auto' } = opts;
    const actualDuration = duration || (isAlert ? settings.alert_duration_ms : settings.display_duration_ms);
    try {
      const readings = await this.getGlucoseData(settings, 1);
      const lastReading = readings[0];
      this.addToGlucoseHistory(sessionId, lastReading);

      const history = this.glucoseHistory.get(sessionId) || [];

      // Si el usuario quiere sparkline y tenemos historial suficiente → vista combinada
      if (!isAlert && settings.enable_sparkline_display && history.length > 1 && mode !== 'textOnly') {
        try {
          const bmp = this.generateCombinedBitmap(history, lastReading, settings);
          if (bmp) {
            await session.layouts.showBitmapView(bmp, { durationMs: actualDuration });
            return;
          }
        } catch (_) { /* fallback abajo */ }
      }

      // Fallback: solo texto
      const formatted = await this.formatForG1(lastReading, settings);
      const text = `${formatted.line1}\n${formatted.line2}`;
      session.layouts.showTextWall(text, { durationMs: actualDuration });
    } catch (error) {
      this.handleDisplayError(session, error, settings, actualDuration, isAlert);
    }
  }

  async showInitialAndStart(session, sessionId, userId) {
    try {
      const settings = await this.getUserSettings(session);
      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        const msg = { en: `Please configure Nightscout\nURL and token in settings`, es: `Configura URL y token\nde Nightscout en ajustes` };
        session.layouts.showTextWall(msg[settings.language] || msg.en);
        return;
      }
      this.sessions.set(sessionId, { session, userId, settings, updateInterval: null });
      // Pre-carga historial para que la gráfica esté disponible desde el primer minuto
      await this.preloadHistory(sessionId, settings, 24);
      this.setupEventHandlers(session, sessionId);
      await this.showGlucoseDisplay(session, sessionId, settings, { mode: 'auto' });
      this.startNormalOperation(session, sessionId, settings);
    } catch (err) {
      session.layouts.showTextWall('Error starting app. Check settings.');
      session.logger?.error?.('Error in onSession', { err: err?.message });
    }
  }

  /* ---------------- Ciclo de vida de sesión ---------------- */
  async onSession(session, sessionId, userId) {
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);
    if (typeof session.updateSettingsForTesting !== 'function') {
      session.updateSettingsForTesting = async () => { session.logger?.debug?.('Compat shim: updateSettingsForTesting noop'); };
    }
    session.logger?.info('Session started', { userId, sessionId });
    await this.showInitialAndStart(session, sessionId, userId);
  }

  /* ---------------- Handlers de eventos ---------------- */
  setupEventHandlers(session, sessionId) {
    try {
      // Botón manual → misma lógica (auto: combinado si hay historial)
      session.events?.onButtonPress?.(async () => {
        const sd = this.sessions.get(sessionId);
        if (!sd) return;
        const s = sd.settings;
        await this.showGlucoseDisplay(session, sessionId, s, { mode: 'auto' });
      });

      const settingsHandler = async (settingsData) => {
        try {
          const parsedSettings = this.parseSettingsFromArray(settingsData || []);
          const sessionData = this.sessions.get(sessionId);
          if (!sessionData) return;
          const oldSettings = sessionData.settings;
          sessionData.settings = parsedSettings;
          this.sessions.set(sessionId, sessionData);
          if (oldSettings.updateInterval !== parsedSettings.updateInterval) {
            this.stopNormalOperation(sessionId);
            this.startNormalOperation(session, sessionId, parsedSettings);
          }
          if (this.alertLimitsChanged(oldSettings, parsedSettings)) {
            this.alertHistory.delete(sessionId);
            session.logger?.info('Alert limits changed, cleared alert history');
          }
          await this.persistAndEchoSettings(session, parsedSettings);
        } catch (error) {
          session.logger?.error(error, 'Failed to process settings update');
        }
      };
      session.events?.onAppSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsChange?.(settingsHandler);

      // Head-up: secuencia UP → DOWN en ≤ 2500ms
      session.events?.onHeadPosition?.(async (data) => {
        try {
          const pos = data?.position; if (pos !== 'up' && pos !== 'down') return;
          const sd = this.sessions.get(sessionId);
          const s = sd?.settings;
          if (!s?.enable_head_up_display) return;
          const now = Date.now();
          if (pos === 'up') { this.lastHeadUp.set(sessionId, now); return; }
          const lastUp = this.lastHeadUp.get(sessionId) || 0;
          if (pos === 'down' && (now - lastUp) > 2500) return;

          // Cooldown 5s
          const last = this.headUpLastShown.get(sessionId) || 0;
          if (now - last < 5000) return;
          this.headUpLastShown.set(sessionId, now);

          // Asegurar lectura reciente
          let lastReading = (this.glucoseHistory.get(sessionId) || []).slice(-1)[0];
          const ensureRecent = !lastReading ? true : (Date.now() - lastReading.date) > 10 * 60 * 1000;
          if (!lastReading || ensureRecent) {
            const r = await this.getGlucoseData(s, 1);
            if (r && r[0]) { lastReading = r[0]; this.addToGlucoseHistory(sessionId, lastReading); }
          }
          if (!lastReading) {
            session.layouts.showTextWall('No hay datos disponibles.', { durationMs: 3000 });
            return;
          }

          // Vista combinada durante dashboard_duration_ms, si posible
          const history = this.glucoseHistory.get(sessionId) || [];
          if (s?.enable_sparkline_display && history.length > 1) {
            try {
              const bmp = this.generateCombinedBitmap(history, lastReading, s);
              if (bmp) {
                await session.layouts.showBitmapView(bmp, { durationMs: s.dashboard_duration_ms });
                return;
              }
            } catch {}
          }

          // Fallback a texto si algo falla
          const f = await this.formatForG1(lastReading, s);
          await session.layouts.showTextWall(`${f.line1}\n${f.line2}`, { durationMs: s.dashboard_duration_ms });
        } catch (e) {
          session.logger?.error(e, 'Head up display failed');
          try { session.layouts.showTextWall('Error al cargar', { durationMs: 4000 }); } catch {}
        }
      });

      session.events?.onDisconnected?.(() => {
        this.stopNormalOperation(sessionId);
        this.sessions.delete(sessionId);
        this.alertHistory.delete(sessionId);
        this.headUpLastShown.delete(sessionId);
        this.glucoseHistory.delete(sessionId);
        session.logger?.info('Session disconnected');
      });
    } catch (error) {
      console.error('❌ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  async persistAndEchoSettings(session, parsedSettings) {
    try {
      await Promise.all([
        session.settings.set('low_alert_mg', parsedSettings.low_alert_mg),
        session.settings.set('high_alert_mg', parsedSettings.high_alert_mg),
        session.settings.set('low_alert_mmol', parsedSettings.low_alert_mmol),
        session.settings.set('high_alert_mmol', parsedSettings.high_alert_mmol),
        session.settings.set('update_interval', parsedSettings.updateInterval),
        session.settings.set('alerts_enabled', !!parsedSettings.alertsEnabled),
        session.settings.set('units', parsedSettings.units),
        session.settings.set('language', parsedSettings.language),
        session.settings.set('timezone', parsedSettings.timezone || ''),
        session.settings.set('enable_head_up_display', !!parsedSettings.enable_head_up_display),
        session.settings.set('enable_sparkline_display', !!parsedSettings.enable_sparkline_display),
        session.settings.set('display_duration_ms', parsedSettings.display_duration_ms),
        session.settings.set('dashboard_duration_ms', parsedSettings.dashboard_duration_ms),
        session.settings.set('alert_duration_ms', parsedSettings.alert_duration_ms)
      ]);

      const lines = ['Ajustes guardados'];
      if (parsedSettings.units === 'mmol/L') {
        lines.push(`Low: ${parsedSettings.low_alert_mmol} mmol/L`);
        lines.push(`High: ${parsedSettings.high_alert_mmol} mmol/L`);
      } else {
        lines.push(`Low: ${parsedSettings.low_alert_mg} mg/dL`);
        lines.push(`High: ${parsedSettings.high_alert_mg} mg/dL`);
      }
      lines.push(`Units: ${parsedSettings.units}`);
      lines.push(`HeadUp: ${parsedSettings.enable_head_up_display ? 'ON' : 'OFF'}`);
      lines.push(`Sparkline: ${parsedSettings.enable_sparkline_display ? 'ON' : 'OFF'}`);

      // Pausar el ciclo normal para que el eco no se pise, mostrar 4s y reanudar
      let sidForSession = null;
      for (const [sid, sd] of this.sessions) { if (sd.session === session) { sidForSession = sid; break; } }
      if (sidForSession) this.stopNormalOperation(sidForSession);
      session.layouts.showTextWall(`\n${lines.join('\n')}`, { durationMs: 4000 });
      if (sidForSession) setTimeout(() => {
        try {
          this.startNormalOperation(this.sessions.get(sidForSession).session, sidForSession, this.sessions.get(sidForSession).settings);
        } catch(_) {}
      }, 4100);
    } catch (e) {
      session.logger?.debug('Store persistence skipped/failed', { err: e?.message });
    }
  }

  /* ---------------- Bucle normal ---------------- */
  startNormalOperation(session, sessionId, settings) {
    this.stopNormalOperation(sessionId);
    const ms = (settings.updateInterval || 5) * 60 * 1000;
    const iv = setInterval(async () => {
      try {
        const sd = this.sessions.get(sessionId);
        if (!sd) return clearInterval(iv);
        const d = await this.getGlucoseData(sd.settings, 1);
        if (d && d.length > 0) {
          this.addToGlucoseHistory(sessionId, d[0]);
          if (sd.settings.alertsEnabled) await this.checkAlerts(session, sessionId, d[0], sd.settings);
          // Refresco de pantalla: usa vista combinada si hay historial
          await this.showGlucoseDisplay(session, sessionId, sd.settings, { mode: 'auto' });
        }
      } catch (error) {
        session.logger?.debug('Normal operation cycle failed', { error: error.message });
      }
    }, ms);
    const sessionData = this.sessions.get(sessionId);
    if (sessionData) {
      sessionData.updateInterval = iv;
      this.sessions.set(sessionId, sessionData);
    }
  }

  stopNormalOperation(sessionId) {
    const sessionData = this.sessions.get(sessionId);
    if (sessionData?.updateInterval) {
      clearInterval(sessionData.updateInterval);
      sessionData.updateInterval = null;
      this.sessions.set(sessionId, sessionData);
    }
  }

  /* ---------------- Alertas ---------------- */
  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const display = this.convertToDisplay(mgdl, settings.units);
    const last = this.alertHistory.get(sessionId);
    if (last && Date.now() - last < 600000) return; // 10 min
    const msgs = {
      en: { low: `LOW GLUCOSE!`, high: `HIGH GLUCOSE!` },
      es: { low: `¡GLUCOSA BAJA!`, high: `¡GLUCOSA ALTA!` }
    };
    const lang = settings.language || 'en';
    let msg = null;
    let title = null;
    if (mgdl <= limits.low) { title = msgs[lang]?.low || msgs.en.low; msg = `${display} ${settings.units}`; this.alertHistory.set(sessionId, Date.now()); }
    else if (mgdl >= limits.high) { title = msgs[lang]?.high || msgs.en.high; msg = `${display} ${settings.units}`; this.alertHistory.set(sessionId, Date.now()); }
    if (msg) {
      session.layouts.showReferenceCard(title, msg, { durationMs: settings.alert_duration_ms });
      session.logger?.warn('Alert sent', { type: mgdl <= limits.low ? 'low' : 'high', value: mgdl });
    }
  }

  /* ---------------- Tool calls (Mira) ---------------- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const isSpanish = ['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'].includes(toolId);
    const lang = isSpanish ? 'es' : 'en';
    const errorMessages = {
      en: {
        notConfigured: 'Nightscout not configured. Please set URL and token in settings.',
        connectionFailed: 'Cannot connect to Nightscout. Please check your URL and token.',
        noData: 'No glucose data available from Nightscout.',
        timeout: 'Connection timeout. Please try again later.',
        authFailed: 'Invalid token or permissions. Please check your settings.',
        generic: 'Error retrieving glucose data. Please check your configuration.'
      },
      es: {
        notConfigured: 'Nightscout no configurado. Por favor establece URL y token en ajustes.',
        connectionFailed: 'No se puede conectar a Nightscout. Verifica tu URL y token.',
        noData: 'No hay datos de glucosa disponibles desde Nightscout.',
        timeout: 'Tiempo de espera agotado. Inténtalo de nuevo más tarde.',
        authFailed: 'Token o permisos inválidos. Por favor revisa tus ajustes.',
        generic: 'Error al obtener datos de glucosa. Revisa tu configuración.'
      }
    };
    try {
      let settings = null;
      for (const [, sData] of this.sessions) {
        if (sData.userId === userId) {
          settings = sData.settings;
          break;
        }
      }
      if (!settings && data.activeSession?.settings?.settings) {
        settings = this.parseSettingsFromArray(data.activeSession.settings.settings);
      }
      if (!settings) {
        for (const [, sData] of this.sessions) {
          if (sData.userId === userId) {
            settings = await this.getUserSettings(sData.session);
            break;
          }
        }
      }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
        throw new Error(errorMessages[lang].notConfigured);
      }
      const reading = (await this.getGlucoseData(settings, 1))[0];
      const display = this.convertToDisplay(reading.sgv, settings.units);
      const trend = this.getTrendArrow(reading.direction);
      const status = this.getGlucoseStatusText(reading.sgv, settings, lang);
      const msg = lang === 'es' ? `Tu glucosa está en ${display} ${settings.units} ${trend}. Estado: ${status}.` : `Your glucose is ${display} ${settings.units} ${trend}. Status: ${status}.`;
      return { success: true, data: { glucose: display, unit: settings.units, trend, status }, message: msg };
    } catch (e) {
      let errorMsg = errorMessages[lang].generic;
      if (e.message.includes('URL no configurada') || e.message.includes('not configured')) {
        errorMsg = errorMessages[lang].notConfigured;
      } else if (e.message.includes('timeout') || e.message.includes('ECONNABORTED')) {
        errorMsg = errorMessages[lang].timeout;
      } else if (e.message.includes('Sin datos') || e.message.includes('Empty response')) {
        errorMsg = errorMessages[lang].noData;
      } else if (e.message.includes('Auth Error')) {
        errorMsg = errorMessages[lang].authFailed;
      } else if (e.message.includes('connect') || e.message.includes('ECONNREFUSED')) {
        errorMsg = errorMessages[lang].connectionFailed;
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

console.log('🚀 Nightscout MentraOS v2.10.0-combined — COMBINED VIEW + faster BMPs + robust fallbacks');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.10.0-combined',
  activeSessions: server.sessions.size,
  features: ['combined-bmp-576x135', 'sparkline', 'head-up', 'alerts', 'mg-mmol-sync', 'fallback-endpoints']
}));

setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);

module.exports = server;
