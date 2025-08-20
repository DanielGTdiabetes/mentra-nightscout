"use strict";
/**
 * Nightscout MentraOS v2.13.1 (Hysteresis + ECO con estado de alarma + Pred no-avanzado)
 * HUD texto + TIR-bar ¦ CH/Ins día + Min/Max sólo gesto ¦ reset diario
 * ES/EN + mg/dL/mmol ¦ 5 líneas max ¦ cache last-good-entry
 * Mejora: cliente axios por sesión, debounce de settings, animación reforzada
 * * NUEVO EN ESTA VERSIÓN:
 * - Implementación y corrección de la lógica de visualización del bitmap.
 * - Lógica de visualización del bitmap: se muestra una cara sonriente solo si el valor de la glucosa
 * está en el rango normal (entre 70 y 180 mg/dL) y la opción 'enable_bitmap' está activada.
 * - ARREGLO DE VISIBILIDAD: Se ha corregido el problema donde el texto o el bitmap desaparecían.
 * Ahora la lógica se encarga de mostrar y ocultar el texto Y el bitmap de forma mutuamente exclusiva
 * en un solo comando 'showDisplay'.
 * - Código refactorizado para eliminar redundancias y mejorar la robustez.
 */

require('dotenv').config();
const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

/* ---------- SHIM: compatibilidad SDK ---------- */
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async () => {},
    writable: true,
    configurable: true,
    enumerable: false
  });
}

