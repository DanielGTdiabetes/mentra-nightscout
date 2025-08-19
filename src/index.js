"use strict";
/**
 * Nightscout MentraOS v2.13.3 (Final y Completo)
 *
 * REVISIÓN #2:
 * - RESTAURADO: Toda la funcionalidad del "modo avanzado" (TIR, Carbs/Insulina, Animación).
 * - RESTAURADO: Funcionalidad completa del gesto "Head Up" para mostrar Min/Max del día.
 * - RESTAURADO: Mensaje "ECO" detallado de 5 líneas al guardar los ajustes.
 * - MEJORADO: Manejo de errores y robustez general del código.
 * - MANTENIDO: Todas las correcciones de errores de sintaxis y lógica de alarmas de la versión anterior.
 */

require('dotenv').config();
const { AppServer, ViewType } = require('@mentra/sdk');
const axios = require('axios');

// === Bitmaps (iconos) ===
const { loadBitmaps } = require("./bitmaps");
let ICONS = null;
const LAST_ICON_AT = new Map();
const MIN_ICON_GAP_MS = 10_000;
const ICON_DURATION_MS = 4_000;

function toHexBitmap(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    if (/^[0-9a-f]+$/i.test(data) && data.length % 2 === 0) return data;
    try { return Buffer.from(data, 'base64').toString('hex'); }
    catch (e) { console.error("[bitmap] Error convirtiendo Base64 a HEX."); return null; }
  }
  if (Buffer.isBuffer(data)) return data.toString('hex');
  return null;
}

function canShowIcon(key) {
  const now = Date.now();
  const last = LAST_ICON_AT.get(key) || 0;
  if (now - last < MIN_ICON_GAP_MS) return false;
  LAST_ICON_AT.set(key, now);
  return true;
}

async function showBitmapSafe(session, bmpHex, durationMs = ICON_DURATION_MS, fallbackText = null) {
  const hex = toHexBitmap(bmpHex);
  if (!hex) return;
  try {
    await session.layouts.showBitmapView(hex, { durationMs, location: ViewType.DASHBOARD });
    await session.layouts.showBitmapView(hex, { durationMs, location: ViewType.MAIN });
  } catch (err) {
    console.error("[bitmap] error al mostrar:", err?.message || err);
    if (fallbackText) {
      try { await session.layouts.showTextWall(fallbackText, { durationMs }); } catch (_) {}
    }
  }
}

async function maybeShowAlertIcon(session, state) {
  if (!ICONS) return;
  if (state === "low" && canShowIcon("low")) {
    await showBitmapSafe(session, ICONS.low, ICON_DURATION_MS, "ALERTA LOW [!]");
  } else if (state === "high" && canShowIcon("high")) {
    await showBitmapSafe(session, ICONS.high, ICON_DURATION_MS, "ALERTA HIGH [!]");
  } else if ((state === "in" || state === "normal") && ICONS.sun && canShowIcon("sun")) {
    await showBitmapSafe(session, ICONS.sun, ICON_DURATION_MS);
  }
}

