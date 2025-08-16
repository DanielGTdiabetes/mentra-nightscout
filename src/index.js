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

  /* ---------------- Tool calls (Mira) - Mejorado con traducciones ---------------- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;
    const isSpanish = ['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'].includes(toolId);
    const lang = isSpanish ? 'es' : 'en';

    const errorMessages = {
      en: {
        notConfigured: 'Nightscout not configured. Please set URL and token in settings.',
        connectionFailed: 'Cannot connect to Nightscout. Please check your URL and token.',
        noData: 'No glucose data available from Nightscout.',
        timeout: 'Connection timeout. Please try again later.',
        generic: 'Error retrieving glucose data. Please check your configuration.'
      },
      es: {
        notConfigured: 'Nightscout no configurado. Por favor establece URL y token en ajustes.',
        connectionFailed: 'No se puede conectar a Nightscout. Verifica tu URL y token.',
        noData: 'No hay datos de glucosa disponibles desde Nightscout.',
        timeout: 'Tiempo de espera agotado. Inténtalo de nuevo más tarde.',
        generic: 'Error al obtener datos de glucosa. Revisa tu configuración.'
      }
    };

    try {
      let settings = null;
      if (activeSession?.settings?.settings) {
        settings = this.parseSettingsFromArray(activeSession.settings.settings);
      } else {
        for (const [sid, sData] of this.sessions) {
          if (sData.userId === userId) { 
            settings = sData.settings || await this.getUserSettings(sData.session); 
            break; 
          }
        }
      }

      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
        throw new Error(errorMessages[lang].notConfigured);
      }

      const reading = await this.getGlucoseData(settings);
      const display = this.convertToDisplay(reading.sgv, settings.units);
      const trend = this.getTrendArrow(reading.direction);
      const status = this.getGlucoseStatusText(reading.sgv, settings, lang);

      const msg = lang === 'es'
        ? `Tu glucosa está en ${display} ${settings.units} ${trend}. Estado: ${status}.`
        : `Your glucose is ${display} ${settings.units} ${trend}. Status: ${status}.`;

      return { success: true, data: { glucose: display, unit: settings.units, trend, status }, message: msg };
    } catch (e) {
      // Traducir errores comunes
      let errorMsg = errorMessages[lang].generic;
      
      if (e.message.includes('URL no configurada') || e.message.includes('not configured')) {
        errorMsg = errorMessages[lang].notConfigured;
      } else if (e.message.includes('timeout') || e.message.includes('ECONNABORTED')) {
        errorMsg = errorMessages[lang].timeout;
      } else if (e.message.includes('Sin datos') || e.message.includes('Empty response')) {
        errorMsg = errorMessages[lang].noData;
      } else if (e.message.includes('connect') || e.message.includes('ECONNREFUSED')) {
        errorMsg = errorMessages[lang].connectionFailed;
      }

      return { success: false, error: errorMsg };
    }
  }

  getGlucoseStatusText(value, settings, lang) {
    const limits = this.getAlertLimits(settings);
    
    // Umbrales críticos de seguridad (hard-coded)
    if (value < CRITICAL_THRESHOLDS.LOW_MGDL) {
      return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
    }
    if (value > CRITICAL_THRESHOLDS.HIGH_MGDL) {
      return lang === 'es' ? 'Crítico Alto' : 'Critical High';
    }
    
    // Umbrales configurados por el usuario
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

console.log('🚀 Nightscout MentraOS v2.9.1 — ROBUST + FALLBACK + HEAD-UP + SYNC + SPARKLINE CHARTS');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.9.1',
  activeSessions: server.sessions.size,
  features: ['sparkline', 'head-up', 'alerts', 'mg-mmol-sync', 'fallback-endpoints']
}));

setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);// src/index.js — Nightscout MentraOS v2.9.1
// SDK 2.1.18 — ROBUST + FALLBACK ENDPOINTS + HEAD-UP DISPLAY + MG/MMOL SYNC + SAFETY SHIMS + SPARKLINE CHARTS

require('dotenv').config();

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

/* ---------- HARD SHIM: evita crash si el SDK invoca método inexistente ---------- */
// Mantener como PRIMER bloque del archivo.
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async function () { /* noop compat */ },
    writable: true,
    configurable: true,
    enumerable: false
  });
}
/* ------------------------------------------------------------------------------- */

