"use strict";

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
    this._http = new Map();            // cliente axios por sesión
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
  getAlertLimits(settings) {
    const units = String(settings.units || '').toLowerCase();
    const lowMg  = this.parseSlicerValue(settings.low_alert_mg, NaN);
    const highMg = this.parseSlicerValue(settings.high_alert_mg, NaN);
    const lowM = this.normalizeMmol(settings.low_alert_mmol);
    const highM = this.normalizeMmol(settings.high_alert_mmol);

    const mgOK  = Number.isFinite(lowMg)  && Number.isFinite(highMg);
    const mmOK  = Number.isFinite(lowM)   && Number.isFinite(highM);

    if (units.includes('mmol')) {
      if (mmOK)  return { low: Math.round(lowM*18),  high: Math.round(highM*18) };
      if (mgOK)  return { low: Math.round(lowMg),    high: Math.round(highMg)   };
      return { low: Math.round(3.9*18), high: Math.round(13.9*18) };
    } else {
      if (mgOK)  return { low: Math.round(lowMg),    high: Math.round(highMg)   };
      if (mmOK)  return { low: Math.round(lowM*18),  high: Math.round(highM*18) };
      return { low: 70, high: 250 };
    }
  }

  getHysteresisMg(settings) {
    const mg = this.validateSlicerValue(settings.alert_hysteresis_mg, 0, 50, NaN);
    const raw = this.parseSlicerValue(settings.alert_hysteresis_mmol, NaN);
    let mmol = NaN;
    if (Number.isFinite(raw)) {
      if (Number.isInteger(raw)) {
        if (raw >= 0 && raw <= 10) mmol = raw / 10;
        else if (raw >= 30) mmol = raw / 10;
        else mmol = raw;
      } else mmol = raw;
    }
    const mmolAsMg = Number.isFinite(mmol) ? Math.round(mmol * 18) : NaN;
    const units = String(settings.units || '').toLowerCase();
    if (units.includes('mmol')) {
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
      if (Number.isFinite(mg)) return mg;
      return 5;
    } else {
      if (Number.isFinite(mg)) return mg;
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
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
        ? true : (this.toBool(kv.show_tir_bar) || this.toBool(kv.show_range_bar));

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
      ? true : (this.toBool(o.show_tir_bar) || this.toBool(o.show_range_bar));

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

  async buildPredictionShort(settings, sessionId='default', lowOverrideMg=null, highOverrideMg=null) {
    const lim = this.getAlertLimits(settings);
    const lowThreshold = Number.isFinite(lowOverrideMg) ? lowOverrideMg : lim.low;
    const highThreshold = Number.isFinite(highOverrideMg) ? highOverrideMg : lim.high;
    const horizon = Number(settings.prediction_horizon_min || 30);
    const maxSteps = Math.max(3, Math.min(12, Math.round(horizon / 5)));
    const isMmol = String(settings.units || '').toLowerCase().includes('mmol');
    const toDisp = (mgdl) => isMmol ? (mgdl/18).toFixed(1) : String(Math.round(mgdl));
    const http = this._ensureHttp(sessionId, settings);
    if (!http) return null;

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
    try {
      session.layouts.clearView();
      session.layouts.clearView({ view: ViewType.DASHBOARD });
      this._lastShownText.delete(sessionId);
    } catch {}
  }

  /* ---------- helpers ECO ---------- */
  getAlarmEchoState(sessionId, mgdl, settings) {
    const lim = this.getAlertLimits(settings);
    const latched = this.alertLatch.get(sessionId) || null;
    if (latched === 'low' || latched === 'high') return latched;
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

      // Cambio de día
      const dayWatch = setInterval(() => {
        const sd = this.activeSessions.get(sessionId);
        if (!sd) return;
        const currentDayStr = this.getLocalDayStr(Date.now(), sd.settings, sessionId);
        const lastDayStr = this.dailyTirState.get(sessionId)?.dayStr;
        if (currentDayStr !== lastDayStr) {
          sd.session.logger?.info('Nuevo día, reiniciando TIR', { sessionId, lastDayStr, currentDayStr });
          this.dailyTirState.set(sessionId, { dayStr: currentDayStr, total: 0, inRange: 0 });
          this.lastGoodEntry.delete(sessionId);
          this.checkAndRender(sessionId);
        }
      }, 60 * 60 * 1000); // Cada hora

      this.dayWatchTimers.set(sessionId, dayWatch);
      this.checkAndRender(sessionId);

    } catch (e) {
      console.error('Error in onSession:', e);
      this.showClamped(session, sessionId, 'Initialization error. Check logs.');
    }
  }

  async checkAndRender(sessionId, options = {}) {
    const sd = this.activeSessions.get(sessionId);
    if (!sd) return;
    const { session, settings } = sd;
    session.logger?.info(`checkAndRender para ${sessionId}`);
    const renderToken = Math.random();
    this._renderToken.set(sessionId, renderToken);
    
    // Si ya hay un timer de checkAndRender, no hacemos nada.
    if (this._settingsDebounce.get(sessionId)) return;

    // Obtener los datos más recientes
    let glucoseData;
    let errorMessage = '';
    const lastGood = this.lastGoodEntry.get(sessionId);

    try {
      glucoseData = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, glucoseData);
    } catch (e) {
      errorMessage = e.message;
      session.logger?.warn?.(`getGlucoseData falló: ${e.message}. Usando el último valor conocido.`);
      glucoseData = lastGood;
    }

    if (!glucoseData) {
      if (!errorMessage) errorMessage = 'No hay datos de glucosa';
      this.showClamped(session, sessionId, errorMessage);
      return;
    }

    let alarmState = this.getAlarmEchoState(sessionId, glucoseData.sgv, settings);
    const forcedAlert = settings.debug_force_alert;
    const isMmol = String(settings.units || '').toLowerCase().includes('mmol');
    const toDisp = (mgdl) => isMmol ? (mgdl/18).toFixed(1) : String(Math.round(mgdl));

    // Lógica de visualización
    let shouldShow = this.toBool(settings.enable_head_up_display);
    let duration = settings.display_duration_ms;
    let viewType = ViewType.DASHBOARD;
    let lines = [];
    let isTir = false;
    let isMinMax = false;
    let isAlert = false;
    let statusText = ''; // Nuevo: para el estado del HUD

    if (forcedAlert === 'low') alarmState = 'low';
    if (forcedAlert === 'high') alarmState = 'high';

    if (alarmState === 'low' || alarmState === 'high') {
      shouldShow = true;
      isAlert = true;
      duration = settings.alert_duration_ms;
      viewType = ViewType.ALERT;
      this.alertLatch.set(sessionId, alarmState);
      const now = Date.now();
      const lastAlertTs = this.alertHistory.get(sessionId) || 0;
      if (now - lastAlertTs < settings.alert_cooldown_ms) {
        shouldShow = false;
        session.logger?.info('Alerta en cooldown, no se muestra', { sessionId });
      } else {
        this.alertHistory.set(sessionId, now);
      }
    } else {
      // Hysteresis logic
      const latched = this.alertLatch.get(sessionId);
      if (latched) {
        const lim = this.getAlertLimits(settings);
        const hysteresis = this.getHysteresisMg(settings);
        if (latched === 'low' && glucoseData.sgv > (lim.low + hysteresis)) {
          this.alertLatch.delete(sessionId);
          session.logger?.info('Hysteresis de LOW superada, borrando latch', { sessionId });
        } else if (latched === 'high' && glucoseData.sgv < (lim.high - hysteresis)) {
          this.alertLatch.delete(sessionId);
          session.logger?.info('Hysteresis de HIGH superada, borrando latch', { sessionId });
        }
      }
    }

    // Gestion de gestos
    if (options.gesture === 'long-press') {
      const todayEntries = await this.getTodayEntries(settings, sessionId);
      if (todayEntries.length > 0) {
        const minSgv = Math.min(...todayEntries.map(e => e.mgdl).filter(e => Number.isFinite(e)));
        const maxSgv = Math.max(...todayEntries.map(e => e.mgdl).filter(e => Number.isFinite(e)));
        if (Number.isFinite(minSgv) && Number.isFinite(maxSgv)) {
          lines.push(isMmol ? `Min/Max: ${toDisp(minSgv)} / ${toDisp(maxSgv)} ${UNITS.MMOL}` : `Min/Max: ${toDisp(minSgv)} / ${toDisp(maxSgv)} ${UNITS.MGDL}`);
          shouldShow = true;
          duration = settings.display_duration_ms;
          isMinMax = true;
        }
      }
    }

    // Componer texto de las líneas (de arriba a abajo)
    const displaySgv = this.convertToDisplay(glucoseData.sgv, settings.units || UNITS.MGDL);
    const trendArrow = this.getTrendArrow(glucoseData.direction);
    const b = this._getLocaleBundle(sessionId, settings);
    const readingTime = new Date(glucoseData.date);
    const timeStr = readingTime.toLocaleTimeString(b.locale, { timeZone: b.tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const minutesAgo = Math.floor((Date.now() - glucoseData.date) / 60000);
    const timeAgo = minutesAgo <= 1 ? (b.lang === 'es' ? 'ahora' : 'now') : (b.lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    
    // Línea 1
    lines.push(`${displaySgv} ${settings.units || UNITS.MGDL} ${trendArrow}`);
    // Línea 2: tiempo de lectura + predicción no-avanzada
    const predShort = await this.buildPredictionShort(settings, sessionId);
    const predLine = predShort ? ` · ${predShort}` : '';
    lines.push(`${timeStr} (${timeAgo})${predLine}`);
    
    // Líneas adicionales
    const treatments = await this.getRecentTreatments(settings, 'day', sessionId);
    const treatmentsLine = this.formatTreatmentsLine(treatments, settings, sessionId);
    if (treatmentsLine) lines.push(treatmentsLine);

    const tirState = this.updateDailyTirState(sessionId, glucoseData.sgv, glucoseData.date, settings);
    const tirLine = settings.language === 'es' ? `TIR hoy: ${tirState.tirPct}%` : `TIR today: ${tirState.tirPct}%`;
    const tirBar = this.buildTirBar(tirState.tirPct);

    // Gestos especiales para mostrar TIR
    if (options.gesture === 'single-tap') {
      lines = [];
      lines.push(this.composeTirLines(settings, tirLine, tirBar, treatmentsLine));
      shouldShow = true;
      duration = settings.display_duration_ms;
      isTir = true;
    }

    // Lógica para estado de alarma ECO
    if (alarmState === 'low') {
        statusText = 'Active: LOW';
    } else if (alarmState === 'high') {
        statusText = 'Active: HIGH';
    } else {
        statusText = 'No alarm';
    }
    
    // Decidir qué mostrar
    if (isAlert) {
      this.showClamped(session, sessionId, lines.join('\n'));
      this._scheduleHide(sessionId, duration);
      session.logger?.info(`Alerta activada: ${statusText}, mostrando HUD.`, { sessionId });
    } else if (shouldShow) {
      this.showClamped(session, sessionId, lines.join('\n'));
      this._scheduleHide(sessionId, duration);
      session.logger?.info('HUD activado, mostrando datos.', { sessionId });
    } else {
      this.hideDisplay(session, sessionId);
      session.logger?.info('HUD no activado, no se muestra nada.', { sessionId });
    }
  }

  /* ---------- Event Handlers ---------- */
  setupEventHandlers(session, sessionId, userId) {
    session.on('settings-updated', async (updatedSettings) => {
      session.logger?.info(`Settings actualizados para ${sessionId}`);
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      sd.settings = this.parseSettingsFromArray(updatedSettings);

      // Debounce para evitar múltiples llamadas de renderizado
      if (this._settingsDebounce.has(sessionId)) {
        clearTimeout(this._settingsDebounce.get(sessionId));
      }
      const debounceTimer = setTimeout(() => {
        this.checkAndRender(sessionId);
        this._settingsDebounce.delete(sessionId);
      }, 500);
      this._settingsDebounce.set(sessionId, debounceTimer);
    });

    session.on('tap', (event) => {
      this.checkAndRender(sessionId, { gesture: 'single-tap' });
    });

    session.on('long-press', (event) => {
      this.checkAndRender(sessionId, { gesture: 'long-press' });
    });

    session.on('app-resumed', () => {
      this.checkAndRender(sessionId);
    });
  }

  async onSessionEnd(sessionId) {
    console.log(`❌ Sesión terminada: ${sessionId}`);
    this.activeSessions.delete(sessionId);
    this.alertHistory.delete(sessionId);
    this.alertLatch.delete(sessionId);
    this.displayTimers.delete(sessionId);
    this.headUpLastShown.delete(sessionId);
    this.dailyTirState.delete(sessionId);
    this.lastGoodEntry.delete(sessionId);
    this._renderToken.delete(sessionId);
    this._lastShownText.delete(sessionId);
    this._http.delete(sessionId);
    this._settingsDebounce.delete(sessionId);
    this._sessionLocale.delete(sessionId);

    // Limpiar el timer del cambio de día
    if (this.dayWatchTimers.has(sessionId)) {
      clearInterval(this.dayWatchTimers.get(sessionId));
      this.dayWatchTimers.delete(sessionId);
    }
  }
}

const server = new NightscoutMentraApp({
  appId: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server.start().catch(err => {
  console.error('⛔ Error iniciando servidor:', err);
  process.exit(1);
});