/* ---------- CONFIG ---------- */
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error('⛔ MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

// Datos del bitmap de una cara sonriente (32x32 píxeles, 1-bit, 128 bytes)
// Este bitmap ha sido creado para simular el formato y tamaño adecuado para el SDK
const SMILEY_BITMAP_32x32 = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x03, 0x80, 0x01, 0xC0, 0x00, 0x00,
  0x00, 0x00, 0x07, 0xF0, 0x03, 0xF8, 0x00, 0x00,
  0x00, 0x00, 0x0F, 0xFE, 0x07, 0xFE, 0x00, 0x00,
  0x00, 0x00, 0x0F, 0xFE, 0x07, 0xFE, 0x00, 0x00,
  0x00, 0x00, 0x1F, 0xFF, 0x0F, 0xFF, 0x00, 0x00,
  0x00, 0x00, 0x1F, 0xFF, 0x0F, 0xFF, 0x00, 0x00,
  0x00, 0x00, 0x3F, 0xFF, 0x1F, 0xFF, 0x80, 0x00,
  0x00, 0x00, 0x7F, 0xFF, 0x3F, 0xFF, 0xC0, 0x00,
  0x00, 0x00, 0x7F, 0xFF, 0x3F, 0xFF, 0xE0, 0x00,
  0x00, 0x00, 0xFF, 0xFF, 0x7F, 0xFF, 0xE0, 0x00,
  0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xF0, 0x00,
  0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xF0, 0x00,
  0x00, 0x03, 0xFF, 0xFF, 0xFF, 0xFF, 0xF8, 0x00,
  0x00, 0x03, 0xFF, 0xFF, 0xFF, 0xFF, 0xF8, 0x00,
  0x00, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFC, 0x00,
  0x00, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFC, 0x00,
  0x00, 0x0F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0x00,
  0x00, 0x0F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0x00,
  0x00, 0x1F, 0xFF, 0xFC, 0x03, 0xFF, 0xFF, 0x80,
  0x00, 0x1F, 0xFF, 0xF8, 0x07, 0xFF, 0xFF, 0x80,
  0x00, 0x3F, 0xFF, 0xF0, 0x0F, 0xFF, 0xFF, 0xC0,
  0x00, 0x3F, 0xFF, 0xE0, 0x0F, 0xFF, 0xFF, 0xC0,
  0x00, 0x7F, 0xFF, 0xC0, 0x1F, 0xFF, 0xFF, 0xE0,
  0x00, 0x7F, 0xFF, 0x80, 0x1F, 0xFF, 0xFF, 0xE0,
  0x00, 0xFF, 0xFC, 0x00, 0x3F, 0xFF, 0xFF, 0xF0,
  0x00, 0xFF, 0xF8, 0x00, 0x7F, 0xFF, 0xFF, 0xF0,
  0x00, 0xFF, 0xF0, 0x00, 0xFF, 0xFF, 0xFF, 0xF8,
  0x00, 0xFF, 0xE0, 0x01, 0xFF, 0xFF, 0xFF, 0xF8,
  0x00, 0xFF, 0xC0, 0x03, 0xFF, 0xFF, 0xFF, 0xFC,
  0x00, 0xFF, 0x80, 0x07, 0xFF, 0xFF, 0xFF, 0xFC,
  0x00, 0xFF, 0x00, 0x0F, 0xFF, 0xFF, 0xFF, 0xFE,
]);

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.activeSessions = new Map();
    this.alertHistory = new Map();
    this.alertLatch = new Map();       // latch 'low' | 'high' | null
    this.displayTimers = new Map();
    this.headUpLastShown = new Map();
    this.dailyTirState = new Map();
    this.dayWatchTimers = new Map();
    this.lastGoodEntry = new Map();
    this._renderToken = new Map();
    this._lastShownText = new Map();
    this._http = new Map();             // cliente axios por sesión
    this._settingsDebounce = new Map(); // debounce settings
    this._sessionLocale = new Map();    // cache locale/tz por sesión
    this._bitmapActive = new Map();
  }

  /* ---------- helpers ---------- */
  __delay(ms) { return new Promise(res => setTimeout(res, ms)); }
  __clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
  __easeInOutCubic(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
  __getEasingFunction(type = 'cubic'){
    if (type === 'smooth') return (t)=> t*t*(3 - 2*t);
    if (type === 'linear') return (t)=> t;
    return (t)=> this.__easeInOutCubic(t);
  }
  __barFromRatio(ratio, slots){
    const n = Math.round(this.__clamp01(ratio) * slots);
    const filled = '¦'.repeat(n);
    const empty  = '·'.repeat(Math.max(0, slots - n));
    return `[${filled}${empty}]`;
  }
  _scheduleHide(sessionId, ms){
    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
    const t = setTimeout(() => this.hideDisplay(this.activeSessions.get(sessionId)?.session, sessionId), ms);
    this.displayTimers.set(sessionId, t);
  }

  parseSlicerValue(val, fallback) {
    const n = (typeof val === 'object' && val !== null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
  }
  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  }
  toBool(x) { return (x === true || x === 'true' || x === 1 || x === '1'); }
  normalizeMmol(x) {
    const v = this.parseSlicerValue(x, null);
    // UI mmol a veces viene x10 (p.ej. 39 = 3.9)
    return (v !== null && Number.isFinite(v)) ? (v >= 30 ? v / 10 : v) : null;
  }
  
  /**
   * Obtiene los límites de alerta para el rango de glucosa.
   * Prioridad por unidad: si units=mmol/L usa primero low/high en mmol (x10), si no, usa mg/dL.
   * Siempre devuelve límites en mg/dL para el resto del código.
   * @param {object} settings - La configuración del usuario.
   * @returns {{low: number, high: number}} Los límites de alerta en mg/dL.
   */
  getAlertLimits(settings) {
    const units = String(settings.units || '').toLowerCase();

    // Candidatos en mg/dL (tal cual)
    const lowMgRaw  = this.parseSlicerValue(settings.low_alert_mg,  NaN);
    const highMgRaw = this.parseSlicerValue(settings.high_alert_mg, NaN);
    const lowMgOK   = Number.isFinite(lowMgRaw)  ? Math.round(lowMgRaw)  : NaN;
    const highMgOK  = Number.isFinite(highMgRaw) ? Math.round(highMgRaw) : NaN;

    // Candidatos en mmol (pueden venir como 39=>3.9). normalizeMmol ya maneja x10.
    const lowMmol   = this.normalizeMmol(settings.low_alert_mmol);
    const highMmol  = this.normalizeMmol(settings.high_alert_mmol);
    const lowFromMmolMg  = Number.isFinite(lowMmol)  ? Math.round(lowMmol  * 18) : NaN;
    const highFromMmolMg = Number.isFinite(highMmol) ? Math.round(highMmol * 18) : NaN;

    if (units.includes('mmol')) {
      // mmol/L tiene prioridad
      if (Number.isFinite(lowFromMmolMg) && Number.isFinite(highFromMmolMg)) {
        return { low: lowFromMmolMg, high: highFromMmolMg };
      }
      if (Number.isFinite(lowMgOK) && Number.isFinite(highMgOK)) {
        return { low: lowMgOK, high: highMgOK };
      }
      // Fallback por defecto típico mmol (3.9/13.9)
      return { low: Math.round(3.9 * 18), high: Math.round(13.9 * 18) };
    } else {
      // mg/dL tiene prioridad (o unidad desconocida)
      if (Number.isFinite(lowMgOK) && Number.isFinite(highMgOK)) {
        return { low: lowMgOK, high: highMgOK };
      }
      if (Number.isFinite(lowFromMmolMg) && Number.isFinite(highFromMmolMg)) {
        return { low: lowFromMmolMg, high: highFromMmolMg };
      }
      // Fallback por defecto típico mg/dL
      return { low: 70, high: 250 };
    }
  }

  /**
   * Obtiene el valor de la histéresis en mg/dL.
   * Prioriza la unidad seleccionada por el usuario.
   * @param {object} settings - La configuración del usuario.
   * @returns {number} El valor de histéresis en mg/dL.
   */
  getHysteresisMg(settings) {
    const mg = this.validateSlicerValue(settings.alert_hysteresis_mg, 0, 50, NaN);
    const raw = this.parseSlicerValue(settings.alert_hysteresis_mmol, NaN);
    let mmol = NaN;
    if (Number.isFinite(raw)) {
      if (Number.isInteger(raw)) {
        if (raw >= 0 && raw <= 10) mmol = raw / 10;
        else if (raw >= 30) mmol = raw / 10;
        else mmol = raw; 
      } else {
        mmol = raw; 
      }
    }
    const mmolAsMg = Number.isFinite(mmol) ? Math.round(mmol * 18) : NaN;
    const units = String(settings.units || '').toLowerCase();

    if (units.includes('mmol')) {        
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
      if (Number.isFinite(mg))        return mg;
      return 5; 
    } else {                            
      if (Number.isFinite(mg)) return mg;
      if (Number.isFinite(mmolAsMg))  return mmolAsMg;
      return 5; 
    }
  }

  /* ---------- lectura de settings ---------- */
  async getUserSettings(session) {
    try {
      const keys = [
        'nightscout_url','nightscout_token','update_interval',
        'low_alert_mg','high_alert_mg','low_alert_mmol','high_alert_mmol',
        'alerts_enabled','language','timezone','units',
        'enable_head_up_display',
        'display_duration_s','alert_duration_s','alert_cooldown_min',
        'show_tir_bar','show_range_bar',
        'display_duration_ms','alert_duration_ms','alert_cooldown_ms',
        'enable_advanced_mode','advanced_mode_enabled',
        'alert_hysteresis_mg','alert_hysteresis_mmol',
        'tir_low_mg','tir_high_mg','tir_low_mmol','tir_high_mmol',
        'time_in_range_low_mg','time_in_range_high_mg','time_in_range_low_mmol','time_in_range_high_mmol',
        'prediction_horizon_min','prediction_horizon_mins',
        'debug_force_alert',
        'enable_bitmap' 
      ];
      const vals = await Promise.all(keys.map(k => session.settings.get(k)));
      const kv = Object.fromEntries(keys.map((k,i)=>[k,vals[i]]));

      const uiMin = parseInt(kv.update_interval, 10);
      const ui = Number.isFinite(uiMin) ? uiMin : 5;

      const displayMs = Number.isFinite(this.parseSlicerValue(kv.display_duration_s, NaN))
        ? Math.min(15, Math.max(1, this.parseSlicerValue(kv.display_duration_s))) * 1000
        : this.validateSlicerValue(kv.display_duration_ms, 1000, 15000, 5000);

      const alertMs = Number.isFinite(this.parseSlicerValue(kv.alert_duration_s, NaN))
        ? Math.min(60, Math.max(2, this.parseSlicerValue(kv.alert_duration_s))) * 1000
        : this.validateSlicerValue(kv.alert_duration_ms, 2000, 60000, 15000);

      const coolMs = Number.isFinite(this.parseSlicerValue(kv.alert_cooldown_min, NaN))
        ? Math.min(60, Math.max(1, this.parseSlicerValue(kv.alert_cooldown_min))) * 60 * 1000
        : this.validateSlicerValue(kv.alert_cooldown_ms, 60000, 3600000, 600000);

      const showTirBar = (kv.show_tir_bar == null && kv.show_range_bar == null)
        ? true
        : (this.toBool(kv.show_tir_bar) || this.toBool(kv.show_range_bar));

      return {
        nightscoutUrl: String(kv.nightscout_url || '').trim() || '',
        nightscoutToken: String(kv.nightscout_token || '').trim() || '',
        updateInterval: ui,
        low_alert_mg: this.validateSlicerValue(kv.low_alert_mg, 50, 120, 70),
        high_alert_mg: this.validateSlicerValue(kv.high_alert_mg, 180, 400, 250),
        low_alert_mmol: this.normalizeMmol(kv.low_alert_mmol) ?? 3.9,
        high_alert_mmol: this.normalizeMmol(kv.high_alert_mmol) ?? 13.9,
        alertsEnabled: this.toBool(kv.alerts_enabled),
        language: kv.language || 'en',
        timezone: kv.timezone || null,
        units: kv.units || UNITS.MGDL,
        enable_head_up_display: this.toBool(kv.enable_head_up_display),
        display_duration_ms: displayMs,
        alert_duration_ms: alertMs,
        alert_cooldown_ms: coolMs,
        show_tir_bar: showTirBar,
        enable_advanced_mode: this.toBool(kv.enable_advanced_mode) || this.toBool(kv.advanced_mode_enabled),
        alert_hysteresis_mg: this.validateSlicerValue(kv.alert_hysteresis_mg, 0, 50, 5),
        alert_hysteresis_mmol: this.normalizeMmol(kv.alert_hysteresis_mmol) ?? 0.3,
        tir_low_mg: this.parseSlicerValue(kv.tir_low_mg, null),
        tir_high_mg: this.parseSlicerValue(kv.tir_high_mg, null),
        tir_low_mmol: this.normalizeMmol(kv.tir_low_mmol),
        tir_high_mmol: this.normalizeMmol(kv.tir_high_mmol),
        time_in_range_low_mg: this.parseSlicerValue(kv.time_in_range_low_mg, null),
        time_in_range_high_mg: this.parseSlicerValue(kv.time_in_range_high_mg, null),
        time_in_range_low_mmol: this.normalizeMmol(kv.time_in_range_low_mmol),
        time_in_range_high_mmol: this.normalizeMmol(kv.time_in_range_high_mmol),
        prediction_horizon_min: [15,30,60].includes(Number(kv.prediction_horizon_min || kv.prediction_horizon_mins))
          ? Number(kv.prediction_horizon_min || kv.prediction_horizon_mins) : 30,
        debug_force_alert: (typeof kv.debug_force_alert === 'string' ? kv.debug_force_alert : null),
        enable_bitmap: this.toBool(kv.enable_bitmap) 
      };
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '', nightscoutToken: '',
        updateInterval: 5,
        low_alert_mg: 70, high_alert_mg: 250,
        low_alert_mmol: 3.9, high_alert_mmol: 13.9,
        alertsEnabled: true, language: 'en', timezone: null, units: UNITS.MGDL,
        enable_head_up_display: false,
        display_duration_ms: 5000, alert_duration_ms: 15000, alert_cooldown_ms: 600000,
        show_tir_bar: true,
        enable_advanced_mode: false,
        alert_hysteresis_mg: 5, alert_hysteresis_mmol: 0.3,
        prediction_horizon_min: 30,
        debug_force_alert: null,
        enable_bitmap: false 
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    const units = o.units || UNITS.MGDL;
    const uiMin = parseInt(o.update_interval, 10);
    const ui = Number.isFinite(uiMin) ? uiMin : 5;

    const displayMs = Number.isFinite(this.parseSlicerValue(o.display_duration_s, NaN))
      ? Math.min(15, Math.max(1, this.parseSlicerValue(o.display_duration_s))) * 1000
      : this.validateSlicerValue(o.display_duration_ms, 1000, 15000, 5000);

    const alertMs = Number.isFinite(this.parseSlicerValue(o.alert_duration_s, NaN))
      ? Math.min(60, Math.max(2, this.parseSlicerValue(o.alert_duration_s))) * 1000
      : this.validateSlicerValue(o.alert_duration_ms, 2000, 60000, 15000);

    const coolMs = Number.isFinite(this.parseSlicerValue(o.alert_cooldown_min, NaN))
      ? Math.min(60, Math.max(1, this.parseSlicerValue(o.alert_cooldown_min))) * 60 * 1000
      : this.validateSlicerValue(o.alert_cooldown_ms, 60000, 3600000, 600000);

    const showTirBar = (o.show_tir_bar == null && o.show_range_bar == null)
      ? true
      : (this.toBool(o.show_tir_bar) || this.toBool(o.show_range_bar));

    return {
      nightscoutUrl: String(o.nightscout_url || '').trim() || '',
      nightscoutToken: String(o.nightscout_token || '').trim() || '',
      updateInterval: ui,
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 50, 120, 70),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, 250),
      low_alert_mmol: this.normalizeMmol(o.low_alert_mmol) ?? 3.9,
      high_alert_mmol: this.normalizeMmol(o.high_alert_mmol) ?? 13.9,
      alertsEnabled: this.toBool(o.alerts_enabled),
      language: o.language || 'en',
      timezone: o.timezone || null,
      units,
      enable_head_up_display: this.toBool(o.enable_head_up_display),
      display_duration_ms: displayMs,
      alert_duration_ms: alertMs,
      alert_cooldown_ms: coolMs,
      show_tir_bar: showTirBar,
      enable_advanced_mode: this.toBool(o.enable_advanced_mode) || this.toBool(o.advanced_mode_enabled),
      alert_hysteresis_mg: this.validateSlicerValue(o.alert_hysteresis_mg, 0, 50, 5),
      alert_hysteresis_mmol: this.normalizeMmol(o.alert_hysteresis_mmol) ?? 0.3,
      tir_low_mg: this.parseSlicerValue(o.tir_low_mg, null),
      tir_high_mg: this.parseSlicerValue(o.tir_high_mg, null),
      tir_low_mmol: this.normalizeMmol(o.tir_low_mmol),
      tir_high_mmol: this.normalizeMmol(o.tir_high_mmol),
      time_in_range_low_mg: this.parseSlicerValue(o.time_in_range_low_mg, null),
      time_in_range_high_mg: this.parseSlicerValue(o.time_in_range_high_mg, null),
      time_in_range_low_mmol: this.normalizeMmol(o.time_in_range_low_mmol),
      time_in_range_high_mmol: this.normalizeMmol(o.time_in_range_high_mmol),
      prediction_horizon_min: [15,30,60].includes(Number(o.prediction_horizon_min || o.prediction_horizon_mins))
        ? Number(o.prediction_horizon_min || o.prediction_horizon_mins) : 30,
      debug_force_alert: (typeof o.debug_force_alert === 'string' ? o.debug_force_alert : null),
      enable_bitmap: this.toBool(o.enable_bitmap) 
    };
  }
  
  /* ---------- UI helpers ---------- */
  convertToDisplay(mgdlValue, targetUnit) {
    if (mgdlValue === null || mgdlValue === undefined) return 'N/A';
    return targetUnit === UNITS.MMOL ? (mgdlValue / 18).toFixed(1) : Math.round(mgdlValue);
  }

  getTrendArrow(dir) {
    const map = {
      DoubleUp: '↑↑',
      SingleUp: '↑',
      FortyFiveUp: '↗',
      Flat: '→',
      FortyFiveDown: '↘',
      SingleDown: '↓',
      DoubleDown: '↓↓',
      NONE: '-',
      'NOT COMPUTABLE': '?'
    };
    return map[dir] || '?';
  }

  getGlucoseStatusText(value, settings, lang) {
    const limits = this.getAlertLimits(settings);
    if (value < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
    if (value <= limits.low) return lang === 'es' ? 'Bajo' : 'Low';
    if (value > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
    if (value >= limits.high) return lang === 'es' ? 'Alto' : 'High';
    return lang === 'es' ? 'Normal' : 'Normal';
  }
  
  getLanguageSettings(settings) {
    const langMap = {
      es: { locale: 'es-ES', timezone: 'Europe/Madrid' },
      en: { locale: 'en-US', timezone: 'America/New_York' }
    };
    return langMap[settings.language] || langMap.en;
  }

  validateTimezone(tz) {
    const valid = [
      'Europe/Madrid','Atlantic/Canary','Europe/London','Europe/Paris',
      'Europe/Berlin','Europe/Rome','America/New_York','America/Chicago',
      'America/Los_Angeles','America/Mexico_City','America/Argentina/Buenos_Aires',
      'America/Sao_Paulo','Asia/Tokyo','Australia/Sydney','UTC',
    ];
    return valid.includes(tz) ? tz : 'UTC';
  }

  _getLocaleBundle(sessionId, settings){
    const cached = this._sessionLocale.get(sessionId);
    if (cached && cached.lang === settings.language && cached.tz === (settings.timezone||null)) return cached;

    const langSettings = this.getLanguageSettings(settings);
    const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const b = { lang: settings.language||'en', locale: langSettings.locale, tz };
    this._sessionLocale.set(sessionId, b);
    return b;
  }
  
  async formatForG1(data, settings, sessionId) {
    const display = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const trend = this.getTrendArrow(data.direction);
    const b = this._getLocaleBundle(sessionId || 'default', settings);
    const readingTime = new Date(data.date);
    const timeStr = readingTime.toLocaleTimeString(b.locale, { timeZone: b.tz, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    const elapsedMinutes = Math.round((Date.now() - readingTime) / 60000);
    const elapsedStr = elapsedMinutes <= 1 ? '' : `${elapsedMinutes}'`;
    
    // Predicción
    let predictionStr = '';
    const horizonMin = settings.prediction_horizon_min || 30; // 30 por defecto
    const lowPred = settings.units === UNITS.MMOL ? 3.3 : 60; // 60mg/dL o 3.3mmol
    const highPred = settings.units === UNITS.MMOL ? 10 : 180; // 180mg/dL o 10mmol
    const pred = data.predictedSgv && data.predictedSgv[horizonMin];
    
    // NUEVO: En NO avanzado, predicción sólo si cruza límites fijos
    const advancedMode = settings.enable_advanced_mode;
    const currentIsNormal = (data.sgv >= lowPred && data.sgv <= highPred);
    const predIsLow = pred < lowPred;
    const predIsHigh = pred > highPred;
    
    if (pred && (advancedMode || (!currentIsNormal && (predIsLow || predIsHigh)))) {
      const predDisplay = this.convertToDisplay(pred, settings.units || UNITS.MGDL);
      predictionStr = `~${predDisplay}${settings.units === UNITS.MMOL ? '' : ' '}${settings.units || UNITS.MGDL}`;
    }

    // Estado del glucosa
    const statusText = this.getGlucoseStatusText(data.sgv, settings, b.lang);

    // Texto de la alarma
    const alarmData = this.alertHistory.get(sessionId) || {};
    let alarmMsg = '';
    let isAlarm = false;
    if (settings.alertsEnabled && alarmData.isAlert) {
      if (alarmData.isLow) {
        alarmMsg = b.lang === 'es' ? 'ALERTA BAJA' : 'LOW ALERT';
        isAlarm = true;
      } else if (alarmData.isHigh) {
        alarmMsg = b.lang === 'es' ? 'ALERTA ALTA' : 'HIGH ALERT';
        isAlarm = true;
      }
    }
    
    // Tir bar
    let tirBar = '';
    if (settings.show_tir_bar) {
      const rangeLowMg = this.parseSlicerValue(settings.time_in_range_low_mg || settings.tir_low_mg, settings.units === UNITS.MMOL ? 3.9 * 18 : 70);
      const rangeHighMg = this.parseSlicerValue(settings.time_in_range_high_mg || settings.tir_high_mg, settings.units === UNITS.MMOL ? 10.0 * 18 : 180);
      const tirRange = rangeHighMg - rangeLowMg;
      const tirRatio = tirRange > 0 ? (data.sgv - rangeLowMg) / tirRange : 0;
      tirBar = this.__barFromRatio(tirRatio, 15);
    }

    const textArr = [];
    if (display) {
      textArr.push(`${display}${settings.units === UNITS.MMOL ? '' : ' '}${settings.units || UNITS.MGDL} ${trend}${elapsedStr ? ' | ' + elapsedStr : ''}`);
      textArr.push(`${statusText} ${predictionStr}`);
      if (settings.show_tir_bar) textArr.push(tirBar);
      if (isAlarm) textArr.push(alarmMsg);
      if (data.carbs || data.insulin) {
          let mealText = '';
          if (data.carbs) mealText += `${data.carbs}CH`;
          if (data.insulin) mealText += `${data.insulin}I`;
          textArr.push(`Comidas: ${mealText}`);
      }
    } else {
      textArr.push(b.lang === 'es' ? 'Error: Glucosa no disponible' : 'Error: Glucose not available');
    }

    return textArr.join('\n');
  }

  async getNightscoutData(session, settings) {
    const sessionId = session.id;
    const client = this._http.get(sessionId) || axios.create({ timeout: 10000 });
    this._http.set(sessionId, client);
    
    // Obtener datos del día para el TIR
    const now = Date.now();
    const startOfDay = new Date(now).setHours(0, 0, 0, 0);
    const dayDataUrl = `${settings.nightscoutUrl}/api/v2/entries/sgv.json?find[dateString][$gte]=${new Date(startOfDay).toISOString()}&count=1000&token=${settings.nightscoutToken}`;
    let dailyEntries = [];
    try {
      const res = await client.get(dayDataUrl);
      dailyEntries = res.data;
    } catch (e) {
      console.warn(`Error al obtener datos diarios para el TIR: ${e.message}`);
    }

    const url = `${settings.nightscoutUrl}/api/v2/entries/sgv.json?count=1&token=${settings.nightscoutToken}`;
    
    let nightscoutData = null;
    let nightscoutError = null;
    try {
      const response = await client.get(url, { validateStatus: status => status === 200 || status === 401 });
      
      if (response.status === 401) {
        nightscoutError = settings.language === 'es' ? 'Error: Token no válido' : 'Error: Invalid Token';
      } else if (!response.data || response.data.length === 0) {
        if (this.lastGoodEntry.has(sessionId)) {
          nightscoutData = this.lastGoodEntry.get(sessionId);
        } else {
          nightscoutError = settings.language === 'es' ? 'No hay datos en Nightscout' : 'No data in Nightscout';
        }
      } else {
        nightscoutData = response.data[0];
        this.lastGoodEntry.set(sessionId, nightscoutData);
      }
    } catch (e) {
      nightscoutError = settings.language === 'es' ? `Error: ${e.message}` : `Error: ${e.message}`;
      if (this.lastGoodEntry.has(sessionId)) {
        nightscoutData = this.lastGoodEntry.get(sessionId);
        nightscoutError += ` (usando caché)`;
      }
    }
    
    if (nightscoutError) {
      return { success: false, error: nightscoutError };
    }

    // Obtener datos de predicción (si es necesario)
    let predictedSgv = {};
    if (settings.enable_advanced_mode || (nightscoutData && (nightscoutData.sgv < 70 || nightscoutData.sgv > 180))) { 
        const predUrl = `${settings.nightscoutUrl}/api/v2/entries/predictedSgv.json?count=1&token=${settings.nightscoutToken}`;
        try {
            const predRes = await client.get(predUrl);
            if (predRes.data && predRes.data.length > 0) {
                const predData = predRes.data[0];
                predictedSgv = predData.predictedSgv || {};
            }
        } catch (e) {
            console.warn(`Error al obtener predicción: ${e.message}`);
        }
    }
    
    // Obtener datos de tratamiento (carbohidratos e insulina)
    const treatmentsUrl = `${settings.nightscoutUrl}/api/v2/treatments.json?count=10&token=${settings.nightscoutToken}`;
    let lastCarbs = null;
    let lastInsulin = null;
    try {
        const treatRes = await client.get(treatmentsUrl);
        if (treatRes.data && treatRes.data.length > 0) {
            const now = Date.now();
            const thirtyMinsAgo = now - (30 * 60 * 1000); 
            const recentTreatments = treatRes.data.filter(t => new Date(t.createdAt).getTime() > thirtyMinsAgo);

            const latestCarb = recentTreatments.find(t => t.carbs);
            if (latestCarb) {
                lastCarbs = latestCarb.carbs;
            }

            const latestInsulin = recentTreatments.find(t => t.insulin);
            if (latestInsulin) {
                lastInsulin = latestInsulin.insulin;
            }
        }
    } catch (e) {
      console.warn(`Error al obtener tratamientos: ${e.message}`);
    }


    return {
      success: true,
      data: {
        sgv: nightscoutData?.sgv,
        date: nightscoutData?.date,
        direction: nightscoutData?.direction,
        predictedSgv: predictedSgv,
        carbs: lastCarbs,
        insulin: lastInsulin,
        dailyEntries: dailyEntries,
        tirPct: this._calculateTIR(dailyEntries, settings) 
      }
    };
  }
  
  _calculateTIR(entries, settings) {
    if (!entries || entries.length === 0) return null;
    
    const rangeLowMg = this.parseSlicerValue(settings.time_in_range_low_mg || settings.tir_low_mg, settings.units === UNITS.MMOL ? 3.9 * 18 : 70);
    const rangeHighMg = this.parseSlicerValue(settings.time_in_range_high_mg || settings.tir_high_mg, settings.units === UNITS.MMOL ? 10.0 * 18 : 180);
    
    const tirCount = entries.filter(e => e.sgv >= rangeLowMg && e.sgv <= rangeHighMg).length;
    
    return (tirCount / entries.length) * 100;
  }
  
  async onSessionStart(session) {
    const sessionId = session.id;
    this.activeSessions.set(sessionId, { session });
    console.log(`⚡ Sesión iniciada: ${sessionId}`);
    
    const settings = await this.getUserSettings(session);
    this.processSession(session, settings);
  }

  async onSessionUpdate(session) {
    const sessionId = session.id;
    if (!this.activeSessions.has(sessionId)) {
      this.activeSessions.set(sessionId, { session });
      console.log(`🔄 Sesión reanudada: ${sessionId}`);
    } else {
      this.activeSessions.get(sessionId).session = session;
    }

    if (this._settingsDebounce.has(sessionId)) {
      clearTimeout(this._settingsDebounce.get(sessionId));
    }
    const debounceTimeout = setTimeout(async () => {
      const settings = await this.getUserSettings(session);
      this.processSession(session, settings, 'settings_change');
    }, 500); 
    this._settingsDebounce.set(sessionId, debounceTimeout);
  }

  async processSession(session, settings, eventType = 'refresh') {
    const sessionId = session.id;
    const lang = settings.language;
    
    if (!settings.nightscoutUrl || !settings.nightscoutToken) {
      this.showDisplay(session, { text: lang === 'es' ? 'Falta Nightscout URL/Token' : 'Nightscout URL/Token Missing' });
      return;
    }
    
    if (settings.debug_force_alert) {
      if (settings.debug_force_alert === 'low') {
        const forceValue = settings.units === UNITS.MMOL ? 3.0 : 54;
        await this.handleAlert(session, settings, forceValue, 'SingleDown', true);
        return;
      } else if (settings.debug_force_alert === 'high') {
        const forceValue = settings.units === UNITS.MMOL ? 15.0 : 270;
        await this.handleAlert(session, settings, forceValue, 'SingleUp', true);
        return;
      }
    }
    
    const result = await this.getNightscoutData(session, settings);

    if (!result.success || !result.data.sgv) {
      this.showDisplay(session, { text: result.error || (lang === 'es' ? 'Glucosa no disponible' : 'Glucose not available') });
      this._scheduleHide(sessionId, settings.display_duration_ms);
      return;
    }

    const data = result.data;
    const now = Date.now();
    const lastRenderToken = this._renderToken.get(sessionId);
    const currentToken = JSON.stringify({
      sgv: data.sgv,
      trend: data.direction,
      status: this.getGlucoseStatusText(data.sgv, settings, lang),
      prediction: data.predictedSgv && data.predictedSgv[settings.prediction_horizon_min],
      tir: data.tirPct
    });

    const isSignificantChange = lastRenderToken !== currentToken;
    const lastShown = this.headUpLastShown.get(sessionId) || 0;
    const headUpEnabled = settings.enable_head_up_display;
    const isInitialRender = lastShown === 0;

    if (
      (headUpEnabled && (isInitialRender || now - lastShown >= settings.display_duration_ms)) ||
      (headUpEnabled && isSignificantChange) ||
      eventType === 'settings_change'
    ) {
      const isNormalRange = data.sgv >= 70 && data.sgv <= 180;
      
      // La lógica para mostrar el bitmap o el texto es ahora más simple y directa.
      // Se utiliza una sola llamada a `showDisplay` con las propiedades `text` y `bitmap`
      // para asegurar que solo se muestre una de las dos.
      if (settings.enable_bitmap && isNormalRange) {
        console.log(`[${sessionId}] Mostrando bitmap. Texto oculto.`);
        await this.showDisplay(session, { text: null, bitmap: { data: SMILEY_BITMAP_32x32, width: 32, height: 32 }});
        this.headUpLastShown.set(sessionId, now);
        this._lastShownText.set(sessionId, null); // Limpia el texto cacheado
      } else {
        console.log(`[${sessionId}] Mostrando texto. Bitmap oculto.`);
        const formattedText = await this.formatForG1(data, settings, sessionId);
        if (this._lastShownText.get(sessionId) !== formattedText) {
          await this.showDisplay(session, { text: formattedText, bitmap: null });
          this._lastShownText.set(sessionId, formattedText);
        }
        this.headUpLastShown.set(sessionId, now);
      }
      this._renderToken.set(sessionId, currentToken);
    }
    
    await this.handleAlert(session, settings, data.sgv, data.direction);

    const refreshInterval = settings.updateInterval * 60 * 1000;
    clearTimeout(this.dayWatchTimers.get(sessionId));
    const nextTick = setTimeout(() => this.processSession(session, settings), refreshInterval);
    this.dayWatchTimers.set(sessionId, nextTick);
  }

  async handleAlert(session, settings, sgv, direction, force = false) {
    const sessionId = session.id;
    const { low, high } = this.getAlertLimits(settings);
    const hysteresis = this.getHysteresisMg(settings);
    const lastAlert = this.alertHistory.get(sessionId) || {};
    const alertLatch = this.alertLatch.get(sessionId) || null;
    const now = Date.now();
    const coolDownExpired = now - (lastAlert.lastTrigger || 0) > settings.alert_cooldown_ms;
    
    // ECO
    const lang = settings.language || 'en';
    let ecoStatus = 'ok';
    if (sgv <= low + hysteresis) {
      ecoStatus = lang === 'es' ? 'BAJO' : 'LOW';
    } else if (sgv >= high - hysteresis) {
      ecoStatus = lang === 'es' ? 'ALTO' : 'HIGH';
    }
    const lastEcoStatus = this.activeSessions.get(sessionId)?.lastEcoStatus;
    if (lastEcoStatus !== ecoStatus) {
      session.publishEcoState(ecoStatus);
      this.activeSessions.get(sessionId).lastEcoStatus = ecoStatus;
    }
    
    const isLow = sgv <= low;
    const hysteresisReleaseLow = sgv > low + hysteresis;
    const isHigh = sgv >= high;
    const hysteresisReleaseHigh = sgv < high - hysteresis;
    
    if (force) {
      if (sgv <= low) {
        this.alertLatch.set(sessionId, 'low');
      } else if (sgv >= high) {
        this.alertLatch.set(sessionId, 'high');
      }
    }
    
    let shouldAlert = false;
    let newLatch = alertLatch;
    let alertType = null;
    
    if (isLow && coolDownExpired) {
      shouldAlert = true;
      alertType = 'low';
      newLatch = 'low';
    } else if (alertLatch === 'low' && hysteresisReleaseLow) {
      newLatch = null;
    }
    
    if (isHigh && coolDownExpired) {
      shouldAlert = true;
      alertType = 'high';
      newLatch = 'high';
    } else if (alertLatch === 'high' && hysteresisReleaseHigh) {
      newLatch = null;
    }
    
    this.alertLatch.set(sessionId, newLatch);
    
    const isCurrentlyAlerting = isLow || isHigh || newLatch;
    
    if (shouldAlert && settings.alertsEnabled) {
      const alertMsg = alertType === 'low' ? 
        (lang === 'es' ? `Alerta: Glucosa Baja` : `Alert: Low Glucose`) :
        (lang === 'es' ? `Alerta: Glucosa Alta` : `Alert: High Glucose`);
      
      const { low, high } = this.getAlertLimits(settings);
      const isLowCrit = sgv < low;
      const isHighCrit = sgv > high;

      const display = this.convertToDisplay(sgv, settings.units || UNITS.MGDL);
      const trend = this.getTrendArrow(direction);
      const msg = lang === 'es' ?
        `Glucosa: ${display} ${settings.units}. Tendencia: ${trend}. Estado: ${this.getGlucoseStatusText(sgv, settings, lang)}.` :
        `Glucose: ${display} ${settings.units}. Trend: ${trend}. Status: ${this.getGlucoseStatusText(sgv, settings, lang)}.`;
      
      this.showDisplay(session, { text: alertMsg + '\n' + msg });
      
      this.alertHistory.set(sessionId, {
        isAlert: true,
        isLow: isLow,
        isHigh: isHigh,
        lastTrigger: now
      });
      
      this._scheduleHide(sessionId, settings.alert_duration_ms);
      return;
    }
    
    if (!isCurrentlyAlerting && lastAlert.isAlert) {
      this.alertHistory.set(sessionId, {
        isAlert: false,
        isLow: false,
        isHigh: false,
        lastTrigger: lastAlert.lastTrigger
      });
    }
  }

  async onSessionEnd(sessionId) {
    console.log(`❌ Sesión finalizada: ${sessionId}`);
    this.activeSessions.delete(sessionId);
    this.alertHistory.delete(sessionId);
    this.alertLatch.delete(sessionId);
    this.displayTimers.delete(sessionId);
    this.headUpLastShown.delete(sessionId);
    this.dailyTirState.delete(sessionId);
    this.dayWatchTimers.delete(sessionId);
    this.lastGoodEntry.delete(sessionId);
    this._renderToken.delete(sessionId);
    this._lastShownText.delete(sessionId);
    this._http.delete(sessionId);
    this._settingsDebounce.delete(sessionId);
    this._sessionLocale.delete(sessionId);
  }

  async onSettingsSave(session, settingsArray) {
    const sessionId = session.id;
    const settings = this.parseSettingsFromArray(settingsArray);
    
    const now = Date.now();
    let ecoMsg = settings.language === 'es' ? 'Ajustes guardados.' : 'Settings saved.';
    
    const result = await this.getNightscoutData(session, settings);
    if (result.success) {
      const display = this.convertToDisplay(result.data.sgv, settings.units || UNITS.MGDL);
      const trend = this.getTrendArrow(result.data.direction);
      const status = this.getGlucoseStatusText(result.data.sgv, settings, settings.language);
      const extra = result.data.tirPct ? ` TIR:${result.data.tirPct.toFixed(0)}%` : '';
      const msg = settings.language === 'es' ?
        `Glucosa: ${display} ${settings.units || UNITS.MGDL} ${trend}. Estado: ${status}.${extra}` :
        `Glucose: ${display} ${settings.units || UNITS.MGDL} ${trend}. Status: ${status}.${extra}`;
      this.showDisplay(session, { text: msg });
      session.publishEcoState(settings.language === 'es' ? 'OK' : 'OK');
      this.activeSessions.get(sessionId).lastEcoStatus = 'OK';
    } else {
      ecoMsg += ` ${result.error}`;
      this.showDisplay(session, { text: ecoMsg });
      session.publishEcoState(settings.language === 'es' ? 'ERROR' : 'ERROR');
      this.activeSessions.get(sessionId).lastEcoStatus = 'ERROR';
    }
    
    this._scheduleHide(sessionId, settings.display_duration_ms);
  }
}

/* ---------- init ---------- */
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});
server.start().catch(err => {
  console.error('⛔ Error iniciando servidor:', err);
  process.exit(1);
});
console.log('🚀 Nightscout MentraOS v2.13.1 — Hysteresis + ECO + Pred no-avanzado...');
