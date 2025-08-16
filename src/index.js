"use strict";
// src/index.js — Nightscout MentraOS v2.9.5
// HUD texto + TIR con barra │ en línea + CH/Ins del día + reset diario + semilla TIR + alertas
// ES/EN y mg/dL/mmol. Sin nº de lecturas.

require('dotenv').config();

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

/* ---------- SHIM: evita crash si el SDK invoca método inexistente ---------- */
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async function () { /* noop compat */ },
    writable: true, configurable: true, enumerable: false
  });
}
/* ------------------------------------------------------------------------- */

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
    this.activeSessions = new Map();   // sessionId -> { session, userId, settings, updateInterval }
    this.alertHistory = new Map();     // sessionId -> timestamp
    this.displayTimers = new Map();    // sessionId -> timeoutId
    this.headUpLastShown = new Map();  // sessionId -> timestamp

    // TIR y cambio de día
    this.dailyTirState = new Map();    // sessionId -> { dayStr, total, inRange }
    this.dayWatchTimers = new Map();   // sessionId -> intervalId
  }

  /* ---------------- helpers numéricos ---------------- */
  parseSlicerValue(val, fallback) {
    const n = (typeof val === 'object' && val !== null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
  }
  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  }
  toBool(x){ return (x===true || x==='true' || x===1 || x==='1'); }
  isDifferent(a, b, tol = 0.1) { return Math.abs(Number(a) - Number(b)) > tol; }

  // mmol/L en consola sin decimales (x10) → normaliza a 1 decimal real
  normalizeMmol(x){
    const v = this.parseSlicerValue(x, null);
    if (v === null || !Number.isFinite(v)) return null;
    return (v > 30) ? (v/10) : v; // 39 => 3.9 ; si ya viniera 3.9 lo respeta
  }

  /* ---------------- Umbrales de alertas (mg/dL) ---------------- */
  getAlertLimits(settings) {
    if (settings.units === UNITS.MMOL) {
      const lowM = this.normalizeMmol(settings.low_alert_mmol);
      const highM = this.normalizeMmol(settings.high_alert_mmol);
      return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
    }
    return { low: Math.round(settings.low_alert_mg), high: Math.round(settings.high_alert_mg) };
  }

  /* ---------------- settings (lectura directa del store) ---------------- */
  async getUserSettings(session) {
    try {
      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units,
        enable_head_up_display,
        display_duration_ms, alert_duration_ms, alert_cooldown_ms,
        enable_advanced_mode, advanced_mode_enabled,
        // TIR opcional (por si el usuario define otro rango distinto al de alertas)
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

      // update_interval llega como "1"|"5"|"15" (minutos)
      const uiMin = parseInt(updateInterval, 10);
      const ui = Number.isFinite(uiMin) ? uiMin : 5;

      const result = {
        nightscoutUrl: String(url || '').trim() || '',
        nightscoutToken: String(token || '').trim() || '',
        updateInterval: ui, // en MINUTOS
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 90, 70),
        high_alert_mg: this.validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: this.normalizeMmol(lowMmol) ?? 3.9,
        high_alert_mmol: this.normalizeMmol(highMmol) ?? 13.9,
        alertsEnabled: this.toBool(alertsEnabled),
        language: language || 'en',
        timezone: timezone || null,
        units: units || UNITS.MGDL,
        enable_head_up_display: this.toBool(enable_head_up_display),
        display_duration_ms: this.validateSlicerValue(display_duration_ms, 1000, 15000, 5000),
        alert_duration_ms: this.validateSlicerValue(alert_duration_ms, 2000, 60000, 15000),
        alert_cooldown_ms: this.validateSlicerValue(alert_cooldown_ms, 60000, 3600000, 600000),
        enable_advanced_mode: this.toBool(enable_advanced_mode) || this.toBool(advanced_mode_enabled),

        // familias TIR aceptadas (no forzamos una en concreto)
        tir_low_mg: this.parseSlicerValue(tir_low_mg, null),
        tir_high_mg: this.parseSlicerValue(tir_high_mg, null),
        tir_low_mmol: this.normalizeMmol(tir_low_mmol),
        tir_high_mmol: this.normalizeMmol(tir_high_mmol),
        time_in_range_low_mg: this.parseSlicerValue(time_in_range_low_mg, null),
        time_in_range_high_mg: this.parseSlicerValue(time_in_range_high_mg, null),
        time_in_range_low_mmol: this.normalizeMmol(time_in_range_low_mmol),
        time_in_range_high_mmol: this.normalizeMmol(time_in_range_high_mmol),
      };

      // --- Sincronización mg<->mmol solo para las ALERTAS (no para TIR de usuario) ---
      try {
        if (result.units === UNITS.MMOL) {
          const mgLow = Math.round(result.low_alert_mmol * 18);
          const mgHigh = Math.round(result.high_alert_mmol * 18);
          if (this.isDifferent(result.low_alert_mg, mgLow) || this.isDifferent(result.high_alert_mg, mgHigh)) {
            await Promise.all([
              session.settings.set('low_alert_mg', mgLow),
              session.settings.set('high_alert_mg', mgHigh),
            ]);
            result.low_alert_mg = mgLow;
            result.high_alert_mg = mgHigh;
          }
        } else {
          const mmolLow = Number((result.low_alert_mg / 18).toFixed(1));
          const mmolHigh = Number((result.high_alert_mg / 18).toFixed(1));
          if (this.isDifferent(result.low_alert_mmol, mmolLow) || this.isDifferent(result.high_alert_mmol, mmolHigh)) {
            const storeLow  = Math.round(mmolLow * 10);
            const storeHigh = Math.round(mmolHigh * 10);
            await Promise.all([
              session.settings.set('low_alert_mmol', storeLow),
              session.settings.set('high_alert_mmol', storeHigh),
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
        alertsEnabled: true, language: 'en', timezone: null, units: UNITS.MGDL,
        enable_head_up_display: false,
        display_duration_ms: 5000, alert_duration_ms: 15000, alert_cooldown_ms: 600000,
        enable_advanced_mode: false
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    const units = o.units || UNITS.MGDL;

    // update_interval llega como "1"|"5"|"15"
    const uiMin = parseInt(o.update_interval, 10);
    const ui = Number.isFinite(uiMin) ? uiMin : 5;

    return {
      nightscoutUrl: String(o.nightscout_url || '').trim() || '',
      nightscoutToken: String(o.nightscout_token || '').trim() || '',
      updateInterval: ui, // MINUTOS

      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 40, 90, 70),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, 250),

      // mmol normalizados (x10 si vienen como enteros)
      low_alert_mmol: this.normalizeMmol(o.low_alert_mmol) ?? 3.9,
      high_alert_mmol: this.normalizeMmol(o.high_alert_mmol) ?? 13.9,

      alertsEnabled: this.toBool(o.alerts_enabled),
      language: o.language || 'en',
      timezone: o.timezone || null,
      units,
      enable_head_up_display: this.toBool(o.enable_head_up_display),

      display_duration_ms: this.validateSlicerValue(o.display_duration_ms, 1000, 15000, 5000),
      alert_duration_ms: this.validateSlicerValue(o.alert_duration_ms, 2000, 60000, 15000),
      alert_cooldown_ms: this.validateSlicerValue(o.alert_cooldown_ms, 60000, 3600000, 600000),

      // toggle avanzado
      enable_advanced_mode: this.toBool(o.enable_advanced_mode) || this.toBool(o.advanced_mode_enabled),

      // familias TIR aceptadas
      tir_low_mg: this.parseSlicerValue(o.tir_low_mg, null),
      tir_high_mg: this.parseSlicerValue(o.tir_high_mg, null),
      tir_low_mmol: this.normalizeMmol(o.tir_low_mmol),
      tir_high_mmol: this.normalizeMmol(o.tir_high_mmol),

      time_in_range_low_mg: this.parseSlicerValue(o.time_in_range_low_mg, null),
      time_in_range_high_mg: this.parseSlicerValue(o.time_in_range_high_mg, null),
      time_in_range_low_mmol: this.normalizeMmol(o.time_in_range_low_mmol),
      time_in_range_high_mmol: this.normalizeMmol(o.time_in_range_high_mmol),
    };
  }

  /* ---------------- utils de UI ---------------- */
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
    const display = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
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

    return `${display} ${settings.units || UNITS.MGDL} ${trend}\n${timeStr} (${timeAgo})`;
  }

  /* ---------------- Día local + TIR + tratamientos ---------------- */
  getLocalDayStr(ts, settings) {
    const langSettings = this.getLanguageSettings(settings);
    const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    return new Date(ts).toLocaleDateString(langSettings.locale, { timeZone: tz });
  }
  buildTirBar(tirPct) {
    if (tirPct === null || !Number.isFinite(tirPct)) return '';
    const blocks = Math.max(0, Math.min(20, Math.round(tirPct / 5)));
    // Usamos barra vertical U+2502 para evitar tablas
    const BAR = '│';
    return BAR.repeat(blocks);
  }
  updateDailyTirState(sessionId, readingMgdl, readingTs, settings) {
    const range = this.getAlertLimits(settings); // rango
    const dayStr = this.getLocalDayStr(readingTs, settings);

    let st = this.dailyTirState.get(sessionId);
    if (!st || st.dayStr !== dayStr) st = { dayStr, total: 0, inRange: 0 };

    if (Number.isFinite(readingMgdl)) {
      st.total += 1;
      if (readingMgdl >= range.low && readingMgdl <= range.high) st.inRange += 1;
    }

    this.dailyTirState.set(sessionId, st);
    const tirPct = st.total > 0 ? Math.round((st.inRange / st.total) * 100) : null;
    return { tirPct, total: st.total };
  }

  // Tratamientos: 'hours' (número) o 'day' para todo el día local
  async getRecentTreatments(settings, hours = 4) {
    try {
      const base = (settings.nightscoutUrl || '').trim();
      if (!base) return null;
      let u = base.startsWith('http') ? base : ('https://' + base);
      u = u.replace(/\/$/, '');
      const endpoint = `${u}/api/v1/treatments.json?count=1000`;
      const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
      const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.5' } });
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
        windowed = events.filter(e =>
          new Date(e.ts).toLocaleDateString(locale, { timeZone: tz }) === todayStr
        );
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
    const round1 = (x) => Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
    const c = round1(totalCarbs); const i = round1(totalInsulin);

    let lastStr = '';
    if (last && (Number.isFinite(last.carbs) || Number.isFinite(last.insulin))) {
      const langSettings = this.getLanguageSettings(settings);
      const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
      const t = new Date(last.ts).toLocaleTimeString(langSettings.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      const parts = [];
      if (Number.isFinite(last.carbs)) parts.push(`${round1(last.carbs)}g`);
      if (Number.isFinite(last.insulin)) parts.push(`${round1(last.insulin)}U`);
      lastStr = parts.length ? (lang==='es' ? ` · Últ: ${parts.join(', ')} ${t}` : ` · Last: ${parts.join(', ')} ${t}`) : '';
    }

    if (lang==='es') return label === 'hoy' ? `CH/Ins hoy: ${c}g / ${i}U${lastStr}` : `CH/Ins ${label}: ${c}g / ${i}U${lastStr}`;
    return label === 'today' ? `Carbs/Ins today: ${c}g / ${i}U${lastStr}` : `Carbs/Ins ${label}: ${c}g / ${i}U${lastStr}`;
  }

  /* ---------------- Nightscout data ---------------- */
  async getTodayEntries(settings) {
    const u0 = settings.nightscoutUrl;
    if (!u0) throw new Error('URL no configurada');
    let u = u0.startsWith('http') ? u0 : ('https://' + u0);
    u = u.replace(/\/$/, '');

    const endpoint = `${u}/api/v1/entries/sgv.json?count=400`;
    const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
    const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.5' } });

    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    const langSettings = this.getLanguageSettings(settings);
    const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const locale = langSettings.locale;
    const todayStr = new Date().toLocaleDateString(locale, { timeZone: tz });

    const today = arr
      .map(r => ({
        mgdl: Number(r.sgv ?? r.glucose),
        date: typeof r.date === 'string' ? new Date(r.date).getTime() : r.date
      }))
      .filter(r => Number.isFinite(r.mgdl) && r.date)
      .filter(r => new Date(r.date).toLocaleDateString(locale, { timeZone: tz }) === todayStr);

    today.sort((a,b)=>a.date-b.date);
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
        const { data } = await axios.get(endpoint, { params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.5' } });
        const reading = Array.isArray(data) ? data[0] : data; if (!reading) throw new Error('Empty response');
        const glucoseRaw = (reading.sgv ?? reading.glucose);
        const glucose = Number(glucoseRaw); if (!Number.isFinite(glucose)) throw new Error('No glucose data found');
        const dateValue = reading.date || reading.dateString || reading.sysTime; if (!dateValue) throw new Error('No date found');
        return { sgv: glucose, date: typeof dateValue === 'string' ? new Date(dateValue).getTime() : dateValue, direction: reading.direction || reading.trend || 'NONE' };
      } catch (error) { lastError = error; continue; }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------------- Ciclo de vida de sesión ---------------- */
  async onSession(session, sessionId, userId) {
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);

    if (typeof session.updateSettingsForTesting !== 'function') {
      session.updateSettingsForTesting = async () => { session.logger?.debug?.('Compat shim: updateSettingsForTesting noop'); };
    }

    session.logger?.info('Session started', { userId, sessionId });

    try {
      const settings = await this.getUserSettings(session);

      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        const msg = { en: 'Please configure Nightscout\nURL and token in settings', es: 'Configura URL y token\nde Nightscout en ajustes' };
        session.layouts.showTextWall(msg[settings.language] || msg.en);
        return;
      }

      this.activeSessions.set(sessionId, { session, userId, settings, updateInterval: null });
      this.setupEventHandlers(session, sessionId, userId);

      // Semilla inicial con lecturas de hoy → TIR coherente desde el arranque
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

      // Reloj de cambio de día (reset a 00:00 local)
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
      session.layouts.showTextWall('Error: Check app settings');
    }
  }

  async showInitialAndHide(session, sessionId, settings) {
    try {
      const data = await this.getGlucoseData(settings);
      // contabiliza lectura para TIR (UNA sola vez)
      const tirRes = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);

      const formattedData = await this.formatForG1(data, settings);
      if (settings.enable_advanced_mode) {
        const tirPct = tirRes.tirPct;
        const tirLine = (tirPct === null)
          ? (settings.language==='es' ? 'TIR hoy: n/d' : 'Today TIR: n/a')
          : (settings.language==='es' ? `TIR hoy: ${tirPct}%` : `Today TIR: ${tirPct}%`);
        const bar = (tirPct === null) ? '' : this.buildTirBar(tirPct);

        // Tratamientos del día completo
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day'); tLine = this.formatTreatmentsLine(sum, settings); } catch {}

        session.layouts.showTextWall(`\n${formattedData}\n────────────\n${tirLine}${bar ? ' ' + bar : ''}${tLine ? `\n${tLine}` : ''}`);
      } else {
        session.layouts.showTextWall(`\n${formattedData}`);
      }
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
    } catch (error) {
      const errorMsg =
        error.message.includes('URL no configurada') ? { en: 'Nightscout URL not set\nCheck settings', es: 'URL de Nightscout no configurada\nRevisa ajustes' } :
        (error.message.includes('Sin datos') || error.message.includes('timeout')) ? { en: 'Cannot connect to Nightscout\nCheck URL and token', es: 'No se puede conectar\nRevisa URL y token' } :
        { en: 'Error loading glucose data\nCheck your settings', es: 'Error cargando datos\nRevisa tu configuración' };
      const msg = errorMsg[settings.language] || errorMsg.en;
      session.layouts.showTextWall(msg);
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
    }
  }

  /* ---------------- Handlers de eventos ---------------- */
  setupEventHandlers(session, sessionId, userId) {
    try {
      // Botón físico (tap)
      session.events?.onButtonPress?.(async () => {
        const sd = this.activeSessions.get(sessionId);
        const s = sd?.settings || await this.getUserSettings(session);
        await this.showGlucoseTemporarily(session, sessionId, s.display_duration_ms || 4000, s);
      });

      // Cambios de ajustes
      const settingsHandler = async (settingsData) => {
        session.logger?.info('Settings update received', { settingsCount: settingsData?.length });
        try {
          const parsed = this.parseSettingsFromArray(settingsData || []);
          const sd = this.activeSessions.get(sessionId);
          if (!sd) return;

          const old = sd.settings || {};

          // restart ciclo si cambia intervalo
          if (old.updateInterval !== parsed.updateInterval) {
            if (sd.updateInterval) { clearInterval(sd.updateInterval); sd.updateInterval = null; }
            await this.startNormalOperation(session, sessionId, userId, parsed);
          }

          // limpiar historial de alertas si cambian límites
          if (this.alertLimitsChanged(old, parsed)) {
            this.alertHistory.delete(sessionId);
          }

          // cache settings
          sd.settings = parsed;
          this.activeSessions.set(sessionId, sd);

          // sincronización de alertas mg<->mmol (como en arranque)
          try {
            if (parsed.units === UNITS.MMOL) {
              const mgLow = Math.round(parsed.low_alert_mmol * 18);
              const mgHigh = Math.round(parsed.high_alert_mmol * 18);
              if (this.isDifferent(parsed.low_alert_mg, mgLow) || this.isDifferent(parsed.high_alert_mg, mgHigh)) {
                await Promise.all([
                  session.settings.set('low_alert_mg', mgLow),
                  session.settings.set('high_alert_mg', mgHigh),
                ]);
                parsed.low_alert_mg = mgLow; parsed.high_alert_mg = mgHigh;
              }
            } else {
              const mmolLow  = Number((parsed.low_alert_mg / 18).toFixed(1));
              const mmolHigh = Number((parsed.high_alert_mg / 18).toFixed(1));
              const storeLow  = Math.round(mmolLow * 10);
              const storeHigh = Math.round(mmolHigh * 10);
              if (this.isDifferent(parsed.low_alert_mmol, mmolLow) || this.isDifferent(parsed.high_alert_mmol, mmolHigh)) {
                await Promise.all([
                  session.settings.set('low_alert_mmol', storeLow),
                  session.settings.set('high_alert_mmol', storeHigh),
                ]);
                parsed.low_alert_mmol = mmolLow; parsed.high_alert_mmol = mmolHigh;
              }
            }
          } catch (e) {
            session.logger?.debug('Sync (onChange) skipped/failed', { err: e?.message });
          }

          // ECO: mostrar estado mínimo
          try {
            const lines = ['Ajustes guardados'];
            if (parsed.units === UNITS.MMOL) {
              lines.push(`Low: ${parsed.low_alert_mmol} mmol/L`);
              lines.push(`High: ${parsed.high_alert_mmol} mmol/L`);
            } else {
              lines.push(`Low: ${parsed.low_alert_mg} mg/dL`);
              lines.push(`High: ${parsed.high_alert_mg} mg/dL`);
            }
            lines.push(`Units: ${parsed.units}`);
            lines.push(`HeadUp: ${parsed.enable_head_up_display ? 'ON' : 'OFF'}`);
            lines.push(`Advanced: ${parsed.enable_advanced_mode ? 'ON' : 'OFF'}`);
            session.layouts.showTextWall(`\n${lines.join('\n')}`);
            setTimeout(() => this.hideDisplay(session, sessionId), 2200);
          } catch {}
        } catch (error) {
          session.logger?.error(error, 'Failed to process settings update');
        }
      };

      session.events?.onAppSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsChange?.(settingsHandler);

      // HUD por gesto: levantar la cabeza (usamos display_duration_ms)
      session.events?.onHeadPosition?.(async (data) => {
        try {
          if (data?.position !== 'up') return;

          const sd = this.activeSessions.get(sessionId);
          const s = sd?.settings;
          if (!s?.enable_head_up_display) return;

          // Cooldown 10s para HUD
          const now = Date.now();
          const last = this.headUpLastShown.get(sessionId) || 0;
          if (now - last < 10_000) return;
          this.headUpLastShown.set(sessionId, now);

          const reading = await this.getGlucoseData(s);
          const { tirPct } = this.updateDailyTirState(sessionId, reading.sgv, reading.date, s);

          let text = await this.formatForG1(reading, s);

          if (s.enable_advanced_mode) {
            const tirLine = (tirPct === null) ? (s.language==='es' ? 'TIR hoy: n/d' : 'Today TIR: n/a') : (s.language==='es' ? `TIR hoy: ${tirPct}%` : `Today TIR: ${tirPct}%`);
            const bar = (tirPct === null) ? '' : this.buildTirBar(tirPct);

            // Min/Max del día (ligero, usando entries de hoy)
            let minMaxLine = '';
            try {
              const entries = await this.getTodayEntries(s);
              const vals = entries.map(e => e.mgdl).filter(Number.isFinite);
              if (vals.length) {
                const min = Math.min(...vals), max = Math.max(...vals);
                const minDisp = this.convertToDisplay(min, s.units);
                const maxDisp = this.convertToDisplay(max, s.units);
                minMaxLine = s.language==='es' ? `\nMin/Max hoy: ${minDisp} / ${maxDisp} ${s.units}` : `\nMin/Max today: ${minDisp} / ${maxDisp} ${s.units}`;
              }
            } catch {}

            text = `${text}\n────────────\n${tirLine}${bar ? ' ' + bar : ''}${minMaxLine}`;
          }

          // Resumen CH/Ins (todo el día)
          let tLine = '';
          try { const sum = await this.getRecentTreatments(s, 'day'); tLine = this.formatTreatmentsLine(sum, s); } catch {}

          session.layouts.showTextWall(`\n${text}${tLine ? `\n${tLine}` : ''}`);
          setTimeout(() => this.hideDisplay(session, sessionId), s.display_duration_ms || 4000);
        } catch (e) {
          try { session.layouts.showTextWall('\nError'); } catch {}
          setTimeout(() => this.hideDisplay(session, sessionId), 2000);
        }
      });

      // Limpieza
      session.events?.onDisconnected?.(() => {
        const t = this.displayTimers.get(sessionId);
        if (t) clearTimeout(t);
        this.displayTimers.delete(sessionId);

        const sd = this.activeSessions.get(sessionId);
        if (sd?.updateInterval) clearInterval(sd.updateInterval);

        // limpiar reloj de cambio de día
        const dw = this.dayWatchTimers.get(sessionId);
        if (dw) clearInterval(dw);
        this.dayWatchTimers.delete(sessionId);

        this.activeSessions.delete(sessionId);
        this.alertHistory.delete(sessionId);
        this.headUpLastShown.delete(sessionId);
        this.dailyTirState.delete(sessionId);

        session.logger?.info('Session disconnected');
      });

    } catch (error) {
      console.error('❌ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  /* ---------------- Mostrar temporal (botón) ---------------- */
  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    try {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      const settings = providedSettings || sd.settings || await this.getUserSettings(sd.session);
      const data = await this.getGlucoseData(settings);

      // contabiliza lectura para TIR
      const { tirPct } = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);

      if (settings.enable_advanced_mode) {
        const header = `\n${await this.formatForG1(data, settings)}`;
        const tirLine = (tirPct === null)
          ? (settings.language==='es' ? 'TIR hoy: n/d' : 'Today TIR: n/a')
          : (settings.language==='es' ? `TIR hoy: ${tirPct}%` : `Today TIR: ${tirPct}%`);
        const bar = (tirPct === null) ? '' : this.buildTirBar(tirPct);

        // Resumen CH/Ins (del día)
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day'); tLine = this.formatTreatmentsLine(sum, settings); } catch {}

        session.layouts.showTextWall(`${header}\n────────────\n${tirLine}${bar ? ' ' + bar : ''}${tLine ? `\n${tLine}` : ''}`);
      } else {
        session.layouts.showTextWall(`\n${await this.formatForG1(data, settings)}`);
      }

      const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
      this.displayTimers.set(sessionId, timer);
    } catch (error) {
      session.logger?.error(error, 'Failed to show glucose temporarily');
    }
  }

  /* ---------------- Bucle normal: fetch + alertas (no pinta HUD) ---------------- */
  async startNormalOperation(session, sessionId, userId, initialSettings) {
    const ms = (initialSettings.updateInterval || 5) * 60 * 1000; // minutos → ms
    const iv = setInterval(async () => {
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const sd = this.activeSessions.get(sessionId);
        const s = (sd && sd.settings) ? sd.settings : await this.getUserSettings(session);
        const d = await this.getGlucoseData(s);

        // contabiliza lectura para TIR
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

  /* ---------------- Alertas ---------------- */
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
      session.layouts.showTextWall(msg);
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

  /* ---------------- MIRA Tool (respuesta hablada) ---------------- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;
    const isSpanish = ['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'].includes(toolId);
    const lang = isSpanish ? 'es' : 'en';

    try {
      let settings = null;
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

      // Actualiza TIR
      const { tirPct } = this.updateDailyTirState(activeSession?.sessionId || 'tool', reading.sgv, reading.date, settings);

      // Si modo avanzado ON, añadimos TIR en el mensaje de MIRA
      let extra = '';
      if (settings.enable_advanced_mode && Number.isFinite(tirPct)) {
        extra = (lang==='es') ? ` TIR hoy: ${tirPct}%` : ` Today TIR: ${tirPct}%`;
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

  /* ---------------- util ---------------- */
  hideDisplay(session, sessionId) {
    try { session.layouts.showTextWall(''); } catch {}
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

console.log('🚀 Nightscout MentraOS v2.9.5 — HUD texto + TIR │ inline + CH/Ins día + reset diario');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.9.5',
  activeSessions: server.activeSessions.size
}));

setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
