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
  __easeInOutCubic(t) { return t < 0.5 ?
    4 * t * t * t :
    1 - Math.pow(-2 * t + 2, 3) / 2; }
  __getEasingFunction(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('linear')) return (t) => t;
    if (n.includes('quad')) return (t) => t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
    return this.__easeInOutCubic.bind(this);
  }

  /* ---------- settings & HTTP ---------- */
  toBool(v) {
    if (typeof v === 'boolean') return v;
    if (v == null) return false;
    return ['1','true','yes','y','on'].includes(String(v).toLowerCase());
  }
  parseSlicerValue(v, defVal = null) {
    const n = Number(v);
    return Number.isFinite(n) ? n : defVal;
  }
  validateSlicerValue(v, min, max, defVal) {
    const n = Number(v);
    if (!Number.isFinite(n)) return defVal;
    return Math.min(max, Math.max(min, n));
  }
  normalizeMmol(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n*10)/10 : null;
  }
  mgdlToUnit(mgdl, units) {
    if (!Number.isFinite(mgdl)) return null;
    if (units === UNITS.MMOL) return Math.round((mgdl / 18) * 10) / 10;
    return mgdl;
  }
  formatRangeByUnits(lowMg, highMg, units) {
    if (units === UNITS.MMOL) {
      return `${(lowMg/18).toFixed(1)}–${(highMg/18).toFixed(1)} mmol/L`;
    }
    return `${lowMg}–${highMg} mg/dL`;
  }

  _getLocaleBundle(sessionId, settingsOrNull) {
    const cached = this._sessionLocale.get(sessionId);
    if (cached) return cached;
    const lang = (settingsOrNull && settingsOrNull.language) || 'en';
    const tz = (settingsOrNull && settingsOrNull.timezone) || 'Europe/Madrid';
    const locale = lang === 'es' ? 'es-ES' : 'en-GB';
    const bundle = { tz, locale, lang };
    this._sessionLocale.set(sessionId, bundle);
    return bundle;
  }

  _ensureHttp(sessionId, settings) {
    if (!settings || !settings.nightscoutUrl) return null;
    const key = `${sessionId}`;
    let client = this._http.get(key);
    if (!client) {
      client = axios.create({
        baseURL: settings.nightscoutUrl.replace(/\/+$/,''),
        timeout: 8000,
        headers: settings.nightscoutToken ? { 'API-SECRET': settings.nightscoutToken } : {}
      });
      this._http.set(key, client);
    }
    return client;
  }

  async getUserSettings(session) {
    const all = await session.getAppSettings();
    const o = Array.isArray(all) ? all.reduce((acc, it) => {
      acc[it.key] = it.value;
      return acc;
    }, {}) : (all || {});

    const units = (o.units === 'mmol' || o.units === 'mmol/L') ? UNITS.MMOL : UNITS.MGDL;
    const ui = this.validateSlicerValue(o.update_interval_min || o.update_interval_mins || o.update_interval, 1, 30, 5);
    const displayMs = this.validateSlicerValue(o.display_duration_ms || o.headup_duration_ms, 1000, 15000, 5000);
    const alertMs = this.validateSlicerValue(o.alert_duration_ms, 1000, 300000, 20000);
    const coolMs  = this.validateSlicerValue(o.alert_cooldown_ms, 10000, 7200000, 600000);

    // 🔧 Por defecto, si no llega el toggle, lo dejamos ACTIVADO para evitar pantalla en negro.
    const rawHeadUp = o.enable_head_up_display;
    const headUpEnabled = (rawHeadUp == null) ? true : this.toBool(rawHeadUp);

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
      enable_head_up_display: headUpEnabled,
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
    return targetUnit === UNITS.MMOL ?
      (Math.round((mgdlValue/18)*10)/10).toFixed(1) :
      String(Math.round(mgdlValue));
  }
  trendToArrow(dir) {
    const d = String(dir||'').toUpperCase();
    if (['DOUBLEUP','UPUP'].includes(d)) return '↑↑';
    if (['SINGLEUP','UP'].includes(d)) return '↑';
    if (['FORTYFIVEUP'].includes(d)) return '↗';
    if (['FLAT','NONE'].includes(d)) return '→';
    if (['FORTYFIVEDOWN'].includes(d)) return '↘';
    if (['SINGLEDOWN','DOWN'].includes(d)) return '↓';
    if (['DOUBLEDOWN','DOWNDOWN'].includes(d)) return '↓↓';
    return '·';
  }

  /* ---------- predicción simplificada ---------- */
  async getRecentEntriesForPrediction(settings, sessionId, points=12) {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) throw new Error('URL no configurada');
    const count = Math.max(4, Math.min(40, points));
    const { data } = await http.get(`/api/v1/entries/sgv.json?count=${count}`).catch(()=>({data:[]}));
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    const pts = arr
      .map(r => ({ v: Number(r.sgv ?? r.glucose), t: (typeof r.date === 'string' ? Date.parse(r.date) : r.date) }))
      .filter(p => Number.isFinite(p.v) && p.t);
    return pts.reverse(); // de más antiguo a más nuevo
  }

  simpleLinearPrediction(pts, horizonMin=30, minSlope=0.25, minR2=0.35) {
    if (!Array.isArray(pts) || pts.length < 4) return null;
    const xs = [], ys = [];
    const t0 = pts[0].t;
    for (const p of pts) { xs.push((p.t - t0) / 60000); ys.push(p.v); }
    const n = xs.length;
    const sx = xs.reduce((a,b)=>a+b,0), sy = ys.reduce((a,b)=>a+b,0);
    const sxx = xs.reduce((a,b)=>a+b*b,0), sxy = xs.reduce((a,b,i)=>a+xs[i]*ys[i],0);
    const denom = (n*sxx - sx*sx);
    if (Math.abs(denom) < 1e-6) return null;
    const m = (n*sxy - sx*sy) / denom;
    const b = (sy - m*sx) / n;

    // R^2
    const ymean = sy/n;
    const ssTot = ys.reduce((a,y)=>a+(y-ymean)**2,0);
    const ssRes = ys.reduce((a,y,i)=>a+(y-(m*xs[i]+b))**2,0);
    const r2 = (ssTot <= 1e-6) ? 1 : 1 - ssRes/ssTot;

    if (Math.abs(m) < minSlope || r2 < minR2) return null;

    const yH = m * (xs[xs.length-1] + horizonMin) + b;
    return { m, b, r2, yH };
  }

  async formatForG1WithPrediction(data, settings, sessionId='default') {
    const { lang, tz } = this._getLocaleBundle(sessionId, settings);
    const units = settings.units;
    const vDisp = this.convertToDisplay(data.sgv, units);
    const arrow = this.trendToArrow(data.direction);
    const t = new Date(data.date).toLocaleTimeString(lang==='es'?'es-ES':'en-GB', {
      timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false
    });

    let line1 = `${vDisp} ${units} ${arrow} @ ${t}`;

    // predicción no-avanzada: sólo si cruza límites (≤60/≥180 mg/dL) o si hay modelo válido
    let predStr = '';
    try {
      const pts = await this.getRecentEntriesForPrediction(settings, sessionId, settings.prediction_window_points);
      const model = this.simpleLinearPrediction(pts, settings.prediction_horizon_min, settings.prediction_min_slope_mg_per_min, settings.prediction_min_r2);
      if (model) {
        const yH = model.yH;
        const yDisp = this.convertToDisplay(yH, units);
        predStr = lang === 'es' ? `Pred: ${yDisp} ${units} @${settings.prediction_horizon_min}m`
                                : `Pred: ${yDisp} ${units} @${settings.prediction_horizon_min}m`;
      } else {
        const mg = data.sgv;
        if (mg <= 60 || mg >= 180) {
          const yDisp = this.convertToDisplay(mg, units);
          predStr = lang === 'es' ? `Pred: ${yDisp} ${units} @${settings.prediction_horizon_min}m`
                                  : `Pred: ${yDisp} ${units} @${settings.prediction_horizon_min}m`;
        }
      }
    } catch (_) {}

    return predStr ? `${line1}\n${predStr}` : line1;
  }

  /* ---------- TIR ---------- */
  getAlertLimits(settings) {
    if (!settings) return { low: 70, high: 180 };
    if (settings.units === UNITS.MMOL) {
      return {
        low: Math.round((settings.low_alert_mmol ?? 3.9) * 18),
        high: Math.round((settings.high_alert_mmol ?? 10) * 18)
      };
    }
    return { low: settings.low_alert_mg ?? 70, high: settings.high_alert_mg ?? 180 };
  }
  getHysteresisMg(settings) {
    if (!settings) return 5;
    return settings.units === UNITS.MMOL
      ? Math.round((settings.alert_hysteresis_mmol ?? 0.3) * 18)
      : (settings.alert_hysteresis_mg ?? 5);
  }

  getLocalDayStr(ts, settings, sessionId='default') {
    const b = this._getLocaleBundle(sessionId, settings);
    return new Date(ts).toLocaleDateString(b.locale, { timeZone: b.tz });
  }

  updateDailyTirState(sessionId, mgdl, ts, settings) {
    const st = this.dailyTirState.get(sessionId) || { dayStr: this.getLocalDayStr(ts, settings, sessionId), total: 0, inRange: 0 };
    const day = this.getLocalDayStr(ts, settings, sessionId);
    if (st.dayStr !== day) { st.dayStr = day; st.total = 0; st.inRange = 0; }
    st.total += 1;
    const lim = this.getAlertLimits(settings);
    if (Number.isFinite(mgdl) && mgdl >= lim.low && mgdl <= lim.high) st.inRange += 1;
    this.dailyTirState.set(sessionId, st);
    const tirPct = (st.total > 0) ? Math.round((st.inRange / st.total) * 100) : null;
    return { ...st, tirPct };
  }

  __barFromRatio(r, slots=20) {
    const n = Math.max(0, Math.min(slots, Math.round(r*slots)));
    const filled = '█'.repeat(n);
    const empty = '░'.repeat(slots-n);
    return `[${filled}${empty}]`;
  }

  buildTirBar(pct) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    return this.__barFromRatio(p/100, 20);
  }

  /* ---------- obtención de tratamientos ---------- */
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
      lastStr = parts.length ?
        (lang === 'es' ? ` · Últ: ${parts.join(', ')} ${t}` : ` · Last: ${parts.join(', ')} ${t}`) : '';
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

      // Semilla TIR + watcher de cambio de día
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

  _scheduleHide(sessionId, ms) {
    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
    const t = setTimeout(() => {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      this.hideDisplay(sd.session, sessionId);
    }, Math.max(500, ms|0));
    this.displayTimers.set(sessionId, t);
  }

  async triggerAnimatedAlert(session, sessionId, data, settings, type) {
    if (!session || !sessionId || !data || !settings || !type) return;
    const baseText = await this.formatForG1WithPrediction(data, settings, sessionId);
    const blinkInterval = 550;
    const alertDuration = settings.alert_duration_ms || 20000;

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
        const line2 = `${tirLine}${bar}` + (tLine ? `\n${tLine}` : '');
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
              // 🔧 FIX: .vals -> ...vals
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
    if (dbg === 'low') alertType = 'low';
    else if (dbg === 'high') alertType = 'high';
    else {
      if (mgdl <= limits.low) alertType = 'low';
      else if (mgdl >= limits.high) alertType = 'high';
    }

    if (!alertType) return;

    this.alertHistory.set(sessionId, Date.now());
    this.alertLatch.set(sessionId, alertType);

    await this.triggerAnimatedAlert(session, sessionId, data, settings, alertType);
  }

  parseSettingsFromArray(arr) {
    if (!Array.isArray(arr)) return {};
    const out = {};
    for (const s of arr) {
      if (!s || typeof s.key !== 'string') continue;
      out[s.key] = s.value;
    }
    return this.getUserSettings({ getAppSettings: async () => Object.entries(out).map(([key, value]) => ({ key, value })) });
  }
} // <-- cierre de la clase NightscoutMentraApp