const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error('❌ MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

// Umbrales críticos de seguridad (hard-coded para protección del usuario)
const CRITICAL_THRESHOLDS = {
  LOW_MGDL: 70,   // Por debajo siempre es "Crítico Bajo" independientemente de configuración
  HIGH_MGDL: 250  // Por encima siempre es "Crítico Alto" independientemente de configuración
};

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    // Usando 'sessions' para consistencia con otras versiones de la clase
    this.sessions = new Map();         // sessionId -> { session, userId, settings, updateInterval }
    this.alertHistory = new Map();     // sessionId -> timestamp
    this.displayTimers = new Map();    // sessionId -> timeoutId
    this.headUpLastShown = new Map();  // sessionId -> timestamp (cooldown)
    this.glucoseHistory = new Map();   // sessionId -> array of readings for sparkline
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
    if (settings.units === 'mmol/L') {
      return { low: Math.round(settings.low_alert_mmol * 18), high: Math.round(settings.high_alert_mmol * 18) };
    }
    return { low: Math.round(settings.low_alert_mg), high: Math.round(settings.high_alert_mg) };
  }

  /* ---------------- Sparkline Chart Generation ---------------- */
  generateSparklineBitmap(readings, settings) {
    const width = 526;
    const height = 100;
    const padding = 10;
    const chartWidth = width - (padding * 2);
    const chartHeight = height - (padding * 2);

    // Create a simple bitmap header (BMP format)
    const bitmap = this.createBitmapCanvas(width, height);
    
    if (!readings || readings.length < 2) {
      return this.drawTextToBitmap(bitmap, width, height, 'Insufficient data');
    }

    // Get min/max values for scaling
    const values = readings.map(r => r.sgv);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const valueRange = maxValue - minValue || 1;

    // Draw alert zones (background)
    const limits = this.getAlertLimits(settings);
    this.drawAlertZones(bitmap, width, height, padding, limits, minValue, maxValue);

    // Draw sparkline
    for (let i = 0; i < readings.length - 1; i++) {
      const x1 = padding + (i * chartWidth / (readings.length - 1));
      const y1 = height - padding - ((readings[i].sgv - minValue) / valueRange * chartHeight);
      const x2 = padding + ((i + 1) * chartWidth / (readings.length - 1));
      const y2 = height - padding - ((readings[i + 1].sgv - minValue) / valueRange * chartHeight);
      
      this.drawLine(bitmap, width, Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2));
    }

    // Draw current value point
    if (readings.length > 0) {
      const lastReading = readings[readings.length - 1];
      const x = width - padding - 5;
      const y = height - padding - ((lastReading.sgv - minValue) / valueRange * chartHeight);
      this.drawCircle(bitmap, width, Math.round(x), Math.round(y), 3);
    }

    return this.bitmapToHex(bitmap, width, height);
  }

  createBitmapCanvas(width, height) {
    // Create a simple monochrome bitmap array (1 bit per pixel)
    const bytesPerRow = Math.ceil(width / 8);
    const totalBytes = bytesPerRow * height;
    return new Uint8Array(totalBytes).fill(0); // Start with black background
  }

  drawLine(bitmap, width, x1, y1, x2, y2) {
    // Simple line drawing using Bresenham's algorithm
    const bytesPerRow = Math.ceil(width / 8);
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;

    let x = x1, y = y1;
    while (true) {
      this.setPixel(bitmap, width, x, y, true);
      
      if (x === x2 && y === y2) break;
      
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  drawCircle(bitmap, width, centerX, centerY, radius) {
    for (let x = -radius; x <= radius; x++) {
      for (let y = -radius; y <= radius; y++) {
        if (x * x + y * y <= radius * radius) {
          this.setPixel(bitmap, width, centerX + x, centerY + y, true);
        }
      }
    }
  }

  drawAlertZones(bitmap, width, height, padding, limits, minValue, maxValue) {
    const chartHeight = height - (padding * 2);
    const valueRange = maxValue - minValue || 1;
    
    // Low alert zone (bottom)
    if (limits.low > minValue) {
      const lowY = height - padding - ((limits.low - minValue) / valueRange * chartHeight);
      for (let y = Math.round(lowY); y < height - padding; y += 4) {
        for (let x = padding; x < width - padding; x += 8) {
          this.setPixel(bitmap, width, x, y, true);
        }
      }
    }
    
    // High alert zone (top)
    if (limits.high < maxValue) {
      const highY = height - padding - ((limits.high - minValue) / valueRange * chartHeight);
      for (let y = padding; y < Math.round(highY); y += 4) {
        for (let x = padding; x < width - padding; x += 8) {
          this.setPixel(bitmap, width, x, y, true);
        }
      }
    }
  }

  setPixel(bitmap, width, x, y, white = true) {
    if (x < 0 || x >= width || y < 0 || y >= 100) return;
    
    const bytesPerRow = Math.ceil(width / 8);
    const byteIndex = y * bytesPerRow + Math.floor(x / 8);
    const bitIndex = 7 - (x % 8);
    
    if (byteIndex >= 0 && byteIndex < bitmap.length) {
      if (white) {
        bitmap[byteIndex] |= (1 << bitIndex);
      } else {
        bitmap[byteIndex] &= ~(1 << bitIndex);
      }
    }
  }

  bitmapToHex(bitmap, width, height) {
    // Create BMP header
    const bytesPerRow = Math.ceil(width / 8);
    const imageSize = bytesPerRow * height;
    const fileSize = 62 + imageSize; // BMP header size + image data
    
    const header = new Uint8Array(62);
    const view = new DataView(header.buffer);
    
    // BMP signature
    header[0] = 0x42; // 'B'
    header[1] = 0x4D; // 'M'
    
    // File size
    view.setUint32(2, fileSize, true);
    
    // Reserved fields
    view.setUint32(6, 0, true);
    
    // Offset to pixel data
    view.setUint32(10, 62, true);
    
    // DIB header size
    view.setUint32(14, 40, true);
    
    // Image dimensions
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
    
    // Color planes
    view.setUint16(26, 1, true);
    
    // Bits per pixel (1 for monochrome)
    view.setUint16(28, 1, true);
    
    // Compression
    view.setUint32(30, 0, true);
    
    // Image size
    view.setUint32(34, imageSize, true);
    
    // Pixels per meter
    view.setInt32(38, 2835, true); // 72 DPI
    view.setInt32(42, 2835, true);
    
    // Colors used/important
    view.setUint32(46, 2, true);
    view.setUint32(50, 2, true);
    
    // Color palette (black and white)
    header[54] = 0x00; header[55] = 0x00; header[56] = 0x00; header[57] = 0x00; // Black
    header[58] = 0xFF; header[59] = 0xFF; header[60] = 0xFF; header[61] = 0x00; // White
    
    // Combine header and bitmap data
    const result = new Uint8Array(fileSize);
    result.set(header, 0);
    
    // Flip bitmap vertically (BMP format requirement)
    for (let y = 0; y < height; y++) {
      const srcOffset = y * bytesPerRow;
      const dstOffset = 62 + (height - 1 - y) * bytesPerRow;
      result.set(bitmap.subarray(srcOffset, srcOffset + bytesPerRow), dstOffset);
    }
    
    return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  drawTextToBitmap(bitmap, width, height, text) {
    // Simple text rendering - just return a basic "no data" bitmap
    return this.bitmapToHex(new Uint8Array(Math.ceil(width / 8) * height).fill(0x55), width, height);
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
        units: units || 'mg/dL',
        enable_head_up_display: (enable_head_up_display === true || enable_head_up_display === 'true' || enable_head_up_display === 1 || enable_head_up_display === '1'),
        enable_sparkline_display: (enable_sparkline_display === true || enable_sparkline_display === 'true' || enable_sparkline_display === 1 || enable_sparkline_display === '1'),
        display_duration_ms: this.validateSlicerValue(display_duration_ms, 1000, 30000, 5000),
        dashboard_duration_ms: this.validateSlicerValue(dashboard_duration_ms, 1000, 30000, 10000),
        alert_duration_ms: this.validateSlicerValue(alert_duration_ms, 5000, 60000, 15000)
      };

      // --- Normalización/coherencia entre pares (para que la UI siempre muestre equivalentes) ---
      try {
        if (result.units === 'mmol/L') {
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
        alertsEnabled: true, language: 'en', timezone: null, units: 'mg/dL',
        enable_head_up_display: false, enable_sparkline_display: false,
        display_duration_ms: 5000, dashboard_duration_ms: 10000, alert_duration_ms: 15000
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    const units = o.units || 'mg/dL';
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
    
    // Add new reading
    history.push({
      sgv: reading.sgv,
      date: reading.date,
      direction: reading.direction
    });
    
    // Keep only last 24 readings (approx 2 hours if updating every 5 minutes)
    if (history.length > 24) {
      history.splice(0, history.length - 24);
    }
    
    this.glucoseHistory.set(sessionId, history);
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
          params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.7.0' }
        });

        if (count === 1) {
          const reading = Array.isArray(data) ? data[0] : data;
          if (!reading) throw new Error('Empty response');

          const glucoseRaw = (reading.sgv ?? reading.glucose);
          const glucose = Number(glucoseRaw);
          if (!Number.isFinite(glucose)) throw new Error('No glucose data found');

          const dateValue = reading.date || reading.dateString || reading.sysTime;
          if (!dateValue) throw new Error('No date found');

          return {
            sgv: glucose,
            date: typeof dateValue === 'string' ? new Date(dateValue).getTime() : dateValue,
            direction: reading.direction || reading.trend || 'NONE'
          };
        } else {
          // Multiple readings for sparkline
          if (!Array.isArray(data) || data.length === 0) throw new Error('Empty response');
          
          return data.map(reading => ({
            sgv: Number(reading.sgv ?? reading.glucose),
            date: typeof reading.date === 'string' ? new Date(reading.date).getTime() : reading.date,
            direction: reading.direction || reading.trend || 'NONE'
          })).filter(r => Number.isFinite(r.sgv) && r.date);
        }
      } catch (error) {
        if (error?.response?.status === 404) console.log(`⚠️ 404: ${endpoint}`);
        else if (error?.code === 'ECONNABORTED') console.log(`⏱️ Timeout: ${endpoint}`);
        else console.warn(`❌ ${endpoint} - ${error.message}`);
        lastError = error;
        continue;
      }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------------- Display Methods ---------------- */
  async showGlucoseDisplay(session, sessionId, settings, duration = null, isAlert = false) {
    try {
      const actualDuration = duration || 
        (isAlert ? settings.alert_duration_ms : settings.display_duration_ms);

      if (settings.enable_sparkline_display && !isAlert) {
        // Show sparkline chart
        const readings = await this.getGlucoseData(settings, 12); // Get 12 readings for chart
        if (Array.isArray(readings) && readings.length > 1) {
          const bitmapHex = this.generateSparklineBitmap(readings, settings);
          session.layouts.showBitmapView(bitmapHex, { durationMs: actualDuration });
          
          // Add current reading to history
          this.addToGlucoseHistory(sessionId, readings[0]);
          return;
        }
      }

      // Fallback to text display
      const data = await this.getGlucoseData(settings);
      const formattedData = await this.formatForG1(data, settings);
      session.layouts.showTextWall(formattedData, { durationMs: actualDuration });
      
      // Add to history
      this.addToGlucoseHistory(sessionId, data);
      
    } catch (error) {
      const errorMsg =
        error.message.includes('URL no configurada') ? { en: 'Nightscout URL not set\nCheck settings', es: 'URL de Nightscout no configurada\nRevisa ajustes' } :
        (error.message.includes('Sin datos') || error.message.includes('timeout')) ? { en: 'Cannot connect to Nightscout\nCheck URL and token', es: 'No se puede conectar\nRevisa URL y token' } :
        { en: 'Error loading glucose data\nCheck your settings', es: 'Error cargando datos\nRevisa tu configuración' };
      const msg = errorMsg[settings.language] || errorMsg.en;
      session.layouts.showTextWall(msg, { durationMs: actualDuration });
    }
  }

  /* ---------------- Ciclo de vida de sesión ---------------- */
  async onSession(session, sessionId, userId) {
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);

    if (typeof session.updateSettingsForTesting !== 'function') {
      session.updateSettingsForTesting = async () => {
        session.logger?.debug?.('Compat shim: updateSettingsForTesting noop');
      };
    }

    session.logger?.info('Session started', { userId, sessionId });

    try {
      const settings = await this.getUserSettings(session);

      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        const msg = { en: 'Please configure Nightscout\nURL and token in settings', es: 'Configura URL y token\nde Nightscout en ajustes' };
        session.layouts.showTextWall(msg[settings.language] || msg.en);
        return;
      }