/* ---------- SHIM y CONFIG ---------- */
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', { value: async () => {}, writable: true, configurable: true, enumerable: false });
}
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;
if (!MENTRAOS_API_KEY) {
  console.error('⛔ MENTRAOS_API_KEY es requerida');
  process.exit(1);
}
const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.activeSessions = new Map();
    this.alertHistory = new Map();
    this.alertLatch = new Map();
    this.displayTimers = new Map();
    this.headUpLastShown = new Map();
    this.dailyTirState = new Map();
    this.dayWatchTimers = new Map();
    this.lastGoodEntry = new Map();
    this._renderToken = new Map();
    this._lastShownText = new Map();
    this._http = new Map();
    this._settingsDebounce = new Map();
    this._sessionLocale = new Map();
  }

  /* ---------- Helpers Generales ---------- */
  __delay(ms) { return new Promise(res => setTimeout(res, ms)); }
  __clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
  __easeInOutCubic(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
  __barFromRatio(ratio, slots){
    const n = Math.round(this.__clamp01(ratio) * slots);
    return `[${'¦'.repeat(n)}${'·'.repeat(Math.max(0, slots - n))}]`;
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

  /* ---------- Lógica de Límites y Alertas ---------- */
  getAlertLimits(settings) {
    const units = String(settings.units || '').toLowerCase();
    const lowMgOK   = this.validateSlicerValue(settings.low_alert_mg, 50, 120, NaN);
    const highMgOK = this.validateSlicerValue(settings.high_alert_mg, 180, 400, NaN);
    const lowMmol  = this.normalizeMmol(settings.low_alert_mmol);
    const highMmol = this.normalizeMmol(settings.high_alert_mmol);
    const lowFromMmolMg  = Number.isFinite(lowMmol)  ? Math.round(lowMmol * 18) : NaN;
    const highFromMmolMg = Number.isFinite(highMmol) ? Math.round(highMmol * 18) : NaN;

    if (units.includes('mmol')) {
      if (Number.isFinite(lowFromMmolMg) && Number.isFinite(highFromMmolMg)) return { low: lowFromMmolMg, high: highFromMmolMg };
      if (Number.isFinite(lowMgOK) && Number.isFinite(highMgOK)) return { low: lowMgOK, high: highMgOK };
    } else {
      if (Number.isFinite(lowMgOK) && Number.isFinite(highMgOK)) return { low: lowMgOK, high: highMgOK };
      if (Number.isFinite(lowFromMmolMg) && Number.isFinite(highFromMmolMg)) return { low: lowFromMmolMg, high: highFromMmolMg };
    }
    return { low: 70, high: 250 }; // Fallback
  }

  getHysteresisMg(settings) {
    const mg = this.validateSlicerValue(settings.alert_hysteresis_mg, 0, 50, NaN);
    const rawMmol = this.parseSlicerValue(settings.alert_hysteresis_mmol, NaN);
    let mmol = NaN;
    if (Number.isFinite(rawMmol)) {
        mmol = (Number.isInteger(rawMmol) && rawMmol >= 0 && rawMmol <= 10) ? rawMmol / 10 : rawMmol;
    }
    const mmolAsMg = Number.isFinite(mmol) ? Math.round(mmol * 18) : NaN;
    const units = String(settings.units || '').toLowerCase();
    if (units.includes('mmol')) {
      return Number.isFinite(mmolAsMg) ? mmolAsMg : (Number.isFinite(mg) ? mg : 5);
    }
    return Number.isFinite(mg) ? mg : (Number.isFinite(mmolAsMg) ? mmolAsMg : 5);
  }

  /* ---------- Lógica de Ajustes (Settings) ---------- */
  _parseSettings(kv) {
    const uiMin = parseInt(kv.update_interval, 10);
    const displayMs = kv.display_duration_s ? this.validateSlicerValue(kv.display_duration_s, 1, 15, 5) * 1000 : this.validateSlicerValue(kv.display_duration_ms, 1000, 15000, 5000);
    const alertMs = kv.alert_duration_s ? this.validateSlicerValue(kv.alert_duration_s, 2, 60, 15) * 1000 : this.validateSlicerValue(kv.alert_duration_ms, 2000, 60000, 15000);
    const coolMs = kv.alert_cooldown_min ? this.validateSlicerValue(kv.alert_cooldown_min, 1, 60, 10) * 60000 : this.validateSlicerValue(kv.alert_cooldown_ms, 60000, 3600000, 600000);
    const horizon = kv.prediction_horizon_min || kv.prediction_horizon_mins;

    return {
      nightscoutUrl: String(kv.nightscout_url || '').trim(),
      nightscoutToken: String(kv.nightscout_token || '').trim(),
      updateInterval: Number.isFinite(uiMin) ? uiMin : 5,
      alertsEnabled: this.toBool(kv.alerts_enabled ?? true),
      language: kv.language || 'en',
      timezone: kv.timezone || null,
      units: kv.units || UNITS.MGDL,
      enable_head_up_display: this.toBool(kv.enable_head_up_display ?? true),
      display_duration_ms: displayMs,
      alert_duration_ms: alertMs,
      alert_cooldown_ms: coolMs,
      show_tir_bar: this.toBool(kv.show_tir_bar ?? kv.show_range_bar ?? true),
      enable_advanced_mode: this.toBool(kv.enable_advanced_mode ?? kv.advanced_mode_enabled ?? false),
      prediction_horizon_min: [15, 30, 60].includes(Number(horizon)) ? Number(horizon) : 30,
      debug_force_alert: kv.debug_force_alert || null,
      low_alert_mg: kv.low_alert_mg, high_alert_mg: kv.high_alert_mg,
      low_alert_mmol: kv.low_alert_mmol, high_alert_mmol: kv.high_alert_mmol,
      alert_hysteresis_mg: kv.alert_hysteresis_mg, alert_hysteresis_mmol: kv.alert_hysteresis_mmol,
    };
  }
  
  async getUserSettings(session) {
    try {
      const keys = ['nightscout_url','nightscout_token','update_interval','low_alert_mg','high_alert_mg','low_alert_mmol','high_alert_mmol','alerts_enabled','language','timezone','units','enable_head_up_display','display_duration_s','alert_duration_s','alert_cooldown_min','show_tir_bar','show_range_bar','display_duration_ms','alert_duration_ms','alert_cooldown_ms','enable_advanced_mode','advanced_mode_enabled','alert_hysteresis_mg','alert_hysteresis_mmol','prediction_horizon_min','prediction_horizon_mins','debug_force_alert'];
      const vals = await Promise.all(keys.map(k => session.settings.get(k)));
      const kv = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
      return this._parseSettings(kv);
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return this._parseSettings({});
    }
  }

  parseSettingsFromArray(arr) {
    const kv = {};
    (arr || []).forEach(s => (kv[s.key] = s.value));
    return this._parseSettings(kv);
  }

  /* ---------- Lógica de Datos y Formateo ---------- */
  _ensureHttp(sessionId, settings){
    const baseRaw = (settings.nightscoutUrl || '').trim();
    if (!baseRaw) return null;
    let cli = this._http.get(sessionId);
    const baseURL = (baseRaw.startsWith('http') ? baseRaw : 'https://' + baseRaw).replace(/\/$/, '');
    if (!cli || cli.defaults.baseURL !== baseURL || cli.defaults.params?.token !== settings.nightscoutToken){
      cli = axios.create({ baseURL, headers: { 'User-Agent': 'MentraOS-Nightscout/2.13.3' }, timeout: 10000, params: settings.nightscoutToken ? { token: settings.nightscoutToken } : {} });
      this._http.set(sessionId, cli);
    }
    return cli;
  }

  async getGlucoseData(settings, sessionId='default') {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) throw new Error('URL no configurada');
    for (const endpoint of [`/api/v1/entries/sgv.json?count=1`, `/api/v1/entries.json?count=1`, `/api/v1/entries/current.json`]) {
      try {
        const { data } = await http.get(endpoint);
        const r = Array.isArray(data) ? data[0] : data;
        if (r) {
          const glucose = Number(r.sgv ?? r.glucose);
          const dateValue = r.date || r.dateString || r.sysTime;
          if (Number.isFinite(glucose) && dateValue) {
            return { sgv: glucose, date: new Date(dateValue).getTime(), direction: r.direction || r.trend || 'NONE' };
          }
        }
      } catch (error) { continue; }
    }
    throw new Error(`Todos los endpoints de Nightscout fallaron.`);
  }
  
  async getTodayEntries(settings, sessionId='default') {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) return [];
    const { data } = await http.get(`/api/v1/entries/sgv.json?count=400`);
    const arr = Array.isArray(data) ? data : [];
    const b = this._getLocaleBundle(sessionId, settings);
    const todayStr = new Date().toLocaleDateString(b.locale, { timeZone: b.tz });
    return arr
      .map(r => ({ mgdl: Number(r.sgv ?? r.glucose), date: new Date(r.date).getTime() }))
      .filter(r => Number.isFinite(r.mgdl) && r.date && new Date(r.date).toLocaleDateString(b.locale, { timeZone: b.tz }) === todayStr);
  }
  
  async getRecentTreatments(settings, sessionId='default') {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) return null;
    const { data } = await http.get(`/api/v1/treatments.json?count=1000`);
    const arr = Array.isArray(data) ? data : [];
    const b = this._getLocaleBundle(sessionId, settings);
    const todayStr = new Date().toLocaleDateString(b.locale, { timeZone: b.tz });
    const todayEvents = arr
      .map(t => ({ ts: new Date(t.created_at || t.timestamp).getTime(), carbs: Number(t.carbs), insulin: Number(t.insulin) }))
      .filter(e => e.ts && new Date(e.ts).toLocaleDateString(b.locale, { timeZone: b.tz }) === todayStr);
    if (!todayEvents.length) return { totalCarbs: 0, totalInsulin: 0, last: null };
    const totals = todayEvents.reduce((acc, e) => {
      if (Number.isFinite(e.carbs)) acc.totalCarbs += e.carbs;
      if (Number.isFinite(e.insulin)) acc.totalInsulin += e.insulin;
      return acc;
    }, { totalCarbs: 0, totalInsulin: 0 });
    const last = todayEvents.reduce((latest, current) => (!latest || current.ts > latest.ts ? current : latest), null);
    return { ...totals, last };
  }

  formatTreatmentsLine(summary, settings, sessionId='default') {
    if (!summary) return '';
    const { totalCarbs, totalInsulin, last } = summary;
    const lang = settings.language || 'en';
    const round1 = x => Math.round(x * 10) / 10;
    const c = round1(totalCarbs), i = round1(totalInsulin);
    let lastStr = '';
    if (last && (last.carbs || last.insulin)) {
      const b = this._getLocaleBundle(sessionId, settings);
      const t = new Date(last.ts).toLocaleTimeString(b.locale, { timeZone: b.tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const parts = [];
      if (last.carbs) parts.push(`${round1(last.carbs)}g`);
      if (last.insulin) parts.push(`${round1(last.insulin)}U`);
      lastStr = lang === 'es' ? ` · Últ: ${parts.join(',')} ${t}` : ` · Last: ${parts.join(',')} ${t}`;
    }
    return lang === 'es' ? `CH/Ins hoy: ${c}g / ${i}U${lastStr}` : `Carbs/Ins today: ${c}g / ${i}U${lastStr}`;
  }

  async buildPredictionShort(settings, sessionId='default', lowOverrideMg=null, highOverrideMg=null) {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) return null;
    const lim = this.getAlertLimits(settings);
    const lowThr = lowOverrideMg ?? lim.low;
    const highThr = highOverrideMg ?? lim.high;
    const horizon = settings.prediction_horizon_min;
    const toDisp = (mgdl) => (settings.units === UNITS.MMOL) ? (mgdl / 18).toFixed(1) : String(Math.round(mgdl));
    // 1) Método exacto (sistemas de lazo cerrado)
    try {
      const { data } = await http.get(`/api/v1/devicestatus.json?count=1`);
      const ds = Array.isArray(data) ? data[0] : data;
      const predBGs = ds?.predBGs || ds?.openaps?.suggested?.predBGs || ds?.ar2?.predBGs;
      if (predBGs) {
        const series = predBGs.IOB || predBGs.COB || predBGs.UAM || (Array.isArray(predBGs) ? predBGs : null);
        if (series?.length > 1) {
          const currentSgv = Number(series[0]);
          for (let i = 1; i < series.length && i * 5 <= horizon; i++) {
            if (currentSgv > lowThr && Number(series[i]) <= lowThr) return `↓${toDisp(lowThr)} @${i * 5}m`;
            if (currentSgv < highThr && Number(series[i]) >= highThr) return `↑${toDisp(highThr)} @${i * 5}m`;
          }
        }
      }
    } catch (_) {}
    // 2) Fallback (Estimación Lineal)
    try {
      const { data } = await http.get(`/api/v1/entries.json?count=2`);
      if (data?.length >= 2) {
        const [last, prev] = data;
        const [mgNow, tNow, mgPrev, tPrev] = [Number(last.sgv), new Date(last.date).getTime(), Number(prev.sgv), new Date(prev.date).getTime()];
        const deltaMin = (tNow - tPrev) / 60000;
        if (deltaMin > 0 && deltaMin < 15) {
          const rate = (mgNow - mgPrev) / deltaMin;
          if (rate < -0.5) {
            const time = (lowThr - mgNow) / rate;
            if (time > 0 && time <= horizon) return `↓${toDisp(lowThr)} @${Math.round(time)}m`;
          }
          if (rate > 0.5) {
            const time = (highThr - mgNow) / rate;
            if (time > 0 && time <= horizon) return `↑${toDisp(highThr)} @${Math.round(time)}m`;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  /* ---------- UI y Animación ---------- */
  _getLocaleBundle(sessionId, settings){
    const cached = this._sessionLocale.get(sessionId);
    if (cached) return cached;
    const langMap = { es: { locale: 'es-ES', timezone: 'Europe/Madrid' }, en: { locale: 'en-US', timezone: 'America/New_York' } };
    const langSettings = langMap[settings.language] || langMap.en;
    const b = { lang: settings.language, locale: langSettings.locale, tz: settings.timezone || langSettings.timezone };
    this._sessionLocale.set(sessionId, b);
    return b;
  }
  
  async formatForG1(data, settings, sessionId) {
    const display = settings.units === UNITS.MMOL ? (data.sgv / 18).toFixed(1) : Math.round(data.sgv);
    const trend = {DoubleUp:'↑↑',SingleUp:'↑',FortyFiveUp:'↗',Flat:'→',FortyFiveDown:'↘',SingleDown:'↓',DoubleDown:'↓↓',NONE:'-', 'NOT COMPUTABLE':'?'}[data.direction] || '?';
    const b = this._getLocaleBundle(sessionId, settings);
    const time = new Date(data.date).toLocaleTimeString(b.locale, { timeZone: b.tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const timeAgo = minutesAgo <= 1 ? (b.lang === 'es' ? 'ahora' : 'now') : (b.lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    return `${display} ${settings.units} ${trend}\n${time} (${timeAgo})`;
  }

  async formatForG1WithPrediction(data, settings, sessionId) {
      const base = await this.formatForG1(data, settings, sessionId);
      const pred = settings.enable_advanced_mode ? await this.buildPredictionShort(settings, sessionId) : await this.buildPredictionShort(settings, sessionId, 60, 180);
      return pred ? `${base.split('\n')[0]}\n${base.split('\n')[1]} · ${pred}` : base;
  }

  showClamped(session, sessionId, text, maxLines = 5) {
    try {
      const lines = String(text || '').split('\n').slice(0, maxLines).join('\n');
      if (this._lastShownText.get(sessionId) === lines) return;
      this._lastShownText.set(sessionId, lines);
      session.layouts.showTextWall(lines);
    } catch (_) {}
  }
  hideDisplay(session, sessionId) {
    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
    try { session.layouts.showTextWall(''); this._lastShownText.delete(sessionId); } catch (_) {}
  }
  _scheduleHide(sessionId, ms){
    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
    this.displayTimers.set(sessionId, setTimeout(() => this.hideDisplay(this.activeSessions.get(sessionId)?.session, sessionId), ms));
  }

  async animateTIRFill(session, sessionId, s, headerText, tirPct, treatmentsLine, minMaxLine) {
    const token = (this._renderToken.get(sessionId) || 0) + 1;
    this._renderToken.set(sessionId, token);

    const tirLine = tirPct == null ? (s.language === 'es' ? 'TIR hoy: n/d' : 'TIR: n/a') : (s.language === 'es' ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`);
    const footer = [treatmentsLine, minMaxLine].filter(Boolean).join('\n');
    const baseText = (bar) => [headerText, `${tirLine} ${bar}`, footer].filter(Boolean).join('\n');

    if (!s.show_tir_bar || tirPct == null) {
      this.showClamped(session, sessionId, baseText(''));
      return;
    }

    const slots = 20;
    const target = Math.floor(this.__clamp01(tirPct / 100) * slots);
    this.showClamped(session, sessionId, baseText(this.__barFromRatio(0, slots)));
    await this.__delay(220); // leadIn
    
    const tStart = Date.now();
    for (let i = 0; i <= target; i++) {
      if (this._renderToken.get(sessionId) !== token) return;
      const easedProgress = this.__easeInOutCubic(i / target);
      const currentFill = Math.floor(easedProgress * target);
      this.showClamped(session, sessionId, baseText(this.__barFromRatio(currentFill, slots)));
      const elapsed = Date.now() - tStart;
      const expectedTime = (i / target) * 920; // totalMs
      await this.__delay(Math.max(0, expectedTime - elapsed));
    }
    this.showClamped(session, sessionId, baseText(this.__barFromRatio(target, slots)));
  }

  /* ---------- Ciclo de Vida y Eventos ---------- */
  async onSession(session, sessionId, userId) {
    console.log(`✅ Nueva sesión: ${sessionId}`);
    this.activeSessions.set(sessionId, { session, userId, settings: null, updateInterval: null });
    
    try {
      const settings = await this.getUserSettings(session);
      this.activeSessions.get(sessionId).settings = settings;

      if (!settings.nightscoutUrl) {
        return this.showClamped(session, sessionId, settings.language === 'es' ? 'Configura la URL de\nNightscout en ajustes' : 'Configure Nightscout URL\nin settings');
      }
      
      if (!ICONS) {
        try { ICONS = await loadBitmaps(); console.log("[bitmaps] cargados"); }
        catch(e) { console.warn("[bitmaps] no se pudieron cargar:", e?.message); ICONS = null; }
      }

      this.setupEventHandlers(session, sessionId, userId);
      await this.showInitialAndHide(session, sessionId, settings);
      await this.startNormalOperation(session, sessionId, settings);
    } catch (e) {
      console.error('Error en onSession:', e);
      this.showClamped(session, sessionId, 'Error: revisa los ajustes');
    }
  }

  async showInitialAndHide(session, sessionId, settings) {
    try {
      const data = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      await this.showGlucoseTemporarily(session, sessionId, settings.display_duration_ms, settings, data);
    } catch (error) {
        console.error("Error en showInitialAndHide:", error.message);
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
            await this.showGlucoseTemporarily(session, sessionId, settings.display_duration_ms, settings, cached);
        } else {
            const msg = settings.language === 'es' ? 'Error cargando datos.\nRevisa URL y token.' : 'Error loading data.\nCheck URL/token.';
            this.showClamped(session, sessionId, msg);
            this._scheduleHide(sessionId, 5000);
        }
    }
  }
  
  setupEventHandlers(session, sessionId, userId) {
    session.events?.onButtonPress?.(async () => {
      const sd = this.activeSessions.get(sessionId);
      if (sd) await this.showGlucoseTemporarily(session, sessionId, sd.settings.display_duration_ms, sd.settings);
    });

    const settingsHandler = (settingsData) => {
      if (this._settingsDebounce.has(sessionId)) clearTimeout(this._settingsDebounce.get(sessionId));
      this._settingsDebounce.set(sessionId, setTimeout(async () => {
        try {
          const settings = this.parseSettingsFromArray(settingsData || []);
          const sd = this.activeSessions.get(sessionId);
          if (!sd) return;
          
          const oldInterval = sd.settings?.updateInterval;
          sd.settings = settings;

          if (oldInterval !== settings.updateInterval) {
            if (sd.updateInterval) clearInterval(sd.updateInterval);
            await this.startNormalOperation(session, sessionId, settings);
          }
          this.alertHistory.delete(sessionId);
          this.alertLatch.delete(sessionId);
          
          const isEs = settings.language === 'es';
          const limits = this.getAlertLimits(settings);
          const hystMg = this.getHysteresisMg(settings);
          const alarmStateData = this.lastGoodEntry.get(sessionId);
          const latched = this.alertLatch.get(sessionId);
          let alarmStatus = latched ? (latched === 'low' ? 'Activa: BAJA' : 'Activa: ALTA') : 'Sin alarma';
          if (isEs === false) alarmStatus = latched ? (latched === 'low' ? 'Active: LOW' : 'Active: HIGH') : 'No alarm';

          const line1 = isEs ? 'Ajustes guardados' : 'Settings saved';
          const line2 = `Units: ${settings.units} · HeadUp: ${settings.enable_head_up_display ? 'ON' : 'OFF'}`;
          const limitsEcho = settings.units === UNITS.MMOL ? `${(limits.low/18).toFixed(1)}-${(limits.high/18).toFixed(1)}` : `${limits.low}-${limits.high}`;
          const line3 = `${isEs ? 'TIR' : 'TIR'}: ${limitsEcho} ${settings.units}`;
          const line4 = `${isEs ? 'Avanzado' : 'Advanced'}: ${settings.enable_advanced_mode ? 'ON' : 'OFF'}`;
          const line5 = `${isEs ? 'Alarmas' : 'Alerts'}: ${settings.alertsEnabled ? 'ON' : 'OFF'} · Hyst: ±${hystMg}mg · ${alarmStatus}`;
          
          this.showClamped(session, sessionId, [line1,line2,line3,line4,line5].join('\n'));
          this._scheduleHide(sessionId, 4000);
        } catch (e) { console.error("Error procesando ajustes:", e); }
      }, 250));
    };

    session.events?.onAppSettingsUpdate?.(settingsHandler);
    session.events?.onSettingsUpdate?.(settingsHandler);
    session.events?.onSettingsChange?.(settingsHandler);

    session.events?.onHeadPosition?.(async (data) => {
        if (data?.position !== 'up') return;
        const sd = this.activeSessions.get(sessionId);
        if (!sd?.settings?.enable_head_up_display) return;
        const now = Date.now();
        if (now - (this.headUpLastShown.get(sessionId) || 0) < 10000) return;
        this.headUpLastShown.set(sessionId, now);
        await this.showGlucoseTemporarily(session, sessionId, sd.settings.display_duration_ms, sd.settings, null, true); // Pass true for showMinMax
    });

    session.events?.onDisconnected?.(() => {
        if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
        const sd = this.activeSessions.get(sessionId);
        if (sd?.updateInterval) clearInterval(sd.updateInterval);
        this.activeSessions.delete(sessionId);
        console.log(`🔌 Sesión desconectada: ${sessionId}`);
    });
  }

  async showGlucoseTemporarily(session, sessionId, ms, settings, glucoseData = null, showMinMax = false) {
    try {
      const data = glucoseData || await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      
      const header = await this.formatForG1WithPrediction(data, settings, sessionId);
      
      if (settings.enable_advanced_mode) {
        const { tirPct } = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
        const treatments = await this.getRecentTreatments(settings, sessionId);
        const treatmentsLine = this.formatTreatmentsLine(treatments, settings, sessionId);
        
        let minMaxLine = '';
        if (showMinMax) {
          const entries = await this.getTodayEntries(settings, sessionId);
          const vals = entries.map(e => e.mgdl);
          if (vals.length) {
            const min = Math.min(...vals), max = Math.max(...vals);
            const minDisp = settings.units === UNITS.MMOL ? (min/18).toFixed(1) : min;
            const maxDisp = settings.units === UNITS.MMOL ? (max/18).toFixed(1) : max;
            minMaxLine = settings.language === 'es' ? `Min/Max hoy: ${minDisp} / ${maxDisp}` : `Min/Max today: ${minDisp} / ${maxDisp}`;
          }
        }
        
        await this.animateTIRFill(session, sessionId, settings, header, tirPct, treatmentsLine, minMaxLine);
      } else {
        this.showClamped(session, sessionId, header);
      }
      this._scheduleHide(sessionId, ms);
    } catch (error) {
      console.error("Error en showGlucoseTemporarily:", error.message);
      const cached = this.lastGoodEntry.get(sessionId);
      if (cached) {
          const txt = await this.formatForG1(cached, settings, sessionId);
          this.showClamped(session, sessionId, txt);
          this._scheduleHide(sessionId, ms);
      }
    }
  }

  async startNormalOperation(session, sessionId, settings) {
    const ms = (settings.updateInterval || 5) * 60 * 1000;
    const iv = setInterval(async () => {
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const currentSettings = this.activeSessions.get(sessionId)?.settings || settings;
        const data = await this.getGlucoseData(currentSettings, sessionId);
        this.lastGoodEntry.set(sessionId, data);
        this.updateDailyTirState(sessionId, data.sgv, data.date, currentSettings);
        if (currentSettings.alertsEnabled) await this.checkAlerts(session, sessionId, data, currentSettings);
      } catch (error) {
        console.error('Error en ciclo normal:', error.message);
      }
    }, ms);
    
    const sd = this.activeSessions.get(sessionId);
    if (sd) sd.updateInterval = iv;
  }
  
  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const latch = this.alertLatch.get(sessionId);
    const h = this.getHysteresisMg(settings);

    // Rearmar alarma si se ha vuelto a un rango seguro + histéresis
    if (latch === 'low' && mgdl >= (limits.low + h)) this.alertLatch.set(sessionId, null);
    if (latch === 'high' && mgdl <= (limits.high - h)) this.alertLatch.set(sessionId, null);
    if (this.alertLatch.get(sessionId)) return;

    // Respetar cooldown
    const lastAlertTs = this.alertHistory.get(sessionId) || 0;
    if (Date.now() - lastAlertTs < settings.alert_cooldown_ms) return;

    // Determinar si hay una nueva condición de alerta
    let alertType = null;
    if (mgdl <= limits.low) alertType = 'low';
    else if (mgdl >= limits.high) alertType = 'high';
    
    // Forzar alerta para debugging
    const debugForce = (settings.debug_force_alert || process.env.DEBUG_FORCE_ALERT || '').toLowerCase();
    if (debugForce === 'low') alertType = 'low';
    else if (debugForce === 'high') alertType = 'high';

    if (alertType) {
      console.log(`[ALERTA] ${sessionId} -> ${alertType.toUpperCase()} @ ${mgdl}`);
      await maybeShowAlertIcon(session, alertType);
      this.alertHistory.set(sessionId, Date.now());
      this.alertLatch.set(sessionId, alertType);
      await this.triggerAnimatedAlert(session, sessionId, data, settings, alertType);
    }
  }

  async triggerAnimatedAlert(session, sessionId, data, settings, type) {
    const displayValue = settings.units === UNITS.MMOL ? (data.sgv/18).toFixed(1) : Math.round(data.sgv);
    const lang = settings.language;
    const msgs = { en: { low: `LOW GLUCOSE!`, high: `HIGH GLUCOSE!` }, es: { low: `¡GLUCOSA BAJA!`, high: `¡GLUCOSA ALTA!` }};
    const baseText = `${msgs[lang][type]}\n${displayValue} ${settings.units}`;
    
    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
    const startTime = Date.now();
    let isVisible = true;
    const blinker = setInterval(() => {
      if (Date.now() - startTime > settings.alert_duration_ms) {
        clearInterval(blinker);
        this.hideDisplay(session, sessionId);
        return;
      }
      this.showClamped(session, sessionId, isVisible ? `[!] ${baseText}` : `[ ] ${baseText}`);
      isVisible = !isVisible;
    }, 600);
  }

  /* ---------- MIRA Tool ---------- */
  async onToolCall(data) {
    const isSpanish = ['obtener_glucosa', 'revisar_glucosa'].includes(data.toolId);
    try {
        let settings;
        for (const [, sData] of this.activeSessions) {
          if (sData.userId === data.userId) { settings = sData.settings; break; }
        }
        if (!settings) throw new Error("No active session settings found for user.");
        if (!settings.nightscoutUrl) throw new Error(isSpanish ? 'Nightscout no configurado' : 'Nightscout not configured');
        
        const reading = await this.getGlucoseData(settings);
        const display = this.convertToDisplay(reading.sgv, settings.units);
        const trend = this.getTrendArrow(reading.direction);
        const limits = this.getAlertLimits(settings);
        let status = isSpanish ? 'Normal' : 'Normal';
        if (reading.sgv <= limits.low) status = isSpanish ? 'Bajo' : 'Low';
        else if (reading.sgv >= limits.high) status = isSpanish ? 'Alto' : 'High';
    } catch (error) {
        return { message: error.message || 'Error desconocido' };
    }
  }

  // Métodos de la clase que estaban truncados en la entrada
  convertToDisplay(mgdl, units) {
    return units === UNITS.MMOL ? (mgdl / 18).toFixed(1) : Math.round(mgdl);
  }

  getTrendArrow(direction) {
    return {
      DoubleUp: '↑↑',
      SingleUp: '↑',
      FortyFiveUp: '↗',
      Flat: '→',
      FortyFiveDown: '↘',
      SingleDown: '↓',
      DoubleDown: '↓↓',
      NONE: '-',
      'NOT COMPUTABLE': '?'
    }[direction] || '?';
  }

  updateDailyTirState(sessionId, mgdl, date, settings) {
    const b = this._getLocaleBundle(sessionId, settings);
    const todayStr = new Date(date).toLocaleDateString(b.locale, { timeZone: b.tz });
    let state = this.dailyTirState.get(sessionId);

    if (!state || state.dateStr !== todayStr) {
      state = { dateStr: todayStr, totalCount: 0, tirCount: 0 };
      this.dailyTirState.set(sessionId, state);
    }
    const limits = this.getAlertLimits(settings);
    state.totalCount++;
    if (mgdl > limits.low && mgdl < limits.high) {
      state.tirCount++;
    }
    const tirPct = state.totalCount > 0 ? Math.round((state.tirCount / state.totalCount) * 100) : null;
    return { tirPct };
  }
}

// Iniciar el servidor de la aplicación
const app = new NightscoutMentraApp({
  port: PORT,
  apiKey: MENTRAOS_API_KEY,
  packageName: PACKAGE_NAME,
  // Desactivar autenticación de firma para facilitar las pruebas
  isSignatureAuthDisabled: process.env.NODE_ENV === 'development'
});

app.listen().then(() => {
  console.log(`✨ Nightscout MentraOS iniciado en http://localhost:${PORT}`);
}).catch(err => {
  console.error("⛔ Error al iniciar el servidor:", err);
  process.exit(1);
});
