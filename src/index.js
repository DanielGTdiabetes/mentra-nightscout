"use strict";
/**
 * Nightscout MentraOS v2.10.0
 * HUD texto + TIR-bar │ CH/Ins día + Min/Max sólo gesto │ reset diario
 * ES/EN + mg/dL/mmol │ 5 líneas max │ cache last-good-entry
 * Settings en segundos/minutos + toggle barra TIR
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
  }

  /* ---------- helpers ---------- */
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
    return (v !== null && Number.isFinite(v)) ? (v > 30 ? v / 10 : v) : null;
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
      // Read extra console settings (optional; defaults applied if missing)
      const animation_speed = await session.settings.get('animation_speed');
      const enable_animations = await session.settings.get('enable_animations');
      const tir_anim_ms = await session.settings.get('tir_anim_ms');
      const tir_fadeout_ms = await session.settings.get('tir_fadeout_ms');
      const prediction_horizon_min = await session.settings.get('prediction_horizon_min');
      const official_prediction_only = await session.settings.get('official_prediction_only');
      const blink_on_prediction = await session.settings.get('blink_on_prediction');
      const blink_cycles = await session.settings.get('blink_cycles');
      const blink_interval_ms = await session.settings.get('blink_interval_ms');
    const headup_cooldown_ms = await session.settings.get('headup_cooldown_ms');
    const blink_alert_style = await session.settings.get('prediction_alert_style');


      const showTirBar = (show_tir_bar === null && show_range_bar === null)
        ? true
        : (this.toBool(show_tir_bar) || this.toBool(show_range_bar));

      return {
        nightscoutUrl: String(url || '').trim() || '',
        nightscoutToken: String(token || '').trim() || '',
        updateInterval: ui,
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 90, 70),
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
     
        // Anim & Prediction controls
        animation_speed: (['slow','normal','fast'].includes(String(animation_speed||'normal')) ? String(animation_speed) : 'normal'),
        enable_animations: (enable_animations === undefined || enable_animations === null) ? true : this.toBool(enable_animations),
        tir_anim_ms: this.validateSlicerValue(tir_anim_ms, 200, 1200, 500),
        tir_fadeout_ms: this.validateSlicerValue(tir_fadeout_ms, 80, 600, 160),
        prediction_horizon_min: [15,30,60].includes(Number(prediction_horizon_min)) ? Number(prediction_horizon_min) : 30,
        official_prediction_only: this.toBool(official_prediction_only),
        blink_on_prediction: (blink_on_prediction === undefined || blink_on_prediction === null) ? true : this.toBool(blink_on_prediction),
        blink_cycles: this.validateSlicerValue(blink_cycles, 1, 8, 4),
        blink_interval_ms: this.validateSlicerValue(blink_interval_ms, 80, 600, 180),
      headup_cooldown_ms: this.validateSlicerValue(headup_cooldown_ms, 0, 30000, 4000),
      prediction_alert_style: (['blink','pulse','solid'].includes(String(blink_alert_style||'pulse')) ? String(blink_alert_style||'pulse') : 'pulse'),

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
      nightscoutUrl: String(o.nightscout_url || '').trim() || '',
      nightscoutToken: String(o.nightscout_token || '').trim() || '',
      updateInterval: ui,
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 40, 90, 70),
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
   
      // Anim & Prediction controls
      animation_speed: (['slow','normal','fast'].includes(String(o.animation_speed||'normal')) ? String(o.animation_speed) : 'normal'),
      enable_animations: (o.enable_animations === undefined || o.enable_animations === null) ? true : this.toBool(o.enable_animations),
      tir_anim_ms: this.validateSlicerValue(o.tir_anim_ms, 200, 1200, 500),
      tir_fadeout_ms: this.validateSlicerValue(o.tir_fadeout_ms, 80, 600, 160),
      prediction_horizon_min: [15,30,60].includes(Number(o.prediction_horizon_min)) ? Number(o.prediction_horizon_min) : 30,
      official_prediction_only: this.toBool(o.official_prediction_only),
      blink_on_prediction: (o.blink_on_prediction === undefined || o.blink_on_prediction === null) ? true : this.toBool(o.blink_on_prediction),
      blink_cycles: this.validateSlicerValue(o.blink_cycles, 1, 8, 4),
      blink_interval_ms: this.validateSlicerValue(o.blink_interval_ms, 80, 600, 180),
      headup_cooldown_ms: this.validateSlicerValue(o.headup_cooldown_ms, 0, 30000, 4000),
      prediction_alert_style: (['blink','pulse','solid'].includes(String(o.prediction_alert_style)) ? String(o.prediction_alert_style) : 'pulse'),

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
    const timeStr = readingTime.toLocaleTimeString(langSettings.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const lang = settings.language || 'en';
    const timeAgo = minutesAgo <= 1 ? (lang === 'es' ? 'ahora' : 'now') : (lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    return `${display} ${settings.units || UNITS.MGDL} ${trend}\n${timeStr} (${timeAgo})`;
  }

  // Añade la predicción al final de la línea 2 del header
  async formatForG1WithPrediction(data, settings) {
    try {
      const base = await this.formatForG1(data, settings);  // ✅ base sin predicción
      let horizonMin = Number(settings.prediction_horizon_min || settings.prediction_horizon_mins || 30);
      if (!Number.isFinite(horizonMin) || horizonMin <= 0) horizonMin = 30;

      const predShort = await this.buildPredictionShort(settings, horizonMin);
      if (!predShort) return base;

      const parts = base.split('\n');
      const l1 = parts[0] || '';
      const l2 = (parts.length > 1 ? parts[1] : '');
      const sep = '   ·   ';
      const rest = parts.slice(2);
      return `${l1}\n${l2}${sep}${predShort}${rest.length ? `\n${rest.join('\n')}` : ''}`;
    } catch (_) {
      return await this.formatForG1(data, settings);        // ✅ fallback sin recursión
    }
  }

  /**
   * Build a short prediction string using Nightscout devicestatus (predBGs) if available.
   * Fallback: linear extrapolation from last two SGVs.
   * Returns like "145 mg/dL @30m" or "6.7 mmol/L @30m"
   */
  async buildPredictionShort(settings, horizonMin = 30) {
    const unit = settings.units || UNITS.MGDL;
    const fmt = (mgdl) => this.convertToDisplay(mgdl, unit) + ' ' + unit + ` @${horizonMin}m`;

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
          if (Number.isFinite(mgdl)) { this._lastPredictionMgdl = mgdl; return fmt(mgdl); }
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
          this._lastPredictionMgdl = mgPred; return fmt(mgPred);
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
    const blocks = Math.max(0, Math.min(20, Math.round(tirPct / 5)));
    return '│'.repeat(blocks);
  }
/* ---------- Animation & Prediction helpers ---------- */
async __sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
__SPEED_MAP = { slow: 1.35, normal: 1.0, fast: 0.75 };
__resolveMs(settings, base){ const mult = (this.__SPEED_MAP[(settings.animation_speed||'normal')] ?? 1.0); return Math.round(Math.max(60, Math.min(2000, base*mult))); }
__clamp01(x){ return Math.max(0, Math.min(1, x)); }
__barStep(r){ const slots=20; const n = Math.round(this.__clamp01(r)*slots); return '│'.repeat(n) + '·'.repeat(slots-n); }

/** Compose and animate TIR block as text (when advanced+show_tir_bar). */
async animateTIRText(session, sessionId, settings, headerText, tirLine, tirPct, tLine='', extraLine=''){
    try {
      const showBar = !(settings && settings.show_tir_bar === false);
      const allowAnim = !(settings && settings.enable_animations === false);
      const slots = Math.max(6, Math.min(24, Number(settings?.tir_slots || 14)));
      const pct = Number.isFinite(Number(tirPct)) ? Number(tirPct) : 0;
      const targetSlots = Math.max(0, Math.min(slots, Math.round((pct/100) * slots)));
      const cleanTreat = (tLine||'').replace(/\s+/g,' ').trim();
      const extras = extraLine ? `\n${extraLine}` : '';

      const self = this;
      function compose(nSlots){
        const ratio = slots ? (nSlots/slots) : 0;
        const bar = showBar ? ` [${self.__barStep(ratio)}]` : '';
        const l2 = `${tirLine}${bar}`;
        const tl = cleanTreat ? `\n${cleanTreat}` : '';
        return `${headerText}\n${l2}${tl}${extras}`;
      }

      // Static if no anim or no slots to fill
      if (!allowAnim || targetSlots <= 0){
        const txt = compose(targetSlots);
        self.showClamped(session, sessionId, txt);
        return txt;
      }

      // Frame pacing by slot increments (coalescing-friendly)
      const baseMs = self.__resolveMs(settings, Number(settings.tir_anim_ms||500));
      const maxFrames = Math.max(1, Math.ceil(baseMs/100)); // >=100ms/frame
      const frames = Math.max(1, Math.min(targetSlots, maxFrames));
      const step = Math.max(1, Math.floor(targetSlots/frames) || 1);
      const totalSteps = Math.ceil(targetSlots/step);
      const perFrame = Math.max(90, Math.min(160, Math.round(baseMs / totalSteps)));

      let lastText = '';
      let filled = 0;
      for (let i=0; i<totalSteps; i++){
        filled = Math.min(targetSlots, filled + step);
        const txt = compose(filled);
        if (txt !== lastText){
          self.showClamped(session, sessionId, txt);
          lastText = txt;
        }
        await self.__sleep(perFrame);
      }
      return lastText;
    } catch (e) {
      try { this.showClamped(session, sessionId, `${headerText}\n${tirLine}`); } catch(_){}
      return `${headerText}\n${tirLine}`;
    }
  }

/** Extracts "123 mg/dL @30m" or "6.8 mmol/L @30m" from any block of text. */
extractPredictionFromText(block){
  const rx = /([0-9]+(?:[\.,][0-9]+)?)\s*(mg\/dL|mmol\/L)\s*@\s*(\d+)m\b/;
  const m = String(block||'').match(rx);
  if (!m) return null;
  const v = parseFloat(String(m[1]).replace(',', '.'));
  const unit = m[2].toLowerCase();
  const minutes = parseInt(m[3], 10);
  const mgdl = unit.includes('mmol') ? v*18 : v;
  return { mgdl, minutes };
}

/** Blink a warning line if prediction is out-of-range (uses current alert limits). */
async blinkPredictionIfOut(session, sessionId, settings, renderedText){
    try {
      if (!settings) return;
      const style = settings.prediction_alert_style || 'pulse';
      const allowAnim = settings.blink_on_prediction !== false && (settings.enable_animations !== false);
      // 1) Extract or fallback to last prediction mg/dL
      let pred = this.extractPredictionFromText(renderedText);
      if (!pred && Number.isFinite(this._lastPredictionMgdl)) {
        pred = { mgdl: this._lastPredictionMgdl, minutes: Number(settings.prediction_horizon_min||30) };
      }
      if (!pred) return;
      // 2) Thresholds
      const limits = this.getAlertLimits(settings);
      const outLow  = pred.mgdl < limits.low;
      const outHigh = pred.mgdl > limits.high;
      const triggered = (outLow || outHigh);
      try { session.logger?.info('PRED-BLINK', { mgdl: pred.mgdl, limits, triggered, style }); } catch(_){}
      if (!triggered) return;

      const unit = settings.units || UNITS.MGDL;
      const vDisp = this.convertToDisplay(pred.mgdl, unit);
      const lang = settings.language || 'en';
      const warn = lang === 'es'
        ? (outLow ? `⚠️ Predicción BAJA: ${vDisp} ${unit}` : `⚠️ Predicción ALTA: ${vDisp} ${unit}`)
        : (outLow ? `⚠️ LOW prediction: ${vDisp} ${unit}` : `⚠️ HIGH prediction: ${vDisp} ${unit}`);

      // Fallback "solid" (si animaciones off o estilo = solid)
      if (!allowAnim || style === 'solid') {
        this.showClamped(session, sessionId, `${renderedText}\n${warn}`);
        return;
      }

      // 'pulse' y 'blink' — intervalos más largos para evitar coalescing
      const cycles = style === 'pulse' ? 3 : Math.max(1, Math.min(8, Number(settings.blink_cycles) || 4));
      const interval = Math.max(200, Math.min(1000, Number(settings.blink_interval_ms) || (style === 'pulse' ? 260 : 220)));
      const bust = ['\u2009', '\u200A', '']; // alterna invisibles para que el frame cambie

      for (let i=0; i<cycles; i++){
        this.showClamped(session, sessionId, `${renderedText}\n${warn}${bust[i % bust.length]}`);
        await this.__sleep(interval);
        this.showClamped(session, sessionId, `${renderedText}${bust[(i+1) % bust.length]}`);
        await this.__sleep(interval);
      }
    } catch(_){}
  }

/** Light blink for alerts (LOW/HIGH) to increase salience. */
async blinkAlertBlock(session, sessionId, text){
  try{
    for (let i=0;i<2;i++){
      this.showClamped(session, sessionId, text);
      await this.__sleep(200);
      this.showClamped(session, sessionId, text + '\\n'); // minimal change for blink
      await this.__sleep(200);
    }
  }catch(_){}
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
      const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.6' } });
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
      const t = new Date(last.ts).toLocaleTimeString(langSettings.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
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
    const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.6' } });
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
        const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.6' } });
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
      session.layouts.showTextWall(lines.slice(0, maxLines).join('\n'));
    } catch (_) {}
  }
  hideDisplay(session, sessionId) {
    try { session.layouts.showTextWall(''); } catch {}
  }

  /* ---------- ciclo de vida ---------- */
  async onSession(session, sessionId, userId) {
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);
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
      try { this.showClamped(session, sessionId, (settings && settings.language==='es' ? 'Error en sesión' : 'Session error')); } catch(_) {}
      const lang = (settings && settings.language) || 'en';
      this.showClamped(session, sessionId, lang === 'es' ? 'Error: revisa configuración' : 'Error: check settings');
    }
  }

  async showInitialAndHide(session, sessionId, settings) {
    // Show quick loading placeholder
    try { this.showClamped(session, sessionId, (settings.language==='es' ? 'Cargando…' : 'Loading…')); } catch(_) {}

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
        try { session.logger?.info('Startup -> animate TIR', { tirPct }); } catch(_) {}
      const __txt0 = await this.animateTIRText(session, sessionId, settings, formattedData, tirLine, tirPct, tLine);
      await this.blinkPredictionIfOut(session, sessionId, settings, __txt0);
      } else {
        this.showClamped(session, sessionId, formattedData);
      await this.blinkPredictionIfOut(session, sessionId, settings, formattedData);
      }
      const t = setTimeout(() => this.hideDisplay(session, sessionId), settings.display_duration_ms || 5000);
      this.displayTimers.set(sessionId, t);
    } catch (error) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const fallback = await this.formatForG1WithPrediction(cached, settings);
          this.showClamped(session, sessionId, fallback);
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
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
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
        let settings = null;
        try {
          settings = this.parseSettingsFromArray(settingsData || []);
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
          try {
            const savedMsg = (settings.language === 'es') ? 'Ajustes guardados' : 'Settings saved';
const lowLbl = (settings.language === 'es') ? 'Bajo' : 'Low';
const highLbl = (settings.language === 'es') ? 'Alto' : 'High';
const lines = [savedMsg];
if (settings.units === UNITS.MMOL) {
  lines.push(`${lowLbl}: ${settings.low_alert_mmol} mmol/L`);
  lines.push(`${highLbl}: ${settings.high_alert_mmol} mmol/L`);
} else {
  lines.push(`${lowLbl}: ${settings.low_alert_mg} mg/dL`);
  lines.push(`${highLbl}: ${settings.high_alert_mg} mg/dL`);
}
            lines.push(`Units: ${settings.units}`);
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
        try { session.logger?.info('HEAD_EVT', { pos: String((data&&data.position)||'') }); } catch(_) {}

        try {
          if (!data || String(data.position||'').toLowerCase() !== 'up') return;
          const sd = this.activeSessions.get(sessionId);
          const s = sd?.settings; if (!s) return; if (!s.enable_head_up_display) return;
          const now = Date.now(); const last = this.headUpLastShown.get(sessionId) || 0; const cooldown = Number(s.headup_cooldown_ms ?? 4000); if (now - last < cooldown) return; this.headUpLastShown.set(sessionId, now);
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
          const line2 = this.composeTirLines(s, tirLine, bar, tLine);
try { session.logger?.info('HeadUp -> animate TIR', { tirPct }); } catch(_) {}
// Animate TIR on head-up HUD
const __txtHUD = await this.animateTIRText(session, sessionId, s, baseLine, tirLine, tirPct, tLine, minMaxLine);
await this.blinkPredictionIfOut(session, sessionId, s, __txtHUD);
setTimeout(() => this.hideDisplay(session, sessionId), s.display_duration_ms || 4000);
} catch (e) {
          this.showClamped(session, sessionId, 'Error');
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
      console.error('❌ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    try {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      const settings = providedSettings || sd.settings || await this.getUserSettings(sd.session);
      const data = await this.getGlucoseData(settings);
      const { tirPct } = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      if (settings.enable_advanced_mode) {
        const header = await this.formatForG1WithPrediction(data, settings);
        const tirLine = tirPct === null
          ? (settings.language === 'es' ? 'TIR hoy: n/d' : 'TIR: n/a')
          : (settings.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
        const bar = !this.toBool(settings.show_tir_bar) || tirPct === null ? '' : this.buildTirBar(tirPct);
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day'); tLine = this.formatTreatmentsLine(sum, settings); } catch {}
        try { session.logger?.info('HUD gesture -> animate TIR', { tirPct }); } catch(_) {}
        const __txt1 = await this.animateTIRText(session, sessionId, settings, header, tirLine, tirPct, tLine);
      await this.blinkPredictionIfOut(session, sessionId, settings, __txt1);
      } else {
        const __txt2 = await this.formatForG1WithPrediction(data, settings);
      this.showClamped(session, sessionId, __txt2);
      await this.blinkPredictionIfOut(session, sessionId, settings, __txt2);
      }
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
      this.displayTimers.set(sessionId, timer);
    } catch (error) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const s = this.activeSessions.get(sessionId)?.settings || {};
          const txt = await this.formatForG1WithPrediction(cached, s);
          this.showClamped(session, sessionId, txt);
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
        try { this.showClamped(session, sessionId, (s.language==='es' ? 'Cargando…' : 'Loading…')); } catch(_) {}

      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const sd = this.activeSessions.get(sessionId);
        const s = (sd && sd.settings) ? sd.settings : await this.getUserSettings(session);
        const d = await this.getGlucoseData(s);
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
    const display = this.convertToDisplay(mgdl, settings.units || UNITS.MGDL);
    const last = this.alertHistory.get(sessionId);
    const cooldown = settings.alert_cooldown_ms || 600000;
    if (last && Date.now() - last < cooldown) return;
    const msgs = {
      en: { low: `🚨 LOW GLUCOSE!\n${display} ${settings.units || UNITS.MGDL}`, high: `🚨 HIGH GLUCOSE!\n${display} ${settings.units || UNITS.MGDL}` },
      es: { low: `🚨 ¡GLUCOSA BAJA!\n${display} ${settings.units || UNITS.MGDL}`, high: `🚨 ¡GLUCOSA ALTA!\n${display} ${settings.units || UNITS.MGDL}` }
    };
    const lang = settings.language || 'en';
    let msg = null;
    if (mgdl <= limits.low) { msg = msgs[lang]?.low || msgs.en.low; this.alertHistory.set(sessionId, Date.now()); }
    else if (mgdl >= limits.high) { msg = msgs[lang]?.high || msgs.en.high; this.alertHistory.set(sessionId, Date.now()); }
    if (msg) {
      this.showClamped(session, sessionId, msg);
      await this.blinkAlertBlock(session, sessionId, msg);
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), settings.alert_duration_ms || 15000);
      this.displayTimers.set(sessionId, timer);
      session.logger?.warn('Alert sent', { type: mgdl <= limits.low ? 'low' : 'high', value: mgdl });
    }
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
  console.error('❌ Error iniciando servidor:', err);
  process.exit(1);
});
console.log('🚀 Nightscout MentraOS v2.10.0 — HUD texto + TIR-bar │ CH/Ins día + Min/Max gesto + reset diario');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.10.0',
  activeSessions: server.activeSessions.size
}));
setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
