"use strict";
/**
 * Nightscout MentraOS v2.12.0 (TIR invariant + Horizon-aware Prediction)
 * HUD texto + TIR-bar ¦ CH/Ins día + Min/Max sólo gesto ¦ reset diario
 * ES/EN + mg/dL/mmol ¦ 5 líneas max ¦ cache last-good-entry
 * Settings en segundos/minutos + toggle barra TIR
 * Mejora: TIR invariante a unidad + predicción usa límites reales y horizonte
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
  console.error('? MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.activeSessions = new Map();
    this.alertHistory = new Map();
    this.displayTimers = new Map();
    this.headUpLastShown = new Map();
    this.dailyTirState = new Map();
    this.dayWatchTimers = new Map();
    this.lastGoodEntry = new Map();
    this._renderToken = new Map(); // v2.12
    this._lastShownText = new Map(); // v2.12 (desaturar render)
  }

  /* ---------- helpers ---------- */
  __delay(ms) { return new Promise(res => setTimeout(res, ms)); }
  __clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }

  __easeInOutCubic(t){
    return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
  }
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

  parseSlicerValue(val, fallback) {
    const n = (typeof val === 'object' && val !== null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
  }
  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  }
  toBool(x) {
    return (x === true || x === 'true' || x === 1 || x === '1');
  }
  normalizeMmol(x) {
    const v = this.parseSlicerValue(x, null);
    // UI mmol viene x10 (p.ej. 39 = 3.9)
    return (v !== null && Number.isFinite(v)) ? (v >= 30 ? v / 10 : v) : null;
  }

  /* ---------- alertas / límites ---------- */
  // v2.12: Hacemos el TIR invariante a unidad -> prioriza mg/dL; si faltan, usa mmol convertidos
  getAlertLimits(settings) {
    const lowMg  = this.parseSlicerValue(settings.low_alert_mg, NaN);
    const highMg = this.parseSlicerValue(settings.high_alert_mg, NaN);
    if (Number.isFinite(lowMg) && Number.isFinite(highMg)) {
      return { low: Math.round(lowMg), high: Math.round(highMg) };
    }
    const lowM = this.normalizeMmol(settings.low_alert_mmol) ?? 3.9;
    const highM = this.normalizeMmol(settings.high_alert_mmol) ?? 13.9;
    return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
  }

  /* ---------- lectura de settings ---------- */
  async getUserSettings(session) {
    try {
      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units,
        enable_head_up_display,
        display_duration_s, alert_duration_s, alert_cooldown_min,
        show_tir_bar, show_range_bar,
        display_duration_ms, alert_duration_ms, alert_cooldown_ms,
        enable_advanced_mode, advanced_mode_enabled,
        // (legacy no usados pero no rompen)
        tir_low_mg, tir_high_mg, tir_low_mmol, tir_high_mmol,
        time_in_range_low_mg, time_in_range_high_mg, time_in_range_low_mmol, time_in_range_high_mmol,
        prediction_horizon_min, prediction_horizon_mins,
        debug_force_alert // v2.12: estaba sin desestructurar -> ReferenceError
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
        session.settings.get('display_duration_s'),
        session.settings.get('alert_duration_s'),
        session.settings.get('alert_cooldown_min'),
        session.settings.get('show_tir_bar'),
        session.settings.get('show_range_bar'),
        session.settings.get('display_duration_ms'),
        session.settings.get('alert_duration_ms'),
        session.settings.get('alert_cooldown_ms'),
        session.settings.get('enable_advanced_mode'),
        session.settings.get('advanced_mode_enabled'),
        session.settings.get('tir_low_mg'),
        session.settings.get('tir_high_mg'),
        session.settings.get('tir_low_mmol'),
        session.settings.get('tir_high_mmol'),
        session.settings.get('time_in_range_low_mg'),
        session.settings.get('time_in_range_high_mg'),
        session.settings.get('time_in_range_low_mmol'),
        session.settings.get('time_in_range_high_mmol'),
        session.settings.get('prediction_horizon_min'),
        session.settings.get('prediction_horizon_mins'),
        session.settings.get('debug_force_alert')
      ]);

      const uiMin = parseInt(updateInterval, 10);
      const ui = Number.isFinite(uiMin) ? uiMin : 5;

      const displayMs = Number.isFinite(this.parseSlicerValue(display_duration_s, NaN))
        ? Math.min(15, Math.max(1, this.parseSlicerValue(display_duration_s))) * 1000
        : this.validateSlicerValue(display_duration_ms, 1000, 15000, 5000);

      const alertMs = Number.isFinite(this.parseSlicerValue(alert_duration_s, NaN))
        ? Math.min(60, Math.max(2, this.parseSlicerValue(alert_duration_s))) * 1000
        : this.validateSlicerValue(alert_duration_ms, 2000, 60000, 15000);

      const coolMs = Number.isFinite(this.parseSlicerValue(alert_cooldown_min, NaN))
        ? Math.min(60, Math.max(1, this.parseSlicerValue(alert_cooldown_min))) * 60 * 1000
        : this.validateSlicerValue(alert_cooldown_ms, 60000, 3600000, 600000);

      const showTirBar = (show_tir_bar === null && show_range_bar === null)
        ? true
        : (this.toBool(show_tir_bar) || this.toBool(show_range_bar));

      return {
        nightscoutUrl: String(url || '').trim() || '',
        nightscoutToken: String(token || '').trim() || '',
        updateInterval: ui,
        low_alert_mg: this.validateSlicerValue(lowMg, 50, 120, 70),
        high_alert_mg: this.validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: this.normalizeMmol(lowMmol) ?? 3.9,
        high_alert_mmol: this.normalizeMmol(highMmol) ?? 13.9,
        alertsEnabled: this.toBool(alertsEnabled),
        language: language || 'en',
        timezone: timezone || null,
        units: units || UNITS.MGDL,
        enable_head_up_display: this.toBool(enable_head_up_display),
        display_duration_ms: displayMs,
        alert_duration_ms: alertMs,
        alert_cooldown_ms: coolMs,
        show_tir_bar: showTirBar,
        enable_advanced_mode: this.toBool(enable_advanced_mode) || this.toBool(advanced_mode_enabled),
        // legacy (no usados por TIR/pred)
        tir_low_mg: this.parseSlicerValue(tir_low_mg, null),
        tir_high_mg: this.parseSlicerValue(tir_high_mg, null),
        tir_low_mmol: this.normalizeMmol(tir_low_mmol),
        tir_high_mmol: this.normalizeMmol(tir_high_mmol),
        time_in_range_low_mg: this.parseSlicerValue(time_in_range_low_mg, null),
        time_in_range_high_mg: this.parseSlicerValue(time_in_range_high_mg, null),
        time_in_range_low_mmol: this.normalizeMmol(time_in_range_low_mmol),
        time_in_range_high_mmol: this.normalizeMmol(time_in_range_high_mmol),
        prediction_horizon_min: [15,30,60].includes(Number(prediction_horizon_min || prediction_horizon_mins)) ? Number(prediction_horizon_min || prediction_horizon_mins) : 30,
        debug_force_alert: (typeof debug_force_alert === 'string' ? debug_force_alert : null),
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

    const showTirBar = (o.show_tir_bar === null && o.show_range_bar === null)
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
      // legacy (no usados)
      tir_low_mg: this.parseSlicerValue(o.tir_low_mg, null),
      tir_high_mg: this.parseSlicerValue(o.tir_high_mg, null),
      tir_low_mmol: this.normalizeMmol(o.tir_low_mmol),
      tir_high_mmol: this.normalizeMmol(o.tir_high_mmol),
      time_in_range_low_mg: this.parseSlicerValue(o.time_in_range_low_mg, null),
      time_in_range_high_mg: this.parseSlicerValue(o.time_in_range_high_mg, null),
      time_in_range_low_mmol: this.normalizeMmol(o.time_in_range_low_mmol),
      time_in_range_high_mmol: this.normalizeMmol(o.time_in_range_high_mmol),
      prediction_horizon_min: [15,30,60].includes(Number(o.prediction_horizon_min || o.prediction_horizon_mins)) ? Number(o.prediction_horizon_min || o.prediction_horizon_mins) : 30,
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
      'Europe/Madrid', 'Atlantic/Canary', 'Europe/London', 'Europe/Paris',
      'Europe/Berlin', 'Europe/Rome', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
      'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
    ];
    return valid.includes(tz) ? tz : 'UTC';
  }

  async formatForG1(data, settings) {
    const display = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const trend = this.getTrendArrow(data.direction);
    const langSettings = this.getLanguageSettings(settings);
    const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const readingTime = new Date(data.date);
    const timeStr = readingTime.toLocaleTimeString(langSettings.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const lang = settings.language || 'en';
    const timeAgo = minutesAgo <= 1 ? (lang === 'es' ? 'ahora' : 'now') : (lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    return `${display} ${settings.units || UNITS.MGDL} ${trend}\n${timeStr} (${timeAgo})`;
  }

  // Incluye predicción de umbral usando límites reales y horizonte.
  async formatForG1WithPrediction(data, settings) {
    try {
      const base = await this.formatForG1(data, settings);
      const predShort = await this.buildAdvancedPredictionShort(settings);
      if (!predShort) return base;
      const parts = base.split('\n');
      const l1 = parts[0] || '';
      const l2 = (parts.length > 1 ? parts[1] : '');
      const sep = ' · ';
      const rest = parts.slice(2);
      return `${l1}\n${l2}${sep}${predShort}${rest.length ? `\n${rest.join('\n')}` : ''}`;
    } catch (error) {
      console.error('Error in formatForG1WithPrediction, falling back:', error);
      return await this.formatForG1(data, settings);
    }
  }

  // v2.12: Predicción usa límites de alerta (reales) y horizon seleccionado
  async buildAdvancedPredictionShort(settings) {
    const { low: lowThreshold, high: highThreshold } = this.getAlertLimits(settings); // mg/dL
    const horizon = Number(settings.prediction_horizon_min || 30);
    const maxSteps = Math.max(3, Math.min(12, Math.round(horizon / 5))); // 15..60 → 3..12 pasos
    const isMmol = String(settings.units || '').toLowerCase().includes('mmol');
    const toDisp = (mgdl) => isMmol ? (mgdl/18).toFixed(1) : String(Math.round(mgdl));

    let base = (settings.nightscoutUrl || '').trim();
    if (!base) return null;
    if (!base.startsWith('http')) base = 'https://' + base;
    base = base.replace(/\/$/, '');
    const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
    const headers = { 'User-Agent': 'MentraOS-Nightscout/2.12.0' };

    // 1) Método Exacto: predBGs de devicestatus (capado por horizon)
    try {
      const { data } = await axios.get(`${base}/api/v1/devicestatus.json?count=1`, { params, timeout: 8000, headers });
      const ds = Array.isArray(data) ? data[0] : data;
      const predBGs = ds && (ds.predBGs || ds?.openaps?.suggested?.predBGs || ds?.ar2?.predBGs);
      if (predBGs) {
        // Elige serie disponible
        let series = predBGs.IOB || predBGs.COB || predBGs.UAM || predBGs.ZT || (Array.isArray(predBGs) ? predBGs : null);
        if (Array.isArray(series) && series.length > 1) {
          series = series.slice(0, maxSteps + 1); // actual + horizon pasos
          const currentSgv = Number(series[0]);
          if (Number.isFinite(currentSgv)) {
            if (currentSgv > lowThreshold) { // Buscar bajada
              for (let i = 1; i < series.length; i++) {
                if (Number(series[i]) <= lowThreshold) {
                  return `↓${toDisp(lowThreshold)} @${i * 5}m`;
                }
              }
            }
            if (currentSgv < highThreshold) { // Buscar subida
              for (let i = 1; i < series.length; i++) {
                if (Number(series[i]) >= highThreshold) {
                  return `↑${toDisp(highThreshold)} @${i * 5}m`;
                }
              }
            }
          }
        }
      }
    } catch (_) {}

    // 2) Fallback: Extrapolación lineal con últimas lecturas (capada por horizon)
    try {
      const { data } = await axios.get(`${base}/api/v1/entries.json?count=2`, { params, timeout: 8000, headers });
      if (data && data.length >= 2) {
        const last = data[0];
        const prev = data[1];
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
              if (timeToLow > 0 && timeToLow <= horizon) {
                return `↓${toDisp(lowThreshold)} @${Math.round(timeToLow)}m`;
              }
            }
            if (ratePerMin > 0.4) {
              const timeToHigh = (highThreshold - mgNow) / ratePerMin;
              if (timeToHigh > 0 && timeToHigh <= horizon) {
                return `↑${toDisp(highThreshold)} @${Math.round(timeToHigh)}m`;
              }
            }
          }
        }
      }
    } catch (_) {}

    return null;
  }

  /* ---------- día local + TIR + tratamientos ---------- */
  getLocalDayStr(ts, settings) {
    const langSettings = this.getLanguageSettings(settings);
    const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    return new Date(ts).toLocaleDateString(langSettings.locale, { timeZone: tz });
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
    const dayStr = this.getLocalDayStr(readingTs, settings);
    let st = this.dailyTirState.get(sessionId);
    if (!st || st.dayStr !== dayStr) st = { dayStr, total: 0, inRange: 0 };
    if (Number.isFinite(readingMgdl)) {
      st.total += 1;
      if (readingMgdl >= range.low && readingMgdl <= range.high) st.inRange += 1;
    }
    this.dailyTirState.set(sessionId, st);
    return { tirPct: st.total > 0 ? Math.round((st.inRange / st.total) * 100) : null, total: st.total };
  }

  async getRecentTreatments(settings, hours = 4) {
    try {
      const base = (settings.nightscoutUrl || '').trim();
      if (!base) return null;
      let u = base.startsWith('http') ? base : 'https://' + base;
      u = u.replace(/\/$/, '');
      const endpoint = `${u}/api/v1/treatments.json?count=1000`;
      const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
      const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.12.0' } });
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      const langSettings = this.getLanguageSettings(settings);
      const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
      const locale = langSettings.locale;
      const todayStr = new Date().toLocaleDateString(locale, { timeZone: tz });
      const events = arr.map(t => {
        const dateStr = t.created_at || t.timestamp || t.dateString || t.date || null;
        let ts = null;
        if (typeof dateStr === 'number') ts = dateStr;
        else if (typeof dateStr === 'string') ts = Date.parse(dateStr);
        return { ts, carbs: Number(t.carbs), insulin: Number(t.insulin) };
      }).filter(e => e.ts && (Number.isFinite(e.carbs) || Number.isFinite(e.insulin)));
      let windowed, label;
      if (hours === 'day') {
        windowed = events.filter(e => new Date(e.ts).toLocaleDateString(locale, { timeZone: tz }) === todayStr);
        label = settings.language === 'es' ? 'hoy' : 'today';
      } else {
        const since = Date.now() - Math.max(1, hours) * 60 * 60 * 1000;
        windowed = events.filter(e => e.ts >= since);
        label = `${hours}h`;
      }
      if (!windowed.length) return { label, totalCarbs: 0, totalInsulin: 0, last: null };
      let totalCarbs = 0, totalInsulin = 0; let last = null;
      for (const e of windowed) {
        if (Number.isFinite(e.carbs)) totalCarbs += e.carbs;
        if (Number.isFinite(e.insulin)) totalInsulin += e.insulin;
        if (!last || e.ts > last.ts) last = e;
      }
      return { label, totalCarbs, totalInsulin, last };
    } catch (_) { return null; }
  }
  formatTreatmentsLine(summary, settings) {
    if (!summary) return '';
    const { label, totalCarbs, totalInsulin, last } = summary;
    const lang = settings.language || 'en';
    const round1 = x => Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
    const c = round1(totalCarbs), i = round1(totalInsulin);
    let lastStr = '';
    if (last && (Number.isFinite(last.carbs) || Number.isFinite(last.insulin))) {
      const langSettings = this.getLanguageSettings(settings);
      const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
      const t = new Date(last.ts).toLocaleTimeString(langSettings.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
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
  async getTodayEntries(settings) {
    const u0 = settings.nightscoutUrl;
    if (!u0) throw new Error('URL no configurada');
    let u = u0.startsWith('http') ? u0 : 'https://' + u0;
    u = u.replace(/\/$/, '');
    const endpoint = `${u}/api/v1/entries/sgv.json?count=400`;
    const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
    const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.12.0' } });
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    const langSettings = this.getLanguageSettings(settings);
    const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const locale = langSettings.locale;
    const todayStr = new Date().toLocaleDateString(locale, { timeZone: tz });
    const today = arr
      .map(r => ({ mgdl: Number(r.sgv ?? r.glucose), date: typeof r.date === 'string' ? new Date(r.date).getTime() : r.date }))
      .filter(r => Number.isFinite(r.mgdl) && r.date)
      .filter(r => new Date(r.date).toLocaleDateString(locale, { timeZone: tz }) === todayStr)
      .sort((a, b) => a.date - b.date);
    return today;
  }

  async getGlucoseData(settings) {
    let u = settings.nightscoutUrl;
    if (!u) throw new Error('URL no configurada');
    if (!u.startsWith('http')) u = 'https://' + u;
    u = u.replace(/\/$/, '');
    const endpoints = [
      `${u}/api/v1/entries/sgv.json?count=1`,
      `${u}/api/v1/entries.json?count=1`,
      `${u}/api/v1/entries/current.json`
    ];
    let lastError;
    for (const endpoint of endpoints) {
      try {
        const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
        const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.12.0' } });
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
      // v2.12: evita renders idénticos seguidos
      const last = this._lastShownText.get(sessionId);
      if (last === out) return;
      this._lastShownText.set(sessionId, out);
      session.layouts.showTextWall(out);
    } catch (_) {}
  }
  hideDisplay(session, sessionId) {
    try { session.layouts.showTextWall(''); this._lastShownText.delete(sessionId); } catch {}
  }

  /* ---------- ciclo de vida ---------- */
  async onSession(session, sessionId, userId) {
    console.log(`?? Nueva sesión: ${sessionId} para ${userId}`);
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
        const entries = await this.getTodayEntries(settings);
        const dayStr = this.getLocalDayStr(Date.now(), settings);
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
        const currentDay = this.getLocalDayStr(Date.now(), s);
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
      const data = await this.getGlucoseData(settings);
      this.lastGoodEntry.set(sessionId, data);
      const tirRes = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      const formattedData = await this.formatForG1WithPrediction(data, settings);
      if (settings.enable_advanced_mode) {
        const tirPct = tirRes.tirPct;
        const tirLine = tirPct === null
          ? (settings.language === 'es' ? 'TIR hoy: n/d' : 'TIR: n/a')
          : (settings.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
        const bar = !this.toBool(settings.show_tir_bar) || tirPct === null ? '' : this.buildTirBar(tirPct);
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day'); tLine = this.formatTreatmentsLine(sum, settings); } catch {}
        await this.animateTIRFill(session, sessionId, settings, formattedData, tirPct, tLine);
      } else {
        this.showClamped(session, sessionId, formattedData);
      }
      if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
      const t = setTimeout(() => this.hideDisplay(session, sessionId), settings.display_duration_ms || 5000);
      this.displayTimers.set(sessionId, t);
    } catch (error) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const fallback = await this.formatForG1WithPrediction(cached, settings);
          this.showClamped(session, sessionId, fallback);
          if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
          const t = setTimeout(() => this.hideDisplay(session, sessionId), settings.display_duration_ms || 5000);
          this.displayTimers.set(sessionId, t);
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
      if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
    }
  }

  async animateTIRFill(session, sessionId, s, headerText, tirPct, tLine='', extraLine='') {
    try {
      const showBar = !!s.show_tir_bar;
      const anims   = s.enable_animations !== false;
      if (!showBar || !anims || tirPct == null || !Number.isFinite(tirPct)){
        const bar = showBar && tirPct != null ? ' ' + this.__barFromRatio(tirPct/100, 20) : '';
        const tirLine = tirPct == null ? (s.language==='es' ? 'TIR hoy: n/d' : 'TIR: n/a') : (s.language==='es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
        const line2 = `${tirLine}${bar}` + (tLine ? `\n${tLine}` : '');
        const out = extraLine ? `${headerText}\n${line2}\n${extraLine}` : `${headerText}\n${line2}`;
        this.showClamped(session, sessionId, out);
        return;
      }

      // Token de render para invalidar animaciones viejas
      const token = (this._renderToken.get(sessionId) || 0) + 1;
      this._renderToken.set(sessionId, token);

      const slots = 20;
      const leadIn = 250;
      const totalMs = 900;
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

      const settingsHandler = async (settingsData) => {
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
          if (this.alertLimitsChanged(old, settings)) this.alertHistory.delete(sessionId);

          sd.settings = settings;
          this.activeSessions.set(sessionId, sd);

          try { // feedback rápido de guardado
            try { const dNow = await this.getGlucoseData(settings); await this.checkAlerts(session, sessionId, dNow, settings);} catch(_){ }
            const lines = [];
            lines.push(settings.language === 'es' ? 'Ajustes guardados' : 'Settings saved');
            lines.push(`Units: ${settings.units}`);
            if (settings.units === UNITS.MMOL) {
              lines.push(`Low: ${(+settings.low_alert_mmol).toFixed(1)} mmol/L`);
              lines.push(`High: ${(+settings.high_alert_mmol).toFixed(1)} mmol/L`);
            } else {
              lines.push(`Low: ${settings.low_alert_mg} mg/dL`);
              lines.push(`High: ${settings.high_alert_mg} mg/dL`);
            }
            lines.push(`HeadUp: ${settings.enable_head_up_display ? 'ON' : 'OFF'}`);
            lines.push(`Advanced: ${settings.enable_advanced_mode ? 'ON' : 'OFF'}`);
            this.showClamped(session, sessionId, lines.join('\n'));
            setTimeout(() => this.hideDisplay(session, sessionId), 2200);
          } catch {}
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
          const sd = this.activeSessions.get(sessionId);
          const s = sd?.settings; if (!s) return; if (!s.enable_head_up_display) return;
          const now = Date.now(); const last = this.headUpLastShown.get(sessionId) || 0;
          if (now - last < 10000) return; this.headUpLastShown.set(sessionId, now);
          const reading = await this.getGlucoseData(s);
          const baseLine = await this.formatForG1WithPrediction(reading, s);
          if (!s.enable_advanced_mode) {
            this.showClamped(session, sessionId, baseLine);
            setTimeout(() => this.hideDisplay(session, sessionId), s.display_duration_ms || 4000);
            return;
          }
          const { tirPct } = this.updateDailyTirState(sessionId, reading.sgv, reading.date, s);
          const tirLine = tirPct === null
            ? (s.language === 'es' ? 'TIR hoy: n/d' : 'TIR: n/a')
            : (s.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
          const bar = !this.toBool(s.show_tir_bar) || tirPct === null ? '' : this.buildTirBar(tirPct);
          let minMaxLine = '';
          try {
            const entries = await this.getTodayEntries(s);
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
          try { const sum = await this.getRecentTreatments(s, 'day'); tLine = this.formatTreatmentsLine(sum, s); } catch {}
          await this.animateTIRFill(session, sessionId, s, baseLine, tirPct, tLine, minMaxLine);
          setTimeout(() => this.hideDisplay(session, sessionId), s.display_duration_ms || 4000);
        } catch (e) {
          this.showClamped(session, sessionId, (s.language==='es' ? 'Error al mostrar' : 'Display error'));
          setTimeout(() => this.hideDisplay(session, sessionId), 2000);
        }
      });

      session.events?.onDisconnected?.(() => {
        const t = this.displayTimers.get(sessionId); if (t) clearTimeout(t); this.displayTimers.delete(sessionId);
        const sd = this.activeSessions.get(sessionId); if (sd?.updateInterval) clearInterval(sd.updateInterval);
        const dw = this.dayWatchTimers.get(sessionId); if (dw) clearInterval(dw); this.dayWatchTimers.delete(sessionId);
        this.activeSessions.delete(sessionId); this.alertHistory.delete(sessionId);
        this.headUpLastShown.delete(sessionId); this.dailyTirState.delete(sessionId); this.lastGoodEntry.delete(sessionId);
        session.logger?.info('Session disconnected');
      });
    } catch (error) {
      console.error('? Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    try {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      const settings = providedSettings || sd.settings || await this.getUserSettings(sd.session);
      const data = await this.getGlucoseData(settings);
      this.lastGoodEntry.set(sessionId, data);
      const { tirPct } = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      if (settings.enable_advanced_mode) {
        const header = await this.formatForG1WithPrediction(data, settings);
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day'); tLine = this.formatTreatmentsLine(sum, settings); } catch {}
        await this.animateTIRFill(session, sessionId, settings, header, tirPct, tLine);
      } else {
        this.showClamped(session, sessionId, await this.formatForG1WithPrediction(data, settings));
      }
      if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
      this.displayTimers.set(sessionId, timer);
    } catch (error) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const s = this.activeSessions.get(sessionId)?.settings || {};
          const txt = await this.formatForG1WithPrediction(cached, s);
          this.showClamped(session, sessionId, txt);
          if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
          const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
          this.displayTimers.set(sessionId, timer);
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
        const d = await this.getGlucoseData(s);
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
    const last = this.alertHistory.get(sessionId);
    const cooldown = settings.alert_cooldown_ms || 600000;

    if (last && Date.now() - last < cooldown) return;

    let alertType = null;
    if (mgdl <= limits.low) alertType = 'low';
    else if (mgdl >= limits.high) alertType = 'high';

    // v2.12: inyección de alertas para test, si está definido debug_force_alert (low/high)
    const dbg = (settings.debug_force_alert || '').toLowerCase();
    if (!alertType && (dbg === 'low' || dbg === 'high')) alertType = dbg;

    if (alertType) {
      this.alertHistory.set(sessionId, Date.now());
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

    if (this.displayTimers.has(sessionId)) {
      clearTimeout(this.displayTimers.get(sessionId));
    }

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
      oldSettings.units !== newSettings.units
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
  console.error('? Error iniciando servidor:', err);
  process.exit(1);
});
console.log('?? Nightscout MentraOS v2.12.0 — TIR invariant + Horizon-aware Prediction');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.12.0',
  activeSessions: server.activeSessions.size
}));
setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