/* ---------- Bootstrap del servidor ---------- */
const app = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
});

(function startHealthServer() {
  try {
    const http = require('http');
    const port = Number(process.env.PORT || PORT || 3000);
    const server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/healthz' || req.url === '/readyz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Nightscout MentraOS is running');
    });
    server.listen(port, '0.0.0.0', () => {
      console.log(`✅ Health server listening on ${port} (pkg: ${PACKAGE_NAME})`);
    });
  } catch (e) {
    console.error('❌ Failed to start health server:', e);
  }
})();

(async () => {
  console.log('>>> Iniciando bootstrap del SDK Mentra...');
  const port = Number(process.env.PORT || PORT || 3000);
  try {
    if (typeof app.start === 'function') {
      await app.start(port);
      console.log(`🚀 MentraOS started on port ${port} [start()]`);
    } else if (typeof app.listen === 'function') {
      app.listen(port, () => console.log(`🚀 MentraOS listening on port ${port} [listen()]`));
    } else if (app.server && typeof app.server.listen === 'function') {
      app.server.listen(port, () => console.log(`🚀 MentraOS listening on port ${port} [server.listen()]`));
    } else {
      console.log('ℹ️ SDK no expone start()/listen(); continuamos con health server.');
    }
  } catch (e) {
    console.error('⚠️ SDK start failed, health server sigue activo:', e?.message || e);
  }
})();

process.on('SIGTERM', () => {
  try { console.log('🛑 SIGTERM recibido, cerrando...'); } catch (_) {}
  process.exit(0);
});

process.on('SIGINT', () => {
  try { console.log('🛑 SIGINT recibido, cerrando...'); } catch (_) {}
  process.exit(0);
});
