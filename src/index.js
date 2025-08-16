"use strict";
// src/index.js — Nightscout MentraOS v2.9.5-patch1
// SDK 2.1.18 — ROBUST + FALLBACK ENDPOINTS + HEAD-UP DISPLAY + MG/MMOL SYNC + SAFETY SHIMS + SPARKLINE CHARTS + CACHING (LOCAL HISTORY)

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
  LOW_MGDL: 70,    // Por debajo siempre es "Crítico Bajo" independientemente de configuración
  HIGH_MGDL: 250  // Por encima siempre es "Crítico Alto" independientemente de configuración
};

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions = new Map();
    this.alertHistory = new Map();
    this.headUpLastShown = new Map();
    this.glucoseHistory = new Map();
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

  /* ---------------- Sparkline Chart Generation ---------------- */
  // Nota: usaremos createSparkline del SDK cuando sea posible. Este generador queda como fallback experimental.
  generateSparklineBitmap(readings, settings) {
    const width = 526;
    const height = 100;
    const padding = 10;
    const chartWidth = width - (padding * 2);
    const chartHeight = height - (padding * 2);
    const bitmap = this.createBitmapCanvas(width, height);
    if (!readings || readings.length < 2) {
      return this.drawTextToBitmap(bitmap, width, height, 'Insufficient data');
    }
    const values = readings.map(r => r.sgv);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const valueRange = maxValue - minValue || 1;
    const limits = this.getAlertLimits(settings);
    this.drawAlertZones(bitmap, width, height, padding, limits, minValue, maxValue);
    for (let i = 0; i < readings.length - 1; i++) {
      const x1 = padding + (i * chartWidth / (readings.length - 1));
      const y1 = height - padding - ((readings[i].sgv - minValue) / valueRange * chartHeight);
      const x2 = padding + ((i + 1) * chartWidth / (readings.length - 1));
      const y2 = height - padding - ((readings[i + 1].sgv - minValue) / valueRange * chartHeight);
      this.drawLine(bitmap, width, height, Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2));
    }
    if (readings.length > 0) {
      const lastReading = readings[readings.length - 1];
      const x = width - padding - 5;
      const y = height - padding - ((lastReading.sgv - minValue) / valueRange * chartHeight);
      this.drawCircle(bitmap, width, height, Math.round(x), Math.round(y), 3);
    }
    return this.bitmapToBase64(bitmap, width, height);
  }

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
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    let x = x1, y = y1;
    while (true) {
      this.setPixel(bitmap, width, height, x, y, true);
      if (x === x2 && y === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  drawCircle(bitmap, width, height, cx, cy, r) {
    for (let x = -r; x <= r; x++) {
      for (let y = -r; y <= r; y++) {
        if (x * x + y * y <= r * r) this.setPixel(bitmap, width, height, cx + x, cy + y, true);
      }
    }
  }

  drawAlertZones(bitmap, width, height, padding, limits, minValue, maxValue) {
    const chartHeight = height - (padding * 2);
    const valueRange = maxValue - minValue || 1;
    if (limits.low > minValue) {
      const lowY = height - padding - ((limits.low - minValue) / valueRange * chartHeight);
      for (let y = Math.round(lowY); y < height - padding; y += 4) {
        for (let x = padding; x < width - padding; x += 8) this.setPixel(bitmap, width, height, x, y, true);
      }
    }
    if (limits.high < maxValue) {
      const highY = height - padding - ((limits.high - minValue) / valueRange * chartHeight);
      for (let y = padding; y < Math.round(highY); y += 4) {
        for (let x = padding; x < width - padding; x += 8) this.setPixel(bitmap, width, height, x, y, true);
      }
    }
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

  drawTextToBitmap(bitmap, width, height, _text) {
    const bytesPerRow = Math.ceil(width / 8);
    const blank = new Uint8Array(bytesPerRow * height).fill(0x55);
    return this.bitmapToBase64(blank, width, height);
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

  /* ---------------- utils ---------------- */
  convertToDisplay(mgdlValue, targetUnit) {
    if (targetUnit === UNITS.MMOL) return (mgdlValue / 18).toFixed(1);
    return Math.round(mgdlValue);
  }
  getTrendArrow(dir) {
    const map = {
      'DoubleUp': '⇈', 'SingleUp': '↑', 'FortyFiveUp': '↗',
      'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '↓', 'DoubleDown': '⇊',
      'NONE': '-', 'NOT COMPUTABLE': '→',
    };
    return map[dir] || '→';
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
    return `${display} ${settings.units} ${trend}\n${timeStr} (${timeAgo})`;
  }

  /* ---------------- Glucose History Management ---------------- */
  addToGlucoseHistory(sessionId, reading) {
    if (!this.glucoseHistory.has(sessionId)) {
      this.glucoseHistory.set(sessionId, []);
    }
    const history = this.glucoseHistory.get(sessionId);
    history.push({ sgv: reading.sgv, date: reading.date });
    if (history.length > 24) history.splice(0, history.length - 24);
    this.glucoseHistory.set(sessionId, history);
  }

  // ⚡ Pre-cargar historial para que haya gráfica desde el inicio
  async preloadHistory(sessionId, settings, points = 24) {
    try {
      const readings = await this.getGlucoseData(settings, points);
      // Orden de más antiguo a más reciente
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
          params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.5-patch1' }
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
      error.message.includes('URL no configurada') ? { en: 'Nightscout URL not set\nCheck settings', es: 'URL de Nightscout no configurada\nRevisa ajustes' } :
      (error.message.includes('Sin datos') || error.message.includes('Empty response')) ? { en: 'No glucose data available\nCheck your settings', es: 'No hay datos de glucosa\nRevisa tus ajustes' } :
      (error.message.includes('timeout') || error.message.includes('ECONNABORTED') || error.message.includes('connect') || error.message.includes('ECONNREFUSED')) ? { en: 'Cannot connect to Nightscout\nCheck URL and token', es: 'No se puede conectar\nRevisa URL y token' } :
      (error.message.includes('Auth Error')) ? { en: 'Invalid token or permissions\nCheck your settings', es: 'Token o permisos inválidos\nRevisa tus ajustes' } :
      { en: 'Error loading glucose data\nCheck your settings', es: 'Error cargando datos\nRevisa tu configuración' };
    const msg = errorMsg[settings.language] || errorMsg.en;
    session.layouts.showTextWall(msg, { durationMs: duration });
    session.logger?.error(error, isAlert ? 'Failed to show alert' : 'Failed to show display');
  }

  /* ---------------- Display Methods ---------------- */
  async showGlucoseDisplay(session, sessionId, settings, duration = null, isAlert = false) {
    const actualDuration = duration || (isAlert ? settings.alert_duration_ms : settings.display_duration_ms);
    try {
      const readings = await this.getGlucoseData(settings, 1);
      const lastReading = readings[0];
      this.addToGlucoseHistory(sessionId, lastReading);

      if (settings.enable_sparkline_display && !isAlert) {
        const history = this.glucoseHistory.get(sessionId) || [];
        if (history.length > 1) {
          const values = history.map(h => h.sgv);
          try {
            const sdkBmp = await session.layouts.createSparkline(values);
            session.layouts.showBitmapView(sdkBmp, { durationMs: actualDuration });
          } catch (_) {
            // Si el SDK no soporta createSparkline en este dispositivo, mostramos texto
            const formattedData = await this.formatForG1(lastReading, settings);
            session.layouts.showTextWall(formattedData, { durationMs: actualDuration });
          }
        } else {
          const formattedData = await this.formatForG1(lastReading, settings);
          session.layouts.showTextWall(formattedData, { durationMs: actualDuration });
        }
      } else {
        const formattedData = await this.formatForG1(lastReading, settings);
        session.layouts.showTextWall(formattedData, { durationMs: actualDuration });
      }
    } catch (error) {
      this.handleDisplayError(session, error, settings, actualDuration);
    }
  }

  async showInitialAndStart(session, sessionId, userId) {
    try {
      const settings = await this.getUserSettings(session);
      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        const msg = { en: 'Please configure Nightscout\nURL and token in settings', es: 'Configura URL y token\nde Nightscout en ajustes' };
        session.layouts.showTextWall(msg[settings.language] || msg.en);
        return;
      }
      this.sessions.set(sessionId, { session, userId, settings, updateInterval: null });
      // Pre-carga historial para que la gráfica esté disponible desde el primer minuto
      await this.preloadHistory(sessionId, settings, 24);
      this.setupEventHandlers(session, sessionId);
      await this.showGlucoseDisplay(session, sessionId, settings);
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
      session.events?.onButtonPress?.(async () => {
        const sd = this.sessions.get(sessionId);
        if (!sd) return;
        const s = sd.settings;
        await this.showGlucoseDisplay(session, sessionId, s);
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

      session.events?.onHeadPosition?.(async (data) => {
        try {
          if (data?.position !== 'up') return;
          const sd = this.sessions.get(sessionId);
          const s = sd?.settings;
          if (!s?.enable_head_up_display) return;
          const now = Date.now();
          const last = this.headUpLastShown.get(sessionId) || 0;
          if (now - last < 5_000) return; // cooldown más corto
          this.headUpLastShown.set(sessionId, now);

          let lastReading = (this.glucoseHistory.get(sessionId) || []).slice(-1)[0];
          if (!lastReading) {
            lastReading = (await this.getGlucoseData(s, 1))[0];
            if (lastReading) this.addToGlucoseHistory(sessionId, lastReading);
          }
          if (lastReading) {
            const text = await this.formatForG1(lastReading, s);
            session.layouts.showTextWall(`\n\n${text}`, { durationMs: s.dashboard_duration_ms });
          }
        } catch (e) {
          session.logger?.error(e, 'Head up display failed');
          try { session.layouts.showTextWall('\n\nError al cargar', { durationMs: 4000 }); } catch {}
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
      // Mostrar el eco 2s y luego limpiar para no "pisar" otras vistas
      session.layouts.showTextWall(`\n${lines.join('\n')}`, { durationMs: 2000 });
      setTimeout(() => { try { session.layouts.showTextWall(''); } catch {} }, 2100);
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
    if (mgdl <= limits.low) { title = msgs[lang]?.low || msgs.en.low; msg = `\n${display} ${settings.units}`; this.alertHistory.set(sessionId, Date.now()); }
    else if (mgdl >= limits.high) { title = msgs[lang]?.high || msgs.en.high; msg = `\n${display} ${settings.units}`; this.alertHistory.set(sessionId, Date.now()); }
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

console.log('🚀 Nightscout MentraOS v2.9.5-patch1 — ROBUST + FALLBACK + HEAD-UP + SYNC + SPARKLINE CHARTS + CACHING (LOCAL HISTORY)');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.9.5-patch1',
  activeSessions: server.sessions.size,
  features: ['sparkline', 'head-up', 'alerts', 'mg-mmol-sync', 'fallback-endpoints']
}));

setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);

module.exports = server;
