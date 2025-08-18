
"use strict";
/**
 * Nightscout MentraOS v2.10.0 — v18-stable+
 * HUD texto + TIR-bar │ CH/Ins día + Min/Max sólo gesto │ reset diario
 * ES/EN + mg/dL/mmol │ 5 líneas max │ cache last-good-entry
 * Settings en segundos/minutos + toggle barra TIR
 *
 * Cambios sobre v18 original:
 *  - FIX: desalineación en Promise.all (prediction_horizon_* vs debug_force_alert).
 *  - Fallbacks: lectura de nightscout_url/token desde claves alternativas y variables de entorno.
 *  - Normalización de URL (https:// + sin barra final).
 *  - Se mantiene animación TIR suave (20 slots, 250ms lead-in, 900ms total).
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
  console.error('❌ MENTRAOS_API_KEY environment variable is required');
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
    this.lastGoodEntry = new Map();          // cache last valid entry
    this._renderToken = new Map();
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
    const filled = '│'.repeat(n);
    const empty  = '·'.repeat(Math.max(0, slots - n));
    return `[${filled}${empty}]`;
  }

  /**
   * Animate TIR bar from 0 → tirPct.
   * Cancels if a newer render starts (token check).
   */
  async animateTIRFill(session, sessionId, s, headerText, tirPct, tLine='', extraLine=''){
    try {
      const showBar = !!s.show_tir_bar;
      const anims   = s.enable_advanced_mode !== false; // usa modo avanzado como interruptor de animación
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
      const leadIn = 250;
      const totalMs = 900;
      const target  = Math.floor(this.__clamp01(tirPct/100) * slots);

      const tirLine = (s.language==='es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
      const base = (filled) => {
        return `${headerText}\n${tirLine} ${this.__barFromRatio(filled/slots, slots)}`
          + (tLine ? `\n${tLine}` : '')
          + (extraLine ? `\n${extraLine}` : '');
      };

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
      while (true){
        if (this._renderToken.get(sessionId) !== token) return;
        const t = (Date.now() - tStart) / totalMs;
        const clamped = Math.max(0, Math.min(1, t));
        const ease = this.__getEasingFunction(String(s.animation_type||'cubic'));
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
    return (v !== null && Number.isFinite(v)) ? (v >= 30 ? v / 10 : v) : null;
  }

  /* ---------- alertas ---------- */
  getAlertLimits(settings) {
    if (settings.units === UNITS.MMOL) {
      const lowM = this.normalizeMmol(settings.low_alert_mmol) ?? 3.9;
      const highM = this.normalizeMmol(settings.high_alert_mmol) ?? 13.9;
      return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
    }
    return { low: Math.round(settings.low_alert_mg), high: Math.round(settings.high_alert_mg) };
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
        tir_low_mg, tir_high_mg, tir_low_mmol, tir_high_mmol,
        time_in_range_low_mg, time_in_range_high_mg, time_in_range_low_mmol, time_in_range_high_mmol,
        prediction_horizon_min, prediction_horizon_mins,
        // Claves alternativas + debug
        ns_url, ns_token, nightscout, nightscoutToken,
        debug_force_alert
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
        // Alt keys
        session.settings.get('ns_url'),
        session.settings.get('ns_token'),
        session.settings.get('nightscout'),
        session.settings.get('nightscoutToken'),
        // debug
        session.settings.get('debug_force_alert'),
      ]);

      // Fallbacks URL/TOKEN (con entorno)
      const envUrl = (process.env.NIGHTSCOUT_URL || process.env.NS_URL || process.env.NIGHTSCOUT_HOST || '').trim();
      const envToken = (process.env.NIGHTSCOUT_TOKEN || process.env.NS_TOKEN || '').trim();
      let finalUrl = String(url || ns_url || nightscout || envUrl || '').trim();
      const finalToken = String(token || ns_token || nightscoutToken || envToken || '').trim();
      if (finalUrl && !/^https?:\/\//i.test(finalUrl)) finalUrl = 'https://' + finalUrl;
      finalUrl = finalUrl.replace(/\/$/, '');

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
        nightscoutUrl: finalUrl,
        nightscoutToken: finalToken,
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
        tir_low_mg: this.parseSlicerValue(tir_low_mg, null),
        tir_high_mg: this.parseSlicerValue(tir_high_mg, null),
        tir_low_mmol: this.normalizeMmol(tir_low_mmol),
        tir_high_mmol: this.normalizeMmol(tir_high_mmol),
        time_in_range_low_mg: this.parseSlicerValue(time_in_range_low_mg, null),
        time_in_range_high_mg: this.parseSlicerValue(time_in_range_high_mg, null),
        time_in_range_low_mmol: this.normalizeMmol(time_in_range_low_mmol),
        time_in_range_high_mmol: this.normalizeMmol(time_in_range_high_mmol),
        prediction_horizon_min: [15,30,60].includes(Number(prediction_horizon_min || prediction_horizon_mins)) ? Number(prediction_horizon_min || prediction_horizon_mins) : 30,
        debug_force_alert: (typeof debug_force_alert==='string' ? debug_force_alert : null),
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
      nightscoutUrl: String(o.nightscout_url || o.ns_url || o.nightscout || '').trim(),
      nightscoutToken: String(o.nightscout_token || o.ns_token || o.nightscoutToken || '').trim(),
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
      tir_low_mg: this.parseSlicerValue(o.tir_low_mg, null),
      tir_high_mg: this.parseSlicerValue(o.tir_high_mg, null),
      tir_low_mmol: this.normalizeMmol(o.tir_low_mmol),
      tir_high_mmol: this.normalizeMmol(o.tir_high_mmol),
      time_in_range_low_mg: this.parseSlicerValue(o.time_in_range_low_mg, null),
      time_in_range_high_mg: this.parseSlicerValue(o.time_in_range_high_mg, null),
      time_in_range_low_mmol: this.normalizeMmol(o.time_in_range_low_mmol),
      time_in_range_high_mmol: this.normalizeMmol(o.time_in_range_high_mmol),
      prediction_horizon_min: [15,30,60].includes(Number(o.prediction_horizon_min || o.prediction_horizon_mins)) ? Number(o.prediction_horizon_min || o.prediction_horizon_mins) : 30,
    };
  }

  /* ---------- UI helpers ---------- */
  convertToDisplay(mgdlValue, targetUnit) {
    return targetUnit === UNITS.MMOL ? (mgdlValue / 18).toFixed(1) : Math.round(mgdlValue);
  }
  getTrendArrow(dir) {
    const map = { DoubleUp: '⇈', SingleUp: '↑', FortyFiveUp: '↗', Flat: '→', FortyFiveDown: '↘', SingleDown: '↓', DoubleDown: '⇊', NONE: '-', 'NOT COMPUTABLE': '→' };
    return map[dir] || '→';
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

  // Añade la predicción al final de la línea 2 del header
  async formatForG1WithPrediction(data, settings) {
    try {
      const base = await this.formatForG1(data, settings);  // base sin predicción
      let horizonMin = Number(settings.prediction_horizon_min || settings.prediction_horizon_mins || 30);
      if (!Number.isFinite(horizonMin) || horizonMin <= 0) horizonMin = 30;

      const predShort = await this.buildPredictionShort(settings, horizonMin);
      if (!predShort) return base;

      const parts = base.split('\n');
      const l1 = parts[0] || '';
      const l2 = (parts.length > 1 ? parts[1] : '');
      const sep = ' · ';
      const rest = parts.slice(2);
      return `${l1}\n${l2}${sep}${predShort}${rest.length ? `\n${rest.join('\n')}` : ''}`;
    } catch (_) {
      return await this.formatForG1(data, settings);        // fallback sin recursión
    }
  }

  /**
   * Build a short prediction string using Nightscout devicestatus (predBGs) if available.
   * Fallback: linear extrapolation from last two SGVs.
   * Returns like "145 mg/dL @30m" or "6.7 mmol/L @30m"
   */
  async buildPredictionShort(settings, horizonMin = 30) {
    const unit = settings.units || UNITS.MGDL;
    const fmt = (mgdl) => this.convertToDisplay(mgdl, unit) + ` @${horizonMin}m`;

    // Normalize base URL
    let base = (settings.nightscoutUrl || '').trim();
    if (!base) return null;
    if (!base.startsWith('http')) base = 'https://' + base;
    base = base.replace(/\/$/, '');
    const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
    const headers = { 'User-Agent': 'MentraOS-Nightscout/2.10.0' };

    // 1) Try devicestatus for predBGs
    try {
      const { data } = await axios.get(`${base}/api/v1/devicestatus.json?count=5`, { params, timeout: 8000, headers });
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      for (const ds of arr) {
        const predBGs = (ds && (ds.predBGs || ds?.openaps?.suggested?.predBGs || ds?.ar2?.predBGs)) || null;
        if (!predBGs) continue;
        const series = predBGs.IOB || predBGs.COB || predBGs.UAM || predBGs.ZT || (Array.isArray(predBGs) ? predBGs : null);
        if (series && Array.isArray(series) && series.length) {
          const idx = Math.max(0, Math.min(series.length - 1, Math.round(horizonMin / 5)));
          const mgdl = Number(series[idx]);
          if (Number.isFinite(mgdl)) return fmt(mgdl);
        }
      }
    } catch (_) {}

    // 2) Fallback: linear extrapolation from last entries
    try {
      const { data } = await axios.get(`${base}/api/v1/entries.json?count=4`, { params, timeout: 8000, headers });
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      if (arr.length >= 2) {
        const a = arr[0], b = arr[1];
        const mgNow = Number(a.sgv ?? a.glucose);
        const tNow = new Date(a.dateString || a.date || a.mills || a.sysTime).getTime();
        const mgPrev = Number(b.sgv ?? b.glucose);
        const tPrev = new Date(b.dateString || b.date || b.mills || b.sysTime).getTime();
        if (Number.isFinite(mgNow) && Number.isFinite(mgPrev) && Number.isFinite(tNow) && Number.isFinite(tPrev) && tNow > tPrev) {
          const ratePerMin = (mgNow - mgPrev) / ((tNow - tPrev) / 60000);
          let mgPred = mgNow + ratePerMin * horizonMin;
          mgPred = Math.max(40, Math.min(400, mgPred));
          return fmt(mgPred);
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
    return '│'.repeat(blocks);
  }
  /* Compose second line: TIR label+bar and treatments.
     Siempre baja los tratamientos a siguiente línea (sin punto delante). */
  composeTirLines(settings, tirLine, bar, tLine) {
    const labelBar = `${tirLine}${bar ? ' ' + bar : ''}`;
    try {
      // ALWAYS move treatments to the next line (both languages / any unit)
      let clean = (tLine || '')
        .replace(/^CH\/Ins hoy: /, '')
        .replace(/^Carbs\/Ins today: /, '')
        // drop any " · Last: ..." or " · Últ: ..." and all after
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
      const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.10.0' } });
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
        return { ts, carbs: Number(t.carbs) || 0, insulin: Number(t.insulin) || 0 };
      }).filter(e => e.ts && (e.carbs > 0 || e.insulin > 0));

      let windowed, label;
      if (hours === 'day') {
        windowed = events.filter(e => new Date(e.ts).toLocaleDateString(locale, { timeZone: tz }) === todayStr);
        label = settings.language === 'es' ? 'hoy' : 'today';
      } else {
        const since = Date.now() - Math.max(1, hours) * 60 * 60 * 1000;
        windowed = events.filter(e => e.ts >= since);
        label = `${hours}h`;
      }

      if (!windowed.length) return { label, totalCarbs: 0, totalInsulin: 0, last: null, count: 0 };

      let totalCarbs = 0, totalInsulin = 0, last = null;
      for (const e of windowed) {
        if (e.carbs > 0) totalCarbs += e.carbs;
        if (e.insulin > 0) totalInsulin += e.insulin;
        if (!last || e.ts > last.ts) last = e;
      }
      return { label, totalCarbs, totalInsulin, last, count: windowed.length };
    } catch (_) { return null; }
  }

  formatTreatmentsLine(summary, settings) {
    if (!summary) return '';
    const { label, totalCarbs, totalInsulin, last } = summary;
    const lang = settings.language || 'en';
    const round1 = x => Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
    const c = round1(totalCarbs);
    const i = round1(totalInsulin);
    let lastStr = '';
    if (last && (last.carbs > 0 || last.insulin > 0)) {
      const langSettings = this.getLanguageSettings(settings);
      const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
      const t = new Date(last.ts).toLocaleTimeString(langSettings.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const parts = [];
      if (last.carbs > 0) parts.push(`${round1(last.carbs)}g`);
      if (last.insulin > 0) parts.push(`${round1(last.insulin)}U`);
      lastStr = parts.length ? (lang === 'es' ? ` · Últ: ${parts.join(', ')} ${t}` : ` · Last: ${parts.join(', ')} ${t}`) : '';
    }
    return (lang === 'es'
      ? (label === 'hoy' ? `CH/Ins hoy: ${c}g / ${i}U` : `CH/Ins ${label}: ${c}g / ${i}U`)
      : (label === 'today' ? `Carbs/Ins today: ${c}g / ${i}U` : `Carbs/Ins ${label}: ${c}g / ${i}U`)
    ) + lastStr;
  }

  /* ---------- datos glucose ---------- */
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
    const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};

    let lastError;
    for (const endpoint of endpoints) {
      try {
        const { data } = await axios.get(endpoint, { params, timeout: 12000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.10.0' } });
        const reading = Array.isArray(data) ? data[0] : data;
        if (!reading) throw new Error('Empty response');
        const glucose = Number(reading.sgv ?? reading.glucose);
        if (!Number.isFinite(glucose)) throw new Error('No glucose data found');
        const dateValue = reading.date || reading.dateString || reading.sysTime;
        if (!dateValue) throw new Error('No date found');
        return {
          sgv: glucose,
          date: typeof dateValue === 'string' ? new Date(dateValue).getTime() : dateValue,
          direction: reading.direction || reading.trend || 'NONE',
          device: reading.device || 'unknown'
        };
      } catch (error) {
        lastError = error;
        continue;
      }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------- UI ---------- */
  showClamped(session, sessionId, text, maxLines = 5) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const finalText = lines.slice(0, maxLines).join('\n');
    session.layouts.showTextWall(finalText);
  }
  hideDisplay(session, sessionId) {
    try { session.layouts.showTextWall(''); } catch {}
  }

  /* ---------- ciclo de vida ---------- */
  async onSession(session, sessionId, userId) {
    try {
      const s = await this.getUserSettings(session);
      if (!s.nightscoutUrl) {
        this.showClamped(session, sessionId, s.language==='es' ? 'Configura URL y token\nde Nightscout en ajustes' : 'Set Nightscout URL + token\nin settings');
        return;
      }

      // arranque: lectura + TIR + tratamientos + animación
      const data = await this.getGlucoseData(s);
      this.lastGoodEntry.set(sessionId, data);
      const tirRes = this.updateDailyTirState(sessionId, data.sgv, data.date, s);
      const header = await this.formatForG1WithPrediction(data, s);
      if (s.enable_advanced_mode) {
        let tLine = '';
        try { tLine = this.formatTreatmentsLine(await this.getRecentTreatments(s, 'day'), s); } catch {}
        await this.animateTIRFill(session, sessionId, s, header, tirRes.tirPct, tLine);
      } else {
        this.showClamped(session, sessionId, header);
      }
      const t = setTimeout(() => this.hideDisplay(session, sessionId), s.display_duration_ms || 5000);
      this.displayTimers.set(sessionId, t);

      /* reloj cambio de día */
      const dayWatch = setInterval(() => {
        const st = this.dailyTirState.get(sessionId);
        const currentDay = this.getLocalDayStr(Date.now(), s);
        if (!st || st.dayStr !== currentDay) {
          this.dailyTirState.set(sessionId, { dayStr: currentDay, total: 0, inRange: 0 });
        }
      }, 60000);
      this.dayWatchTimers.set(sessionId, dayWatch);

      await this.startNormalOperation(session, sessionId, userId, s);
    } catch (e) {
      console.error('Error en sesión:', e);
      this.showClamped(session, sessionId, 'Error: revisa configuración');
    }
  }

  async showInitialAndHide(session, sessionId, s) {
    // mantenido para compat, ya usamos onSession directo
  }

  async startNormalOperation(session, sessionId, userId, s) {
    const tick = async () => {
      try {
        const s2 = await this.getUserSettings(session); // siempre fresco
        const data = await this.getGlucoseData(s2);
        this.lastGoodEntry.set(sessionId, data);
        const header = await this.formatForG1WithPrediction(data, s2);

        let extra = '';
        if (s2.enable_advanced_mode) {
          const tir = this.updateDailyTirState(sessionId, data.sgv, data.date, s2);
          const tLine = this.formatTreatmentsLine(await this.getRecentTreatments(s2, 'day'), s2);
          await this.animateTIRFill(session, sessionId, s2, header, tir.tirPct, tLine);
        } else {
          this.showClamped(session, sessionId, header);
        }
        const t = setTimeout(() => this.hideDisplay(session, sessionId), s2.display_duration_ms || 5000);
        const prev = this.displayTimers.get(sessionId);
        if (prev) clearTimeout(prev);
        this.displayTimers.set(sessionId, t);
      } catch (e) {
        // fallback si hay último bueno
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const s2 = await this.getUserSettings(session).catch(()=>s);
          const fallback = await this.formatForG1WithPrediction(cached, s2);
          this.showClamped(session, sessionId, fallback + '\n(cached)');
          const t = setTimeout(() => this.hideDisplay(session, sessionId), s2.display_duration_ms || 5000);
          const prev = this.displayTimers.get(sessionId);
          if (prev) clearTimeout(prev);
          this.displayTimers.set(sessionId, t);
        } else {
          this.showClamped(session, sessionId, 'Error');
        }
      }
    };

    // Primer tick programado
    const intervalMs = Math.max(3, Number(s.updateInterval||5)) * 60 * 1000;
    const interval = setInterval(tick, intervalMs);
    this.activeSessions.set(sessionId, { session, userId, settings: s, updateInterval: interval });
  }

  /* ---------- eventos ---------- */
  setupEventHandlers(session, sessionId, userId) {
    try {
      session.events?.onButtonPress?.(async () => {
        await this.showGlucoseQuick(session, sessionId);
      });
      session.events?.onHeadUp?.(async () => {
        await this.showGlucoseQuick(session, sessionId);
      });
    } catch {}
  }

  async showGlucoseQuick(session, sessionId) {
    try {
      const s = await this.getUserSettings(session);
      const data = await this.getGlucoseData(s);
      this.lastGoodEntry.set(sessionId, data);
      const header = await this.formatForG1WithPrediction(data, s);
      if (s.enable_advanced_mode) {
        const tir = this.updateDailyTirState(sessionId, data.sgv, data.date, s);
        const tLine = this.formatTreatmentsLine(await this.getRecentTreatments(s, 'day'), s);
        await this.animateTIRFill(session, sessionId, s, header, tir.tirPct, tLine);
      } else {
        this.showClamped(session, sessionId, header);
      }
      const t = setTimeout(() => this.hideDisplay(session, sessionId), s.display_duration_ms || 5000);
      const prev = this.displayTimers.get(sessionId);
      if (prev) clearTimeout(prev);
      this.displayTimers.set(sessionId, t);
    } catch (e) {
      const cached = this.lastGoodEntry.get(sessionId);
      if (cached) {
        const s = await this.getUserSettings(session).catch(()=>({language:'en', display_duration_ms:5000, units:UNITS.MGDL}));
        const fallback = await this.formatForG1WithPrediction(cached, s);
        this.showClamped(session, sessionId, fallback + '\n(cached)');
        const t = setTimeout(() => this.hideDisplay(session, sessionId), s.display_duration_ms || 5000);
        const prev = this.displayTimers.get(sessionId);
        if (prev) clearTimeout(prev);
        this.displayTimers.set(sessionId, t);
      } else {
        this.showClamped(session, sessionId, s.language==='es' ? 'Error: sin datos' : 'Error: no data');
      }
    }
  }
}


/* ---------- bootstrap ---------- */
const app = new NightscoutMentraApp({
  apiKey: MENTRAOS_API_KEY,
  packageName: PACKAGE_NAME,
  port: PORT
});

const startApp = async () => {
  try {
    if (typeof app.listen === 'function') {
      await app.listen();
    } else if (typeof app.start === 'function') {
      await app.start();
    } else if (typeof app.run === 'function') {
      await app.run();
    } else if (typeof app.init === 'function') {
      // Algunos SDKs separan init() y el server real lo inicia la plataforma
      await app.init();
    } else {
      console.log('SDK lifecycle handled externally (no listen/start/run/init exposed).');
    }
    console.log(`MentraOS app ready on :${PORT}`);
  } catch (err) {
    console.error('Fatal boot error:', err);
    process.exit(1);
  }
};

startApp();
