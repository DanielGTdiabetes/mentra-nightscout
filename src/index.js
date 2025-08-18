"use strict";
/**
 * Nightscout MentraOS v2.13.1 (Hysteresis + ECO con estado de alarma + Pred no-avanzado)
 * HUD texto + TIR-bar ¦ CH/Ins día + Min/Max sólo gesto ¦ reset diario
 * ES/EN + mg/dL/mmol ¦ 5 líneas max ¦ cache last-good-entry
 * Settings en segundos/minutos + toggle barra TIR
 * Mejora: cliente axios por sesión, debounce de settings, animación reforzada
 * NUEVO:
 *  - Histeresis de alarmas (alert_hysteresis_mg / alert_hysteresis_mmol) con latch
 *  - En NO avanzado, predicción sólo si cruza ≤60 o ≥180 mg/dL (fijos)
 *  - ECO al guardar ajustes incluye estado de alarmas (BAJA/ALTA/Sin) en ES/EN, compacto
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

  /* ---------- alertas / límites ---------- */
  getAlertLimits(settings) { // devuelve mg/dL
    const lowMg  = this.parseSlicerValue(settings.low_alert_mg, NaN);
    const highMg = this.parseSlicerValue(settings.high_alert_mg, NaN);
    if (Number.isFinite(lowMg) && Number.isFinite(highMg)) {
      return { low: Math.round(lowMg), high: Math.round(highMg) };
    }
    const lowM = this.normalizeMmol(settings.low_alert_mmol) ?? 3.9;
    const highM = this.normalizeMmol(settings.high_alert_mmol) ?? 13.9;
    return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
  }

  getHysteresisMg(settings) {
  // Lee candidatos
  const mg = this.validateSlicerValue(settings.alert_hysteresis_mg, 0, 50, NaN);

  // mmol puede venir sin decimales (x10) o con decimales según UI
  const raw = this.parseSlicerValue(settings.alert_hysteresis_mmol, NaN);
  let mmol = NaN;
  if (Number.isFinite(raw)) {
    if (Number.isInteger(raw)) {
      // Consola sin decimales: 0..10 => 0.0..1.0  (p.ej. 3 => 0.3 mmol)
      if (raw >= 0 && raw <= 10) mmol = raw / 10;
      // Compatibilidad con “x10 grande” (39 => 3.9) si alguien lo usa aquí
      else if (raw >= 30) mmol = raw / 10;
      else mmol = raw; // enteros raros: tratamos como mmol real
    } else {
      mmol = raw; // ya decimal (si alguna UI lo permite)
    }
  }
  const mmolAsMg = Number.isFinite(mmol) ? Math.round(mmol * 18) : NaN;

  const units = String(settings.units || '').toLowerCase();

  // PRIORIDAD POR UNIDAD SELECCIONADA
  if (units.includes('mmol')) {        // mmol/L => usa mmol primero
    if (Number.isFinite(mmolAsMg)) return mmolAsMg;
    if (Number.isFinite(mg))        return mg;
    return 5; // fallback
  } else {                            // mg/dL (o desconocida) => usa mg primero
    if (Number.isFinite(mg))        return mg;
    if (Number.isFinite(mmolAsMg))  return mmolAsMg;
    return 5; // fallback
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
        // NUEVO:
        'alert_hysteresis_mg','alert_hysteresis_mmol',
        // legacy tolerados
        'tir_low_mg','tir_high_mg','tir_low_mmol','tir_high_mmol',
        'time_in_range_low_mg','time_in_range_high_mg','time_in_range_low_mmol','time_in_range_high_mmol',
        'prediction_horizon_min','prediction_horizon_mins',
        'debug_force_alert'
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
        // NEW: histeresis (defaults)
        alert_hysteresis_mg: this.validateSlicerValue(kv.alert_hysteresis_mg, 0, 50, 5),
        alert_hysteresis_mmol: this.normalizeMmol(kv.alert_hysteresis_mmol) ?? 0.3,
        // legacy tolerados
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
        debug_force_alert: null
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
      // NEW: histeresis
      alert_hysteresis_mg: this.validateSlicerValue(o.alert_hysteresis_mg, 0, 50, 5),
      alert_hysteresis_mmol: this.normalizeMmol(o.alert_hysteresis_mmol) ?? 0.3,
      // legacy tolerados
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
      debug_force_alert: (typeof o.debug_force_alert === 'string' ? o.debug_force_alert : null)
    };
  }

  /* ---------- UI helpers ---------- */
  convertToDisplay(mgdlValue, targetUnit) {
    return targetUnit === UNITS.MMOL ? (mgdlValue / 18).toFixed(1) : Math.round(mgdlValue);
  }
  getTrendArrow(dir) {
    const map = {
      DoubleUp: '↑↑', SingleUp: '↑', FortyFiveUp: '↗',
      Flat: '→',
      FortyFiveDown: '↘', SingleDown: '↓', DoubleDown: '↓↓',
      NONE: '-', 'NOT COMPUTABLE': '?'
    };
    return map[dir] || '?';
  }
  getLanguageSettings(settings) {
    const langMap = { es: { locale: 'es-ES', timezone: 'Europe/Madrid' }, en: { locale: 'en-US', timezone: 'America/New_York' } };
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
    const timeStr = readingTime.toLocaleTimeString(b.locale, { timeZone: b.tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const timeAgo = minutesAgo <= 1 ? (b.lang === 'es' ? 'ahora' : 'now') : (b.lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    return `${display} ${settings.units || UNITS.MGDL} ${trend}\n${timeStr} (${timeAgo})`;
  }

  async formatForG1WithPrediction(data, settings, sessionId) {
    try {
      const base = await this.formatForG1(data, settings, sessionId);
      // NO avanzado: pred solo si cruza 60/180 mg/dL
      const predShort = settings.enable_advanced_mode
        ? await this.buildPredictionShort(settings, sessionId, null, null)
        : await this.buildPredictionShort(settings, sessionId, 60, 180);
      if (!predShort) return base;
      const parts = base.split('\n');
      const l1 = parts[0] || '';
      const l2 = (parts.length > 1 ? parts[1] : '');
      const sep = ' · ';
      const rest = parts.slice(2);
      return `${l1}\n${l2}${sep}${predShort}${rest.length ? `\n${rest.join('\n')}` : ''}`;
    } catch (error) {
      console.error('Error in formatForG1WithPrediction, falling back:', error);
      return await this.formatForG1(data, settings, sessionId);
    }
  }

  /* ---------- Cliente HTTP por sesión ---------- */
  _ensureHttp(sessionId, settings){
    let cli = this._http.get(sessionId);
    const baseRaw = (settings.nightscoutUrl || '').trim();
    if (!baseRaw) return null;
    const base = baseRaw.startsWith('http') ? baseRaw : ('https://' + baseRaw);
    const baseURL = base.replace(/\/$/, '');
    if (!cli || cli.defaults.baseURL !== baseURL || cli.defaults.params?.token !== settings.nightscoutToken){
      cli = axios.create({
        baseURL,
        headers: { 'User-Agent': 'MentraOS-Nightscout/2.13.1' },
        timeout: 10000,
        params: settings.nightscoutToken ? { token: settings.nightscoutToken } : {}
      });
      this._http.set(sessionId, cli);
    }
    return cli;
  }

  /**
   * Predicción breve hasta cruce de límites.
   * - lowOverrideMg/highOverrideMg: si números ⇒ usar (p.ej. 60/180 para no avanzado)
   * - si null ⇒ usa límites configurados
   * Devuelve null si no se prevé cruce dentro del horizonte.
   */
  async buildPredictionShort(settings, sessionId='default', lowOverrideMg=null, highOverrideMg=null) {
    const lim = this.getAlertLimits(settings);
    const lowThreshold = Number.isFinite(lowOverrideMg) ? lowOverrideMg : lim.low;
    const highThreshold = Number.isFinite(highOverrideMg) ? highOverrideMg : lim.high;
    const horizon = Number(settings.prediction_horizon_min || 30);
    const maxSteps = Math.max(3, Math.min(12, Math.round(horizon / 5))); // 15..60 → 3..12 pasos
    const isMmol = String(settings.units || '').toLowerCase().includes('mmol');
    const toDisp = (mgdl) => isMmol ? (mgdl/18).toFixed(1) : String(Math.round(mgdl));
    const http = this._ensureHttp(sessionId, settings);
    if (!http) return null;

    // 1) Método exacto devicestatus
    try {
      const { data } = await http.get(`/api/v1/devicestatus.json?count=1`);
      const ds = Array.isArray(data) ? data[0] : data;
      const predBGs = ds && (ds.predBGs || ds?.openaps?.suggested?.predBGs || ds?.ar2?.predBGs);
      if (predBGs) {
        let series = predBGs.IOB || predBGs.COB || predBGs.UAM || predBGs.ZT || (Array.isArray(predBGs) ? predBGs : null);
        if (Array.isArray(series) && series.length > 1) {
          series = series.slice(0, maxSteps + 1);
          const currentSgv = Number(series[0]);
          if (Number.isFinite(currentSgv)) {
            if (currentSgv > lowThreshold) {
              for (let i = 1; i < series.length; i++) {
                if (Number(series[i]) <= lowThreshold) return `↓${toDisp(lowThreshold)} @${i*5}m`;
              }
            }
            if (currentSgv < highThreshold) {
              for (let i = 1; i < series.length; i++) {
                if (Number(series[i]) >= highThreshold) return `↑${toDisp(highThreshold)} @${i*5}m`;
              }
            }
          }
        }
      }
    } catch (_) {}

    // 2) Fallback lineal
    try {
      const { data } = await http.get(`/api/v1/entries.json?count=2`);
      if (data && data.length >= 2) {
        const last = data[0], prev = data[1];
        const mgNow = Number(last.sgv ?? last.glucose);
        const tNow = new Date(last.date || last.dateString).getTime();
        const mgPrev = Number(prev.sgv ?? prev.glucose);
        const tPrev = new Date(prev.date || prev.dateString).getTime();

        if (Number.isFinite(mgNow) && Number.isFinite(mgPrev) && tNow > tPrev) {
          const deltaMinutes = (tNow - tPrev) / 60000;
          if (deltaMinutes > 0) {
            const ratePerMin = (mgNow - mgPrev) / deltaMinutes;

            if (ratePerMin < -0.4) {
              const timeToLow = (lowThreshold - mgNow) / ratePerMin;
              if (timeToLow > 0 && timeToLow <= horizon) return `↓${toDisp(lowThreshold)} @${Math.round(timeToLow)}m`;
            }
            if (ratePerMin > 0.4) {
              const timeToHigh = (highThreshold - mgNow) / ratePerMin;
              if (timeToHigh > 0 && timeToHigh <= horizon) return `↑${toDisp(highThreshold)} @${Math.round(timeToHigh)}m`;
            }
          }
        }
      }
    } catch (_) {}

    return null;
  }

  /* ---------- día local + TIR + tratamientos ---------- */
  getLocalDayStr(ts, settings, sessionId='default') {
    const b = this._getLocaleBundle(sessionId, settings);
    return new Date(ts).toLocaleDateString(b.locale, { timeZone: b.tz });
  }
  buildTirBar(tirPct) {
    if (tirPct === null || !Number.isFinite(tirPct)) return '';
    const blocks = Math.max(0, Math.min(20, Math.floor(tirPct / 5)));
    return '¦'.repeat(blocks);
  }
  composeTirLines(settings, tirLine, bar, tLine) {
    const labelBar = `${tirLine}${bar ? ' ' + bar : ''}`;
    try {
      let clean = (tLine || '')
        .replace(/^CH\/Ins hoy: /, '')
        .replace(/^Carbs\/Ins today: /, '')
        .replace(/\s*[·•]\s*(Last|Últ):[\s\S]*$/i, '')
        .replace(/\s*Last:[\s\S]*$/i, '')
        .replace(/\s*Últ:[\s\S]*$/i, '')
        .replace(/\s*\/\s*/g, '/')
        .replace(/\s+/g, ' ')
        .trim();
      return clean ? `${labelBar}\n${clean}` : labelBar;
    } catch { return labelBar; }
  }

  updateDailyTirState(sessionId, readingMgdl, readingTs, settings) {
    const range = this.getAlertLimits(settings);
    const dayStr = this.getLocalDayStr(readingTs, settings, sessionId);
    let st = this.dailyTirState.get(sessionId);
    if (!st || st.dayStr !== dayStr) st = { dayStr, total: 0, inRange: 0 };
    if (Number.isFinite(readingMgdl)) {
      st.total += 1;
      if (readingMgdl >= range.low && readingMgdl <= range.high) st.inRange += 1;
    }
    this.dailyTirState.set(sessionId, st);
    return { tirPct: st.total > 0 ? Math.round((st.inRange / st.total) * 100) : null, total: st.total };
  }

  async getRecentTreatments(settings, hours = 'day', sessionId='default') {
    try {
      const http = this._ensureHttp(sessionId, settings);
      if (!http) return null;
      const { data } = await http.get(`/api/v1/treatments.json?count=1000`);
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      const b = this._getLocaleBundle(sessionId, settings);
      const todayStr = new Date().toLocaleDateString(b.locale, { timeZone: b.tz });
      const events = arr.map(t => {
        const dateStr = t.created_at || t.timestamp || t.dateString || t.date || null;
        let ts = null;
        if (typeof dateStr === 'number') ts = dateStr;
        else if (typeof dateStr === 'string') ts = Date.parse(dateStr);
        return { ts, carbs: Number(t.carbs), insulin: Number(t.insulin) };
      }).filter(e => e.ts && (Number.isFinite(e.carbs) || Number.isFinite(e.insulin)));
      let windowed, label;
      if (hours === 'day') {
        windowed = events.filter(e => new Date(e.ts).toLocaleDateString(b.locale, { timeZone: b.tz }) === todayStr);
        label = settings.language === 'es' ? 'hoy' : 'today';
      } else {
        const since = Date.now() - Math.max(1, hours) * 60 * 60 * 1000;
        windowed = events.filter(e => e.ts >= since);
        label = `${hours}h`;
      }
      if (!windowed.length) return { label, totalCarbs: 0, totalInsulin: 0, last: null };
      let totalCarbs = 0, totalInsulin = 0, last = null;
      for (const e of windowed) {
        if (Number.isFinite(e.carbs)) totalCarbs += e.carbs;
        if (Number.isFinite(e.insulin)) totalInsulin += e.insulin;
        if (!last || e.ts > last.ts) last = e;
      }
      return { label, totalCarbs, totalInsulin, last };
    } catch (_) { return null; }
  }
  formatTreatmentsLine(summary, settings, sessionId='default') {
    if (!summary) return '';
    const { label, totalCarbs, totalInsulin, last } = summary;
    const lang = settings.language || 'en';
    const round1 = x => Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
    const c = round1(totalCarbs), i = round1(totalInsulin);
    let lastStr = '';
    if (last && (Number.isFinite(last.carbs) || Number.isFinite(last.insulin))) {
      const b = this._getLocaleBundle(sessionId, settings);
      const t = new Date(last.ts).toLocaleTimeString(b.locale, { timeZone: b.tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const parts = [];
      if (Number.isFinite(last.carbs)) parts.push(`${round1(last.carbs)}g`);
      if (Number.isFinite(last.insulin)) parts.push(`${round1(last.insulin)}U`);
      lastStr = parts.length ? (lang === 'es' ? ` · Últ: ${parts.join(', ')} ${t}` : ` · Last: ${parts.join(', ')} ${t}`) : '';
    }
    return lang === 'es'
      ? (label === 'hoy' ? `CH/Ins hoy: ${c}g / ${i}U${lastStr}` : `CH/Ins ${label}: ${c}g / ${i}U${lastStr}`)
      : (label === 'today' ? `Carbs/Ins today: ${c}g / ${i}U${lastStr}` : `Carbs/Ins ${label}: ${c}g / ${i}U${lastStr}`);
  }

  /* ---------- obtención de datos ---------- */
  async getTodayEntries(settings, sessionId='default') {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) throw new Error('URL no configurada');
    const { data } = await http.get(`/api/v1/entries/sgv.json?count=400`);
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    const b = this._getLocaleBundle(sessionId, settings);
    const todayStr = new Date().toLocaleDateString(b.locale, { timeZone: b.tz });
    const today = arr
      .map(r => ({ mgdl: Number(r.sgv ?? r.glucose), date: typeof r.date === 'string' ? new Date(r.date).getTime() : r.date }))
      .filter(r => Number.isFinite(r.mgdl) && r.date)
      .filter(r => new Date(r.date).toLocaleDateString(b.locale, { timeZone: b.tz }) === todayStr)
      .sort((a, b) => a.date - b.date);
    return today;
  }

  async getGlucoseData(settings, sessionId='default') {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) throw new Error('URL no configurada');

    const endpoints = [
      `/api/v1/entries/sgv.json?count=1`,
      `/api/v1/entries.json?count=1`,
      `/api/v1/entries/current.json`
    ];
    let lastError;
    for (const endpoint of endpoints) {
      try {
        const { data } = await http.get(endpoint);
        const reading = Array.isArray(data) ? data[0] : data;
        if (!reading) throw new Error('Empty response');
        const glucose = Number(reading.sgv ?? reading.glucose);
        if (!Number.isFinite(glucose)) throw new Error('No glucose data found');
        const dateValue = reading.date || reading.dateString || reading.sysTime;
        if (!dateValue) throw new Error('No date found');
        return { sgv: glucose, date: typeof dateValue === 'string' ? new Date(dateValue).getTime() : dateValue, direction: reading.direction || reading.trend || 'NONE' };
      } catch (error) { lastError = error; continue; }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------- UI ---------- */
  showClamped(session, sessionId, text, maxLines = 5) {
    try {
      const lines = String(text || '').replace(/\r/g, '').split('\n');
      while (lines.length && lines[0].trim() === '') lines.shift();
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      const out = lines.slice(0, maxLines).join('\n');
      const last = this._lastShownText.get(sessionId);
      if (last === out) return;
      this._lastShownText.set(sessionId, out);
      session.layouts.showTextWall(out);
    } catch (_) {}
  }
  hideDisplay(session, sessionId) {
    try { session.layouts.showTextWall(''); this._lastShownText.delete(sessionId); } catch {}
  }

  /* ---------- helpers ECO ---------- */
  getAlarmEchoState(sessionId, mgdl, settings) {
    const lim = this.getAlertLimits(settings);
    const latched = this.alertLatch.get(sessionId) || null;
    if (latched === 'low' || latched === 'high') return latched; // ya activa
    if (!Number.isFinite(mgdl)) return 'none';
    if (mgdl <= lim.low) return 'low';
    if (mgdl >= lim.high) return 'high';
    return 'none';
  }

  /* ---------- ciclo de vida ---------- */
  async onSession(session, sessionId, userId) {
    console.log(`✅ Nueva sesión: ${sessionId} para ${userId}`);
    if (typeof session.updateSettingsForTesting !== 'function') {
      session.updateSettingsForTesting = async () => { session.logger?.debug?.('Compat shim: updateSettingsForTesting noop'); };
    }
    session.logger?.info('Session started', { userId, sessionId });

    let settings = null;
    try {
      settings = await this.getUserSettings(session);
      if (!settings.nightscoutUrl) {
        const msg = { en: 'Please configure Nightscout\nURL and token in settings', es: 'Configura URL y token\nde Nightscout en ajustes' };
        this.showClamped(session, sessionId, msg[settings.language || 'en']);
        return;
      }

      this.activeSessions.set(sessionId, { session, userId, settings, updateInterval: null });
      this.setupEventHandlers(session, sessionId, userId);

      // Semilla TIR
      try {
        const entries = await this.getTodayEntries(settings, sessionId);
        const dayStr = this.getLocalDayStr(Date.now(), settings, sessionId);
        const range = this.getAlertLimits(settings);
        let total = 0, inRange = 0;
        for (const e of entries) {
          if (Number.isFinite(e.mgdl)) {
            total += 1;
            if (e.mgdl >= range.low && e.mgdl <= range.high) inRange += 1;
          }
        }
        this.dailyTirState.set(sessionId, { dayStr, total, inRange });
      } catch (e) {
        session.logger?.debug?.('Seed TIR failed', { err: e?.message });
      }

      // Reloj de cambio de día
      const dayWatch = setInterval(() => {
        const sd = this.activeSessions.get(sessionId);
        if (!sd) return;
        const s = sd.settings;
        const st = this.dailyTirState.get(sessionId);
        const currentDay = this.getLocalDayStr(Date.now(), s, sessionId);
        if (!st || st.dayStr !== currentDay) {
          this.dailyTirState.set(sessionId, { dayStr: currentDay, total: 0, inRange: 0 });
        }
      }, 60 * 1000);
      this.dayWatchTimers.set(sessionId, dayWatch);

      await this.showInitialAndHide(session, sessionId, settings);
      await this.startNormalOperation(session, sessionId, userId, settings);

    } catch (e) {
      session.logger?.error(e, 'Error en sesión');
      console.error('Error en sesión:', e);
      const lang = (settings && settings.language) || 'en';
      this.showClamped(session, sessionId, lang === 'es' ? 'Error: revisa configuración' : 'Error: check settings');
    }
  }

  async showInitialAndHide(session, sessionId, settings) {
    try {
      const data = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      const tirRes = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      const formattedData = await this.formatForG1WithPrediction(data, settings, sessionId);
      if (settings.enable_advanced_mode) {
        const tirPct = tirRes.tirPct;
        const tirLine = tirPct === null
          ? (settings.language === 'es' ? 'TIR hoy: n/d' : 'TIR: n/a')
          : (settings.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
        const bar = !this.toBool(settings.show_tir_bar) || tirPct === null ? '' : this.buildTirBar(tirPct);
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day', sessionId); tLine = this.formatTreatmentsLine(sum, settings, sessionId); } catch {}
        await this.animateTIRFill(session, sessionId, settings, formattedData, tirPct, tLine);
      } else {
        // No avanzado: base + pred condicionada (60/180)
        this.showClamped(session, sessionId, formattedData);
      }
      this._scheduleHide(sessionId, settings.display_duration_ms || 5000);
    } catch (error) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const fallback = await this.formatForG1WithPrediction(cached, settings, sessionId);
          this.showClamped(session, sessionId, fallback);
          this._scheduleHide(sessionId, settings.display_duration_ms || 5000);
          return;
        }
      } catch (_) {}
      const lang = (settings && settings.language) || 'en';
      const errorMsg = error.message?.includes('URL no configurada')
        ? { en: 'Nightscout URL not set\nCheck settings', es: 'URL de Nightscout no configurada\nRevisa ajustes' }
        : (error.message?.includes('Sin datos') || error.message?.includes('timeout'))
        ? { en: 'Cannot connect to Nightscout\nCheck URL and token', es: 'No se puede conectar\nRevisa URL y token' }
        : { en: 'Error loading glucose data\nCheck your settings', es: 'Error cargando datos\nRevisa tu configuración' };
      this.showClamped(session, sessionId, errorMsg[lang]);
      this._scheduleHide(sessionId, 5000);
    }
  }

  async animateTIRFill(session, sessionId, s, headerText, tirPct, tLine='', extraLine='') {
    try {
      const showBar = !!s.show_tir_bar;
      const anims   = s.enable_animations !== false; // ON por defecto
      if (!showBar || !anims || tirPct == null || !Number.isFinite(tirPct)){
        const bar = showBar && tirPct != null ? ' ' + this.__barFromRatio(tirPct/100, 20) : '';
        const tirLine = tirPct == null ? (s.language==='es' ? 'TIR hoy: n/d' : 'TIR: n/a') : (s.language==='es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
        const line2 = `${tirLine}${bar}` + (tLine ? `\n${tLine}` : '');
        const out = extraLine ? `${headerText}\n${line2}\n${extraLine}` : `${headerText}\n${line2}`;
        this.showClamped(session, sessionId, out);
        return;
      }

      const token = (this._renderToken.get(sessionId) || 0) + 1;
      this._renderToken.set(sessionId, token);

      const slots = 20;
      const leadIn = 220;
      const totalMs = 920;
      const target  = Math.floor(this.__clamp01(tirPct/100) * slots);

      const tirLine = (s.language==='es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
      const base = (filled) =>
        `${headerText}\n${tirLine} ${this.__barFromRatio(filled/slots, slots)}`
        + (tLine ? `\n${tLine}` : '')
        + (extraLine ? `\n${extraLine}` : '');

      this.showClamped(session, sessionId, base(0));
      if (leadIn>0){
        const t0 = Date.now();
        while (Date.now()-t0 < leadIn){
          if (this._renderToken.get(sessionId) !== token) return;
          await this.__delay(30);
        }
      }

      const tStart = Date.now();
      let last = -1;
      const ease = this.__getEasingFunction(String(s.animation_type||'cubic'));
      while (true){
        if (this._renderToken.get(sessionId) !== token) return;
        const t = (Date.now() - tStart) / totalMs;
        const clamped = Math.max(0, Math.min(1, t));
        const eased = ease(clamped);
        const filled = Math.min(target, Math.floor(eased * target));
        if (filled !== last){
          this.showClamped(session, sessionId, base(filled));
          last = filled;
        }
        if (clamped >= 1) break;
        await this.__delay(33);
      }
      this.showClamped(session, sessionId, base(target));
    } catch (_) {
      try {
        const bar = this.__barFromRatio((tirPct||0)/100, 20);
        const tirLine = tirPct == null ? (s.language==='es' ? 'TIR hoy: n/d' : 'TIR: n/a') : (s.language==='es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
        const line2 = `${tirLine} ${bar}` + (tLine ? `\n${tLine}` : '');
        const out = extraLine ? `${headerText}\n${line2}\n${extraLine}` : `${headerText}\n${line2}`;
        this.showClamped(session, sessionId, out);
      } catch {}
    }
  }

  setupEventHandlers(session, sessionId, userId) {
    try {
      session.events?.onButtonPress?.(async () => {
        const sd = this.activeSessions.get(sessionId);
        const s = sd?.settings || await this.getUserSettings(session);
        await this.showGlucoseTemporarily(session, sessionId, s.display_duration_ms || 4000, s);
      });

      const runSettingsHandler = async (settingsData) => {
        session.logger?.info('Settings update received', { settingsCount: settingsData?.length });
        try {
          const settings = this.parseSettingsFromArray(settingsData || []);
          const sd = this.activeSessions.get(sessionId);
          if (!sd) return;
          const old = sd.settings || {};

          if (old.updateInterval !== settings.updateInterval) {
            if (sd.updateInterval) { clearInterval(sd.updateInterval); sd.updateInterval = null; }
            await this.startNormalOperation(session, sessionId, userId, settings);
          }
          if (this.alertLimitsChanged(old, settings)) {
            this.alertHistory.delete(sessionId);
            this.alertLatch.delete(sessionId); // reinicia latch al cambiar límites
          }

          sd.settings = settings;
          this.activeSessions.set(sessionId, sd);

          // ECO: incluye estado de alarma actual
          try {
            let dNow = null;
            try { dNow = await this.getGlucoseData(settings, sessionId); await this.checkAlerts(session, sessionId, dNow, settings); } catch(_){}
            const isEs = (settings.language || 'en') === 'es';
            const limits = this.getAlertLimits(settings);
            const hystMg = this.getHysteresisMg(settings);
            const hystMmol = (hystMg / 18).toFixed(1);

            const alarmState = this.getAlarmEchoState(sessionId, dNow?.sgv, settings);
            const stateStr = isEs
              ? (alarmState==='low' ? 'Activa: BAJA' : alarmState==='high' ? 'Activa: ALTA' : 'Sin alarma')
              : (alarmState==='low' ? 'Active: LOW' : alarmState==='high' ? 'Active: HIGH' : 'No alarm');

            const line1 = isEs ? 'Ajustes guardados' : 'Settings saved';
            const line2 = `Units: ${settings.units} · HeadUp: ${settings.enable_head_up_display ? 'ON' : 'OFF'}`;
            const line3 = (isEs ? 'TIR' : 'TIR') + `: ${limits.low}-${limits.high} mg/dL`;
            const line4 = `${isEs ? 'Avanzado' : 'Advanced'}: ${settings.enable_advanced_mode ? 'ON' : 'OFF'}`;
            const line5 = (isEs ? 'Alarmas' : 'Alerts') + `: ${settings.alertsEnabled ? 'ON' : 'OFF'} · Hyst: ±${hystMg} mg/dL (±${hystMmol} mmol/L) · ${stateStr}`;

            this.showClamped(session, sessionId, [line1,line2,line3,line4,line5].join('\n'));
            setTimeout(() => this.hideDisplay(session, sessionId), 2200);
          } catch {}
        } catch (error) {
          session.logger?.error(error, 'Failed to process settings update');
        }
      };

      const settingsHandler = (settingsData) => {
        if (this._settingsDebounce.has(sessionId)) clearTimeout(this._settingsDebounce.get(sessionId));
        const t = setTimeout(() => runSettingsHandler(settingsData), 120);
        this._settingsDebounce.set(sessionId, t);
      };

      session.events?.onAppSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsChange?.(settingsHandler);

      session.events?.onHeadPosition?.(async (data) => {
        try {
          if (data?.position !== 'up') return;
          const sd = this.activeSessions.get(sessionId);
          const s = sd?.settings; if (!s) return; if (!s.enable_head_up_display) return;
          const now = Date.now(); const last = this.headUpLastShown.get(sessionId) || 0;
          if (now - last < 10000) return; this.headUpLastShown.set(sessionId, now);
          const reading = await this.getGlucoseData(s, sessionId);
          const baseLine = await this.formatForG1WithPrediction(reading, s, sessionId);
          if (!s.enable_advanced_mode) {
            this.showClamped(session, sessionId, baseLine);
            this._scheduleHide(sessionId, s.display_duration_ms || 4000);
            return;
          }
          const { tirPct } = this.updateDailyTirState(sessionId, reading.sgv, reading.date, s);
          let minMaxLine = '';
          try {
            const entries = await this.getTodayEntries(s, sessionId);
            const vals = entries.map(e => e.mgdl).filter(Number.isFinite);
            if (vals.length) {
              const min = Math.min(...vals), max = Math.max(...vals);
              const minDisp = this.convertToDisplay(min, s.units);
              const maxDisp = this.convertToDisplay(max, s.units);
              minMaxLine = s.language === 'es'
                ? `Min/Max hoy: ${minDisp} / ${maxDisp} ${s.units}`
                : `Min/Max today: ${minDisp} / ${maxDisp} ${s.units}`;
            }
          } catch {}
          let tLine = '';
          try { const sum = await this.getRecentTreatments(s, 'day', sessionId); tLine = this.formatTreatmentsLine(sum, s, sessionId); } catch {}
          await this.animateTIRFill(session, sessionId, s, baseLine, tirPct, tLine, minMaxLine);
          this._scheduleHide(sessionId, s.display_duration_ms || 4000);
        } catch (e) {
          this.showClamped(session, sessionId, (this._getLocaleBundle(sessionId, {language:'es'}).lang==='es' ? 'Error al mostrar' : 'Display error'));
          this._scheduleHide(sessionId, 2000);
        }
      });

      session.events?.onDisconnected?.(() => {
        const t = this.displayTimers.get(sessionId); if (t) clearTimeout(t); this.displayTimers.delete(sessionId);
        const sd = this.activeSessions.get(sessionId); if (sd?.updateInterval) clearInterval(sd.updateInterval);
        const dw = this.dayWatchTimers.get(sessionId); if (dw) clearInterval(dw); this.dayWatchTimers.delete(sessionId);
        this._http.delete(sessionId);
        this._sessionLocale.delete(sessionId);
        this.activeSessions.delete(sessionId); this.alertHistory.delete(sessionId);
        this.alertLatch.delete(sessionId);
        this.headUpLastShown.delete(sessionId); this.dailyTirState.delete(sessionId); this.lastGoodEntry.delete(sessionId);
        session.logger?.info('Session disconnected');
      });
    } catch (error) {
      console.error('⚠️ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    try {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      const settings = providedSettings || sd.settings || await this.getUserSettings(sd.session);
      const data = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      const { tirPct } = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      if (settings.enable_advanced_mode) {
        const header = await this.formatForG1WithPrediction(data, settings, sessionId);
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day', sessionId); tLine = this.formatTreatmentsLine(sum, settings, sessionId); } catch {}
        await this.animateTIRFill(session, sessionId, settings, header, tirPct, tLine);
      } else {
        this.showClamped(session, sessionId, await this.formatForG1WithPrediction(data, settings, sessionId));
      }
      this._scheduleHide(sessionId, ms);
    } catch (error) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const s = this.activeSessions.get(sessionId)?.settings || {};
          const txt = await this.formatForG1WithPrediction(cached, s, sessionId);
          this.showClamped(session, sessionId, txt);
          this._scheduleHide(sessionId, ms);
          return;
        }
      } catch (_) {}
      session.logger?.error(error, 'Failed to show glucose temporarily');
    }
  }

  async startNormalOperation(session, sessionId, userId, initialSettings) {
    const ms = (initialSettings.updateInterval || 5) * 60 * 1000;
    const iv = setInterval(async () => {
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const sd = this.activeSessions.get(sessionId);
        const s = (sd && sd.settings) ? sd.settings : await this.getUserSettings(session);
        const d = await this.getGlucoseData(s, sessionId);
        this.lastGoodEntry.set(sessionId, d);
        this.updateDailyTirState(sessionId, d.sgv, d.date, s);
        if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
      } catch (error) {
        session.logger?.debug('Normal operation cycle failed', { error: error.message });
      }
    }, ms);
    const sd = this.activeSessions.get(sessionId);
    if (sd) {
      if (sd.updateInterval) clearInterval(sd.updateInterval);
      sd.updateInterval = iv;
      this.activeSessions.set(sessionId, sd);
    }
  }

  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const cooldown = settings.alert_cooldown_ms || 600000;
    const lastAlertTs = this.alertHistory.get(sessionId);
    const latch = this.alertLatch.get(sessionId) || null;
    const h = this.getHysteresisMg(settings);

    // Rearme por histeresis
    if (latch === 'low' && mgdl >= (limits.low + h)) {
      this.alertLatch.set(sessionId, null);
    } else if (latch === 'high' && mgdl <= (limits.high - h)) {
      this.alertLatch.set(sessionId, null);
    }

    // Si sigue latcheado, no relanzar
    if (this.alertLatch.get(sessionId)) return;

    // Cooldown general
    if (lastAlertTs && Date.now() - lastAlertTs < cooldown) return;

    // Forzado debug
    const dbg = (settings.debug_force_alert || '').toLowerCase();
    let alertType = null;

    if (mgdl <= limits.low || dbg === 'low') {
      alertType = 'low';
    } else if (mgdl >= limits.high || dbg === 'high') {
      alertType = 'high';
    }

    if (alertType) {
      this.alertHistory.set(sessionId, Date.now());
      this.alertLatch.set(sessionId, alertType);
      await this.triggerAnimatedAlert(session, sessionId, data, settings, alertType);
      session.logger?.warn('Alert sent', { type: alertType, value: mgdl });
    }
  }

  async triggerAnimatedAlert(session, sessionId, data, settings, type) {
    const displayValue = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const unit = settings.units || UNITS.MGDL;
    const lang = settings.language || 'en';
    const msgs = {
      en: { low: `LOW GLUCOSE!`, high: `HIGH GLUCOSE!` },
      es: { low: `¡GLUCOSA BAJA!`, high: `¡GLUCOSA ALTA!` }
    };
    const baseText = `${msgs[lang][type]}\n${displayValue} ${unit}`;
    const alertDuration = settings.alert_duration_ms || 15000;
    const blinkInterval = 600;

    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));

    const startTime = Date.now();
    let isVisible = true;
    const blinker = setInterval(() => {
      if (Date.now() - startTime > alertDuration) {
        clearInterval(blinker);
        this.hideDisplay(session, sessionId);
        return;
      }
      const symbol = isVisible ? '[!]' : '[ ]';
      this.showClamped(session, sessionId, `${symbol} ${baseText}`);
      isVisible = !isVisible;
    }, blinkInterval);

    this.displayTimers.set(sessionId, setTimeout(() => {
      clearInterval(blinker);
      this.hideDisplay(session, sessionId);
    }, alertDuration + 120));
  }

  alertLimitsChanged(oldSettings, newSettings) {
    if (!oldSettings) return false;
    return (
      oldSettings.low_alert_mg !== newSettings.low_alert_mg ||
      oldSettings.high_alert_mg !== newSettings.high_alert_mg ||
      oldSettings.low_alert_mmol !== newSettings.low_alert_mmol ||
      oldSettings.high_alert_mmol !== newSettings.high_alert_mmol ||
      oldSettings.units !== newSettings.units ||
      oldSettings.alert_hysteresis_mg !== newSettings.alert_hysteresis_mg ||
      oldSettings.alert_hysteresis_mmol !== newSettings.alert_hysteresis_mmol
    );
  }

  /* ---------- MIRA tool ---------- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;
    const isSpanish = ['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'].includes(toolId);
    const lang = isSpanish ? 'es' : 'en';

    let settings = null;
    try {
      if (activeSession?.settings?.settings) {
        settings = this.parseSettingsFromArray(activeSession.settings.settings);
      } else {
        for (const [, sData] of this.activeSessions) {
          if (sData.userId === userId) { settings = sData.settings || await this.getUserSettings(sData.session); break; }
        }
      }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
        throw new Error(lang === 'es' ? 'Nightscout no configurado' : 'Nightscout not configured');
        }
      const reading = await this.getGlucoseData(settings);
      const display = this.convertToDisplay(reading.sgv, settings.units || UNITS.MGDL);
      const trend = this.getTrendArrow(reading.direction);
      const status = this.getGlucoseStatusText(reading.sgv, settings, lang);
      const { tirPct } = this.updateDailyTirState(activeSession?.sessionId || 'tool', reading.sgv, reading.date, settings);
      let extra = '';
      if (settings.enable_advanced_mode && Number.isFinite(tirPct)) {
        extra = lang === 'es' ? ` TIR hoy: ${tirPct}%` : ` TIR: ${tirPct}%`;
      }
      const msg = lang === 'es'
        ? `Tu glucosa está en ${display} ${settings.units || UNITS.MGDL} ${trend}. Estado: ${status}.${extra}`
        : `Your glucose is ${display} ${settings.units || UNITS.MGDL} ${trend}. Status: ${status}.${extra}`;
      return { success: true, data: { glucose: display, unit: settings.units || UNITS.MGDL, trend, status, tirPct: Number.isFinite(tirPct) ? tirPct : null }, message: msg };
    } catch (e) {
      return { success: false, error: lang === 'es' ? `Error: ${e.message}` : `Error: ${e.message}` };
    }
  }

  getGlucoseStatusText(value, settings, lang) {
    const limits = this.getAlertLimits(settings);
    if (value < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
    if (value <= limits.low) return lang === 'es' ? 'Bajo' : 'Low';
    if (value > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
    if (value >= limits.high) return lang === 'es' ? 'Alto' : 'High';
    return lang === 'es' ? 'Normal' : 'Normal';
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
console.log('🚀 Nightscout MentraOS v2.13.1 — Hysteresis + ECO + Pred no-avanzado');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.13.1',
  activeSessions: server.activeSessions.size
}));
setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
