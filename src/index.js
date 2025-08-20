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
const { AppServer, BitmapUtils } = require('@mentra/sdk');
const axios = require('axios');
const path = require('path');
const fs = require('fs/promises');

/* ---------- CONFIG ---------- */
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;
const DEBUG_BOOT_BITMAP = (process.env.DEBUG_BOOT_BITMAP || '').toLowerCase(); // "low" | "high" | "bell" | ""

if (!MENTRAOS_API_KEY) {
  console.error('⛔ MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

// --- helper BMP (fuera de la clase) ---
function validateBmpBasic(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 54
    && buffer.toString('ascii', 0, 2) === 'BM';
}

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
    this._bitmapCache = new Map();      // nombre.bmp (lowercase) -> hex
    this._activeBitmapAnimation = new Map(); // sessionId -> controller
  }

  /* ---------- helpers ---------- */
  __delay(ms) { return new Promise(res => setTimeout(res, ms)); }
  __clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  __easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  __getEasingFunction(type = 'cubic') {
    if (type === 'smooth') return (t) => t * t * (3 - 2 * t);
    if (type === 'linear') return (t) => t;
    return (t) => this.__easeInOutCubic(t);
  }
  __barFromRatio(ratio, slots) {
    const n = Math.round(this.__clamp01(ratio) * slots);
    const filled = '¦'.repeat(n);
    const empty = '·'.repeat(Math.max(0, slots - n));
    return `[${filled}${empty}]`;
  }
  _scheduleHide(sessionId, ms) {
    if (!sessionId) return;
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
    return (v !== null && Number.isFinite(v)) ? (v >= 30 ? v / 10 : v) : null;
  }

  /* ---------- alertas / límites ---------- */
  getAlertLimits(settings) {
    if (!settings) return { low: 70, high: 250 };
    const lowMg = this.parseSlicerValue(settings.low_alert_mg, NaN);
    const highMg = this.parseSlicerValue(settings.high_alert_mg, NaN);
    if (Number.isFinite(lowMg) && Number.isFinite(highMg)) {
      return { low: Math.round(lowMg), high: Math.round(highMg) };
    }
    const lowM = this.normalizeMmol(settings.low_alert_mmol) ?? 3.9;
    const highM = this.normalizeMmol(settings.high_alert_mmol) ?? 13.9;
    return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
  }

  getHysteresisMg(settings) {
    if (!settings) return 5;
    const mg = this.validateSlicerValue(settings.alert_hysteresis_mg, 0, 50, NaN);
    if (Number.isFinite(mg)) return mg;
    const mmol = this.normalizeMmol(settings.alert_hysteresis_mmol);
    if (Number.isFinite(mmol)) return Math.round(mmol * 18);
    return 5; // por defecto ±5 mg/dL
  }

  /* ---------- lectura de settings ---------- */
  async getUserSettings(session) {
    try {
      const keys = [
        'nightscout_url', 'nightscout_token', 'update_interval',
        'low_alert_mg', 'high_alert_mg', 'low_alert_mmol', 'high_alert_mmol',
        'alerts_enabled', 'language', 'timezone', 'units',
        'enable_head_up_display',
        'display_duration_s', 'alert_duration_s', 'alert_cooldown_min',
        'show_tir_bar', 'show_range_bar',
        'display_duration_ms', 'alert_duration_ms', 'alert_cooldown_ms',
        'enable_advanced_mode', 'advanced_mode_enabled',
        'alert_hysteresis_mg', 'alert_hysteresis_mmol',
        'tir_low_mg', 'tir_high_mg', 'tir_low_mmol', 'tir_high_mmol',
        'time_in_range_low_mg', 'time_in_range_high_mg', 'time_in_range_low_mmol', 'time_in_range_high_mmol',
        'prediction_horizon_min', 'prediction_horizon_mins',
        'prediction_enable_robust', 'prediction_window_points',
        'prediction_max_gap_min', 'prediction_min_slope_mg_per_min', 'prediction_min_r2',
        'debug_force_alert'
      ];
      const vals = await Promise.all(keys.map(k => session.settings.get(k).catch(() => null)));
      const kv = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));

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
        prediction_horizon_min: [15, 30, 60].includes(Number(kv.prediction_horizon_min || kv.prediction_horizon_mins))
          ? Number(kv.prediction_horizon_min || kv.prediction_horizon_mins) : 30,
        prediction_enable_robust: this.toBool(kv.prediction_enable_robust) !== false,
        prediction_window_points: this.validateSlicerValue(kv.prediction_window_points, 4, 20, 12),
        prediction_max_gap_min: this.validateSlicerValue(kv.prediction_max_gap_min, 2, 15, 10),
        prediction_min_slope_mg_per_min: this.validateSlicerValue(kv.prediction_min_slope_mg_per_min, 0, 5, 0.25),
        prediction_min_r2: this.validateSlicerValue(kv.prediction_min_r2, 0, 1, 0.35),
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
      prediction_horizon_min: [15, 30, 60].includes(Number(o.prediction_horizon_min || o.prediction_horizon_mins))
        ? Number(o.prediction_horizon_min || o.prediction_horizon_mins) : 30,
      prediction_enable_robust: this.toBool(o.prediction_enable_robust) !== false,
      prediction_window_points: this.validateSlicerValue(o.prediction_window_points, 4, 20, 12),
      prediction_max_gap_min: this.validateSlicerValue(o.prediction_max_gap_min, 2, 15, 10),
      prediction_min_slope_mg_per_min: this.validateSlicerValue(o.prediction_min_slope_mg_per_min, 0, 5, 0.25),
      prediction_min_r2: this.validateSlicerValue(o.prediction_min_r2, 0, 1, 0.35),
      debug_force_alert: (typeof o.debug_force_alert === 'string' ? o.debug_force_alert : null)
    };
  }

  /* ---------- UI helpers ---------- */
  convertToDisplay(mgdlValue, targetUnit) {
    if (!Number.isFinite(mgdlValue)) return 'N/A';
    return targetUnit === UNITS.MMOL ? (mgdlValue / 18).toFixed(1) : Math.round(mgdlValue);
  }
  formatRangeByUnits(lowMgdl, highMgdl, units) {
    if (!Number.isFinite(lowMgdl) || !Number.isFinite(highMgdl)) return 'N/A';
    const isMmol = String(units || '').toLowerCase().includes('mmol');
    if (isMmol) {
      const low = (lowMgdl / 18).toFixed(1);
      const high = (highMgdl / 18).toFixed(1);
      return `${low}-${high} mmol/L`;
    }
    return `${Math.round(lowMgdl)}-${Math.round(highMgdl)} mg/dL`;
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
    const langMap = {
      es: { locale: 'es-ES', timezone: 'Europe/Madrid' },
      en: { locale: 'en-US', timezone: 'America/New_York' }
    };
    return langMap[settings.language] || langMap.en;
  }
  validateTimezone(tz) {
    const valid = [
      'Europe/Madrid', 'Atlantic/Canary', 'Europe/London', 'Europe/Paris',
      'Europe/Berlin', 'Europe/Rome', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
      'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'
    ];
    return valid.includes(tz) ? tz : 'UTC';
  }
  _getLocaleBundle(sessionId, settings) {
    if (!sessionId || !settings) return { lang: 'en', locale: 'en-US', tz: 'UTC' };
    const cached = this._sessionLocale.get(sessionId);
    if (cached && cached.lang === settings.language && cached.tz === (settings.timezone || null)) return cached;
    const langSettings = this.getLanguageSettings(settings);
    const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const b = { lang: settings.language || 'en', locale: langSettings.locale, tz };
    this._sessionLocale.set(sessionId, b);
    return b;
  }

  async formatForG1(data, settings, sessionId) {
    if (!data || !settings || !sessionId) return 'Error: datos incompletos';
    const display = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const trend = this.getTrendArrow(data.direction);
    const b = this._getLocaleBundle(sessionId, settings);
    const readingTime = new Date(data.date);
    const timeStr = readingTime.toLocaleTimeString(b.locale, { timeZone: b.tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const minutesAgo = Math.max(0, Math.floor((Date.now() - data.date) / 60000));
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
  _ensureHttp(sessionId, settings) {
    if (!sessionId || !settings) return null;
    let cli = this._http.get(sessionId);
    const baseRaw = (settings.nightscoutUrl || '').trim();
    if (!baseRaw) return null;
    const base = /^https?:\/\//i.test(baseRaw) ? baseRaw : ('https://' + baseRaw);
    const baseURL = base.replace(/\/$/, '');
    if (!cli || cli.defaults.baseURL !== baseURL || cli.defaults.params?.token !== settings.nightscoutToken) {
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

  async buildPredictionShort(settings, sessionId = 'default', lowOverrideMg = null, highOverrideMg = null) {
    if (!settings || !sessionId) return null;
    const lim = this.getAlertLimits(settings);
    const lowThreshold = Number.isFinite(lowOverrideMg) ? lowOverrideMg : lim.low;
    const highThreshold = Number.isFinite(highOverrideMg) ? highOverrideMg : lim.high;
    const horizon = Number(settings.prediction_horizon_min || 30);
    const maxSteps = Math.max(3, Math.min(12, Math.round(horizon / 5)));
    const isMmol = String(settings.units || '').toLowerCase().includes('mmol');
    const toDisp = (mgdl) => isMmol ? (mgdl / 18).toFixed(1) : String(Math.round(mgdl));
    const http = this._ensureHttp(sessionId, settings);
    if (!http) return null;

    try {
      const { data } = await http.get(`/api/v1/devicestatus.json?count=1`).catch(() => ({ data: null }));
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
                if (Number(series[i]) <= lowThreshold) return `↓${toDisp(lowThreshold)} @${i * 5}m`;
              }
            }
            if (currentSgv < highThreshold) {
              for (let i = 1; i < series.length; i++) {
                if (Number(series[i]) >= highThreshold) return `↑${toDisp(highThreshold)} @${i * 5}m`;
              }
            }
          }
        }
      }
    } catch (_) {}

    try {
      const maxPoints = Number(settings.prediction_window_points || 12);
      const maxGapMin = Number(settings.prediction_max_gap_min || 10);
      const minSlopeCfg = Number(settings.prediction_min_slope_mg_per_min || 0.25);
      const minR2Cfg = Number(settings.prediction_min_r2 || 0.35);
      const robustEnabled = settings.prediction_enable_robust !== false;

      const { data } = await http.get(`/api/v1/entries.json?count=${Math.max(4, Math.min(20, maxPoints * 2))}`).catch(() => ({ data: [] }));
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      const raw = arr
        .map(r => ({
          mgdl: Number(r.sgv ?? r.glucose),
          ts: new Date(r.date || r.dateString).getTime()
        }))
        .filter(p => Number.isFinite(p.mgdl) && Number.isFinite(p.ts))
        .sort((a, b) => a.ts - b.ts);

      let seg = [];
      for (let i = raw.length - 1; i >= 0; i--) {
        if (seg.length === 0) { seg.unshift(raw[i]); continue; }
        const head = seg[0];
        const gapMin = (head.ts - raw[i].ts) / 60000;
        if (gapMin <= maxGapMin) { seg.unshift(raw[i]); } else { break; }
      }
      if (seg.length > maxPoints) seg = seg.slice(seg.length - maxPoints);
      if (seg.length >= 4) {
        const last = seg[seg.length - 1];
        const t0 = last.ts;
        let xs = seg.map(p => (p.ts - t0) / 60000);
        let ys = seg.map(p => p.mgdl);

        const regress = (xv, yv) => {
          const n = xv.length;
          const meanX = xv.reduce((a, b) => a + b, 0) / n;
          const meanY = yv.reduce((a, b) => a + b, 0) / n;
          let num = 0, den = 0;
          for (let i = 0; i < n; i++) {
            const dx = xv[i] - meanX;
            const dy = yv[i] - meanY;
            num += dx * dy;
            den += dx * dx;
          }
          const slope = den > 0 ? (num / den) : 0;
          const intercept = meanY - slope * meanX;
          let sse = 0, sst = 0;
          for (let i = 0; i < n; i++) {
            const pred = intercept + slope * xv[i];
            const err = yv[i] - pred;
            sse += err * err;
            const dev = yv[i] - meanY;
            sst += dev * dev;
          }
          const r2 = sst > 0 ? (1 - sse / sst) : 0;
          const residuals = xv.map((x, i) => yv[i] - (intercept + slope * x));
          const absRes = residuals.map(Math.abs).sort((a, b) => a - b);
          const mid = Math.floor(absRes.length / 2);
          const mad = absRes.length % 2 ? absRes[mid] : (absRes[mid - 1] + absRes[mid]) / 2;
          return { slope, intercept, r2, residuals, mad, meanY };
        };

        let { slope, intercept, r2, residuals, mad } = regress(xs, ys);
        const resThresh = Math.max(12, 2.5 * (mad || 0));
        if (robustEnabled && resThresh > 0) {
          const kept = [];
          for (let i = 0; i < xs.length; i++) {
            if (Math.abs(residuals[i]) <= resThresh) kept.push(i);
          }
          if (kept.length >= 4 && kept.length < xs.length) {
            xs = kept.map(i => xs[i]);
            ys = kept.map(i => ys[i]);
            ({ slope, intercept, r2 } = regress(xs, ys));
          }
        }

        const mgNow = last.mgdl;
        const minSlope = minSlopeCfg;
        const minR2 = minR2Cfg;
        if (Math.abs(slope) >= minSlope && r2 >= minR2) {
          if (slope < 0 && mgNow > lowThreshold) {
            const minutes = (lowThreshold - mgNow) / slope;
            if (minutes > 0 && minutes <= horizon) return `↓${toDisp(lowThreshold)} @${Math.round(minutes)}m`;
          }
          if (slope > 0 && mgNow < highThreshold) {
            const minutes = (highThreshold - mgNow) / slope;
            if (minutes > 0 && minutes <= horizon) return `↑${toDisp(highThreshold)} @${Math.round(minutes)}m`;
          }
        }
      }
    } catch (_) {}

    try {
      const { data } = await http.get(`/api/v1/entries.json?count=2`).catch(() => ({ data: [] }));
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
  getLocalDayStr(ts, settings, sessionId = 'default') {
    if (!ts || !settings) return '';
    const b = this._getLocaleBundle(sessionId, settings);
    return new Date(ts).toLocaleDateString(b.locale, { timeZone: b.tz });
  }
  buildTirBar(tirPct) {
    if (tirPct === null || !Number.isFinite(tirPct)) return '';
    const blocks = Math.max(0, Math.min(20, Math.floor(tirPct / 5)));
    return '¦'.repeat(blocks);
  }
  composeTirLines(settings, tirLine, bar, tLine) {
    if (!settings || !tirLine) return '';
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
    if (!sessionId || !settings || !Number.isFinite(readingMgdl) || !readingTs) {
      return { tirPct: null, total: 0 };
    }
    const range = this.getAlertLimits(settings);
    const dayStr = this.getLocalDayStr(readingTs, settings, sessionId);
    let st = this.dailyTirState.get(sessionId);
    if (!st || st.dayStr !== dayStr) st = { dayStr, total: 0, inRange: 0 };
    st.total += 1;
    if (readingMgdl >= range.low && readingMgdl <= range.high) st.inRange += 1;
    this.dailyTirState.set(sessionId, st);
    return { tirPct: st.total > 0 ? Math.round((st.inRange / st.total) * 100) : null, total: st.total };
  }

  async getRecentTreatments(settings, hours = 'day', sessionId = 'default') {
    if (!settings || !sessionId) return null;
    try {
      const http = this._ensureHttp(sessionId, settings);
      if (!http) return null;
      const { data } = await http.get(`/api/v1/treatments.json?count=1000`).catch(() => ({ data: [] }));
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
  formatTreatmentsLine(summary, settings, sessionId = 'default') {
    if (!summary || !settings) return '';
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
  async getTodayEntries(settings, sessionId = 'default') {
    if (!settings || !sessionId) return [];
    const http = this._ensureHttp(sessionId, settings);
    if (!http) throw new Error('URL no configurada');
    const { data } = await http.get(`/api/v1/entries/sgv.json?count=400`).catch(() => ({ data: [] }));
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

  async getGlucoseData(settings, sessionId = 'default') {
    if (!settings || !sessionId) throw new Error('Parámetros inválidos');
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
        return {
          sgv: glucose,
          date: typeof dateValue === 'string' ? new Date(dateValue).getTime() : dateValue,
          direction: reading.direction || reading.trend || 'NONE'
        };
      } catch (error) { lastError = error; continue; }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------- UI ---------- */
  showClamped(session, sessionId, text, maxLines = 5) {
    if (!session || !sessionId || !text) return;
    try {
      const lines = String(text).replace(/\r/g, '').split('\n');
      while (lines.length && lines[0].trim() === '') lines.shift();
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      const out = lines.slice(0, maxLines).join('\n');
      const last = this._lastShownText.get(sessionId);
      if (last === out) return;
      this._lastShownText.set(sessionId, out);
      session.layouts.showTextWall(out);
    } catch (e) {
      console.error('Error in showClamped:', e);
    }
  }
  hideDisplay(session, sessionId) {
    if (!session || !sessionId) return;
    try {
      const anim = this._activeBitmapAnimation.get(sessionId);
      if (anim && typeof anim.stop === 'function') {
        try { anim.stop(); } catch (_) {}
      }
      this._activeBitmapAnimation.delete(sessionId);
      try { session.layouts.clearView?.(); } catch (_) {}
      session.layouts.showTextWall('');
      this._lastShownText.delete(sessionId);
    } catch (e) {
      console.error('Error in hideDisplay:', e);
    }
  }

  async _ensureBitmapsLoaded() {
    if (this._bitmapCache.size) return true;

    const candidates = [
      path.resolve(process.cwd(), 'assets', 'bitmaps'),
      path.resolve(__dirname, 'assets', 'bitmaps'),
      path.resolve(__dirname, '.', 'assets', 'bitmaps'),
      path.resolve(__dirname, '..', 'assets', 'bitmaps'),
      path.resolve(process.cwd(), 'public', 'assets', 'bitmaps'),
      path.resolve(process.cwd(), 'src', 'assets', 'bitmaps'),
    ];
    console.log('📁 Directorios candidatos:', candidates);

    for (const baseDir of candidates) {
      try {
        console.log(`🔍 Explorando: ${baseDir}`);
        const entries = await fs.readdir(baseDir);
        const bmpFiles = entries.filter(f => f.toLowerCase().endsWith('.bmp'));
        console.log(`📄 Archivos BMP encontrados:`, bmpFiles);

        for (const f of bmpFiles) {
          const full = path.join(baseDir, f);
          try {
            let hex = null;
            if (BitmapUtils?.loadBmpAsHex) {
              hex = await BitmapUtils.loadBmpAsHex(full);
            } else {
              const buffer = await fs.readFile(full);
              if (!validateBmpBasic(buffer)) {
                console.log(`❌ ${f} no es un BMP válido (signature/header)`);
                continue;
              }
              hex = buffer.toString('hex');
            }

            if (hex && BitmapUtils?.validateBmpHex) {
              try {
                const v = await BitmapUtils.validateBmpHex(hex);
                if (!v || v.isValid === false) {
                  console.log(`❌ ${f} inválido según SDK`);
                  continue;
                }
              } catch (e) {
                console.log(`⚠️ Validación SDK falló en ${f}:`, e.message);
              }
            }

            this._bitmapCache.set(f.toLowerCase(), hex);
            console.log(`✅ ${f} cacheado`);
          } catch (e) {
            console.log(`❌ Error cargando ${f}:`, e.message);
          }
        }

        if (this._bitmapCache.size > 0) break;
      } catch (e) {
        console.log(`❌ Error explorando ${baseDir}:`, e.message);
      }
    }

    console.log(`📊 Cache final: ${this._bitmapCache.size} bitmaps`);
    if (!this._bitmapCache.size) console.warn('⚠️ No BMPs cargados. Probados:', candidates);
    return this._bitmapCache.size > 0;
  }

  _getBitmapHex(name) {
    if (!name) return null;
    const key = String(name).toLowerCase();
    return this._bitmapCache.get(key) || null;
  }

  _stopActiveAnimation(sessionId) {
    if (!sessionId) return;
    const anim = this._activeBitmapAnimation.get(sessionId);
    if (anim && typeof anim.stop === 'function') {
      try { anim.stop(); } catch (_) {}
    }
    this._activeBitmapAnimation.delete(sessionId);
  }

  async _playAlertBitmap(session, sessionId, type, intervalMs, durationMs) {
    if (!session || !sessionId || !type) return false;
    try {
      const ok = await this._ensureBitmapsLoaded();
      if (!ok) return false;

      this._stopActiveAnimation(sessionId);
      try { session.layouts.clearView?.(); } catch (_) {}
      try { session.layouts.showTextWall(''); } catch (_) {}
      this._lastShownText.delete(sessionId);

      const pickHex = (...names) => {
        for (const n of names) {
          const h = this._getBitmapHex(n);
          if (h) return h;
        }
        return null;
      };

      const bell = pickHex(
  'alert-bell-576x100.bmp','alert-bell-526x100.bmp','alert-bell.bmp',
  'alert_bell-576x100.bmp','alert_bell-526x100.bmp','alert_bell.bmp','bell.bmp'
);
const lowBmp = pickHex(
  'alert-low-576x100.bmp','alert-low-526x100.bmp','alert-low.bmp',
  'alert_low-576x100.bmp','alert_low-526x100.bmp','alert_low.bmp','low.bmp'
);
const highBmp = pickHex(
  'alert-high-576x100.bmp','alert-high-526x100.bmp','alert-high.bmp',
  'alert_high-576x100.bmp','alert_high-526x100.bmp','alert_high.bmp','high.bmp'
);
const pick = type === 'low' ? lowBmp : highBmp;

      const frames = [];
      if (bell && pick) frames.push(bell, pick);
      else if (pick) frames.push(pick);
      else if (bell) frames.push(bell);

      if (!frames.length) {
        console.log('❌ Sin frames bitmap disponibles');
        return false;
      }

      const L = session.layouts;
      const speed = Math.max(200, intervalMs || 600);
      const total = Math.max(1000, durationMs || 15000) + 80;

      if (typeof L.showBitmapAnimation === 'function') {
        console.log(`▶️ Animación con API nativa`);
        const controller = L.showBitmapAnimation(frames, speed, true);
        this._activeBitmapAnimation.set(sessionId, controller);
        setTimeout(() => {
          try { controller?.stop?.(); } catch (_) {}
          this._activeBitmapAnimation.delete(sessionId);
          this.hideDisplay(session, sessionId);
          console.log(`⏹️ Animación bitmap detenida`);
        }, total);
        return true;
      }

      const showHex = L.showBitmapHex || L.showBitmap || L.showImageHex;
      if (typeof showHex !== 'function') {
        console.log('❌ Runtime sin soporte de bitmaps');
        return false;
      }
      console.log(`▶️ Animación con polyfill`);
      let i = 0;
      const tick = () => {
        try { showHex.call(L, frames[i]); } catch (e) { console.log('❌ pintar frame:', e.message); }
        i = (i + 1) % frames.length;
      };
      tick();
      const handle = setInterval(tick, speed);
      this._activeBitmapAnimation.set(sessionId, { stop: () => clearInterval(handle) });
      setTimeout(() => {
        try { clearInterval(handle); } catch (_) {}
        this._activeBitmapAnimation.delete(sessionId);
        this.hideDisplay(session, sessionId);
        console.log(`⏹️ Animación bitmap detenida (polyfill)`);
      }, total);
      return true;
    } catch (e) {
      console.log(`❌ Error en animación bitmap:`, e.message);
      return false;
    }
  }
  /* ---------- ciclo de vida ---------- */
  async onSession(session, sessionId, userId) {
    if (!session || !sessionId || !userId) {
      console.error('Invalid session parameters');
      return;
    }
    console.log(`✅ Nueva sesión: ${sessionId} para ${userId}`);
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
      if (DEBUG_BOOT_BITMAP === 'low' || DEBUG_BOOT_BITMAP === 'high' || DEBUG_BOOT_BITMAP === 'bell') { try { await this._playAlertBitmap(session, sessionId, DEBUG_BOOT_BITMAP, 500, 5000); } catch (_) {} }

      this.setupEventHandlers(session, sessionId, userId);

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
    if (!session || !sessionId || !settings) return;
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

  async animateTIRFill(session, sessionId, s, headerText, tirPct, tLine = '', extraLine = '') {
    if (!session || !sessionId || !s || !headerText) return;
    try {
      const showBar = !!s.show_tir_bar;
      const anims = s.enable_animations !== false;
      if (!showBar || !anims || tirPct == null || !Number.isFinite(tirPct)) {
        const bar = showBar && tirPct != null ? ' ' + this.__barFromRatio(tirPct / 100, 20) : '';
        const tirLine = tirPct == null ? (s.language === 'es' ? 'TIR hoy: n/d' : 'TIR: n/a') : (s.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
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
      const target = Math.floor(this.__clamp01(tirPct / 100) * slots);

      const tirLine = (s.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
      const base = (filled) =>
        `${headerText}\n${tirLine} ${this.__barFromRatio(filled / slots, slots)}`
        + (tLine ? `\n${tLine}` : '')
        + (extraLine ? `\n${extraLine}` : '');

      this.showClamped(session, sessionId, base(0));
      if (leadIn > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < leadIn) {
          if (this._renderToken.get(sessionId) !== token) return;
          await this.__delay(30);
        }
      }

      const tStart = Date.now();
      let last = -1;
      const ease = this.__getEasingFunction(String(s.animation_type || 'cubic'));
      while (true) {
        if (this._renderToken.get(sessionId) !== token) return;
        const t = (Date.now() - tStart) / totalMs;
        const clamped = Math.max(0, Math.min(1, t));
        const eased = ease(clamped);
        const filled = Math.min(target, Math.floor(eased * target));
        if (filled !== last) {
          this.showClamped(session, sessionId, base(filled));
          last = filled;
        }
        if (clamped >= 1) break;
        await this.__delay(33);
      }
      this.showClamped(session, sessionId, base(target));
    } catch (_) {
      try {
        const bar = this.__barFromRatio((tirPct || 0) / 100, 20);
        const tirLine = tirPct == null ? (s.language === 'es' ? 'TIR hoy: n/d' : 'TIR: n/a') : (s.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
        const line2 = `${tirLine} ${bar}` + (tLine ? `\n${tLine}` : '');
        const out = extraLine ? `${headerText}\n${line2}\n${extraLine}` : `${headerText}\n${line2}`;
        this.showClamped(session, sessionId, out);
      } catch {}
    }
  }

  setupEventHandlers(session, sessionId, userId) {
    if (!session || !sessionId || !userId) return;
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
            this.alertLatch.delete(sessionId);
          }

          const dbgChanged = (old.debug_force_alert || '') !== (settings.debug_force_alert || '');
          if (dbgChanged) {
            this.alertHistory.delete(sessionId);
            this.alertLatch.delete(sessionId);
          }
          sd.settings = settings;
          this.activeSessions.set(sessionId, sd);

// Forzado de alerta para pruebas: independiente de Nightscout
try {
  const dbg = String(settings.debug_force_alert || '').toLowerCase();
  if (dbg === 'low' || dbg === 'high') {
    let data;
    try { data = await this.getGlucoseData(settings, sessionId); } catch (_) {
      const lim = this.getAlertLimits(settings);
      const fake = (dbg === 'low') ? (lim.low - 1) : (lim.high + 1);
      data = { sgv: fake, date: Date.now(), direction: 'Flat' };
    }
    await this.triggerAnimatedAlert(session, sessionId, data, settings, dbg);
  }
} catch (_) {}


          try {
            let dNow = null;
            try { dNow = await this.getGlucoseData(settings, sessionId); await this.checkAlerts(session, sessionId, dNow, settings); } catch (_) {}
            const isEs = (settings.language || 'en') === 'es';
            const limits = this.getAlertLimits(settings);
            const hystMg = this.getHysteresisMg(settings);
            const hystMmol = (hystMg / 18).toFixed(1);

            const alarmState = this.getAlarmEchoState(sessionId, dNow?.sgv, settings);
            const stateStr = isEs
              ? (alarmState === 'low' ? 'Activa: BAJA' : alarmState === 'high' ? 'Activa: ALTA' : 'Sin alarma')
              : (alarmState === 'low' ? 'Active: LOW' : alarmState === 'high' ? 'Active: HIGH' : 'No alarm');

            const line1 = isEs ? 'Ajustes guardados' : 'Settings saved';
            const line2 = `Units: ${settings.units} · HeadUp: ${settings.enable_head_up_display ? 'ON' : 'OFF'}`;
            const line3 = (isEs ? 'TIR' : 'TIR') + `: ${this.formatRangeByUnits(limits.low, limits.high, settings.units)}`;
            const line4 = (isEs ? 'Avanzado' : 'Advanced') + `: ${settings.enable_advanced_mode ? 'ON' : 'OFF'}`;
            const line5 = (isEs ? 'Alarmas' : 'Alerts') + `: ${settings.alertsEnabled ? 'ON' : 'OFF'} · Hyst: ±${hystMg} mg/dL (±${hystMmol} mmol/L) · ${stateStr}`;

            this.showClamped(session, sessionId, [line1, line2, line3, line4, line5].join('\n'));
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
          await this.animateTIRFill(session, sessionId, s, baseLine, { tirPct }.tirPct, tLine, minMaxLine);
          this._scheduleHide(sessionId, s.display_duration_ms || 4000);
        } catch (e) {
          this.showClamped(session, sessionId, (this._getLocaleBundle(sessionId, { language: 'es' }).lang === 'es' ? 'Error al mostrar' : 'Display error'));
          this._scheduleHide(sessionId, 2000);
        }
      });

      session.events?.onDisconnected?.(() => {
        this.cleanupSession(sessionId);
        session.logger?.info('Session disconnected');
      });
    } catch (error) {
      console.error('⚠️ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  cleanupSession(sessionId) {
    if (!sessionId) return;
    const t = this.displayTimers.get(sessionId); if (t) clearTimeout(t); this.displayTimers.delete(sessionId);
    const sd = this.activeSessions.get(sessionId); if (sd?.updateInterval) clearInterval(sd.updateInterval);
    const dw = this.dayWatchTimers.get(sessionId); if (dw) clearInterval(dw); this.dayWatchTimers.delete(sessionId);
    const debounce = this._settingsDebounce.get(sessionId); if (debounce) clearTimeout(debounce); this._settingsDebounce.delete(sessionId);
    this._stopActiveAnimation(sessionId);
    this._http.delete(sessionId);
    this._sessionLocale.delete(sessionId);
    this.activeSessions.delete(sessionId);
    this.alertHistory.delete(sessionId);
    this.alertLatch.delete(sessionId);
    this.headUpLastShown.delete(sessionId);
    this.dailyTirState.delete(sessionId);
    this.lastGoodEntry.delete(sessionId);
    this._renderToken.delete(sessionId);
    this._lastShownText.delete(sessionId);
  }
  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    if (!session || !sessionId) return;
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
    if (!session || !sessionId || !userId || !initialSettings) return;
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
    if (!session || !sessionId || !data || !settings) return;
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const cooldown = settings.alert_cooldown_ms || 600000;
    const lastAlertTs = this.alertHistory.get(sessionId);
    const latch = this.alertLatch.get(sessionId) || null;
    const h = this.getHysteresisMg(settings);

    if (latch === 'low' && mgdl >= (limits.low + h)) {
      this.alertLatch.set(sessionId, null);
    } else if (latch === 'high' && mgdl <= (limits.high - h)) {
      this.alertLatch.set(sessionId, null);
    }

    if (this.alertLatch.get(sessionId)) return;

    if (lastAlertTs && Date.now() - lastAlertTs < cooldown) return;

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
  if (!session || !sessionId || !data || !settings || !type) return;
  const displayValue = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
  const unit = settings.units || UNITS.MGDL;
  const lang = settings.language || 'en';
  const msgs = { en: { low: `LOW GLUCOSE!`, high: `HIGH GLUCOSE!` }, es: { low: `¡GLUCOSA BAJA!`, high: `¡GLUCOSA ALTA!` } };
  const baseText = `${msgs[lang][type]}
${displayValue} ${unit}`;
  const alertDuration = settings.alert_duration_ms || 15000;
  const blinkInterval = 600;

  try {
    const shown = await this._playAlertBitmap(session, sessionId, type, blinkInterval, alertDuration);
    if (shown) return;
  } catch (_) {}

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
  }, alertDuration));
}
  /* ---------- util: estado eco de alarma (para ECO de ajustes) ---------- */
  getAlarmEchoState(sessionId, mgdl, settings) {
    try {
      if (!settings) return null;
      const latch = this.alertLatch.get(sessionId) || null;
      if (latch) return latch;
      if (!Number.isFinite(mgdl)) return null;
      const lim = this.getAlertLimits(settings);
      if (mgdl <= lim.low) return 'low';
      if (mgdl >= lim.high) return 'high';
      return null;
    } catch (_) { return null; }
  }

  /* ---------- util: detectar cambio en límites de alerta ---------- */
  alertLimitsChanged(oldSettings, newSettings) {
    if (!oldSettings) return true;
    const ol = this.getAlertLimits(oldSettings || {});
    const nl = this.getAlertLimits(newSettings || {});
    const oh = this.getHysteresisMg(oldSettings || {});
    const nh = this.getHysteresisMg(newSettings || {});
    return ol.low !== nl.low || ol.high !== nl.high || oh !== nh;
  }
} // <-- cierre de la clase NightscoutMentraApp

/* ---------- Bootstrap del servidor ---------- */
const app = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
});

app.listen(PORT, () => {
  console.log(`🚀 Nightscout MentraOS server listening on port ${PORT} (pkg: ${PACKAGE_NAME})`);
});

process.on('SIGTERM', () => {
  try { console.log('🛑 SIGTERM recibido, cerrando...'); } catch (_) {}
  process.exit(0);
});

process.on('SIGINT', () => {
  try { console.log('🛑 SIGINT recibido, cerrando...'); } catch (_) {}
  process.exit(0);
});
