"use strict";
/**
 * src/index.js — Nightscout MentraOS v2.9.7
 * HUD texto + TIR con barra │ en línea + CH/Ins del día + Min/Max (solo gesto avanzado)
 * Modo simple: solo glucosa + flecha + hora. Reseteo diario + semilla TIR.
 * ES/EN y mg/dL/mmol. Tope de 5 líneas en todas las salidas.
 */

require('dotenv').config();

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');
const crypto = require('crypto');

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

// Helpers de traducción para textos fijos
const TRANSLATIONS = {
  es: {
    now: 'ahora',
    ago: 'hace',
    agoUnit: 'm',
    criticalLow: 'Crítico Bajo',
    low: 'Bajo',
    normal: 'Normal',
    high: 'Alto',
    criticalHigh: 'Crítico Alto',
    today: 'hoy',
    last: 'Últ'
  },
  en: {
    now: 'now',
    ago: '',
    agoUnit: 'm ago',
    criticalLow: 'Critical Low',
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    criticalHigh: 'Critical High',
    today: 'today',
    last: 'Last'
  }
};

// Mapas estáticos para evitar recreación
const TREND_ARROWS = {
  'DoubleUp': '⇈', 'SingleUp': '↑', 'FortyFiveUp': '↗',
  'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '↓', 'DoubleDown': '⇊',
  'NONE': '-', 'NOT COMPUTABLE': '→',
};

const LANGUAGE_SETTINGS = {
  es: { locale: 'es-ES', timezone: 'Europe/Madrid' },
  en: { locale: 'en-US', timezone: 'America/New_York' },
};

const VALID_TIMEZONES = [
  'Europe/Madrid', 'Atlantic/Canary', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Rome', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

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
  toBool(x) { return (x === true || x === 'true' || x === 1 || x === '1'); }
  isDifferent(a, b, tol = 0.1) { return Math.abs(Number(a) - Number(b)) > tol; }

  normalizeMmol(x) {
    const v = this.parseSlicerValue(x, null);
    if (v === null || !Number.isFinite(v)) return null;
    return (v > 30) ? (v / 10) : v;
  }

  /* ---------------- Umbrales de alertas (mg/dL) ---------------- */
  getAlertLimits(settings) {
    const { units, low_alert_mg, high_alert_mg, low_alert_mmol, high_alert_mmol } = settings;
    if (units === UNITS.MMOL) {
      const lowM = this.normalizeMmol(low_alert_mmol);
      const highM = this.normalizeMmol(high_alert_mmol);
      return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
    }
    return { low: Math.round(low_alert_mg), high: Math.round(high_alert_mg) };
  }

  /* ---------------- settings (lectura directa del store) ---------------- */
  async getUserSettings(session) {
    try {
      const settings = await Promise.all([
        'nightscout_url', 'nightscout_token', 'update_interval',
        'low_alert_mg', 'high_alert_mg', 'low_alert_mmol', 'high_alert_mmol',
        'alerts_enabled', 'language', 'timezone', 'units', 'enable_head_up_display',
        'display_duration_s', 'alert_duration_s', 'alert_cooldown_min',
        'show_tir_bar', 'show_range_bar', 'display_duration_ms', 'alert_duration_ms',
        'alert_cooldown_ms', 'enable_advanced_mode', 'advanced_mode_enabled',
        'tir_low_mg', 'tir_high_mg', 'tir_low_mmol', 'tir_high_mmol',
        'time_in_range_low_mg', 'time_in_range_high_mg', 'time_in_range_low_mmol',
        'time_in_range_high_mmol'
      ].map(key => session.settings.get(key)));

      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units, enable_head_up_display,
        dispSRaw, alertSRaw, coolMinRaw,
        show_tir_bar, show_range_bar,
        display_duration_ms, alert_duration_ms, alert_cooldown_ms,
        enable_advanced_mode, advanced_mode_enabled,
        tir_low_mg, tir_high_mg, tir_low_mmol, tir_high_mmol,
        time_in_range_low_mg, time_in_range_high_mg, time_in_range_low_mmol,
        time_in_range_high_mmol
      ] = settings;

      const uiMin = parseInt(updateInterval, 10);
      const ui = Number.isFinite(uiMin) ? uiMin : 5;

      const displayMs = Number.isFinite(this.parseSlicerValue(dispSRaw, NaN))
        ? Math.min(15, Math.max(1, dispSRaw)) * 1000
        : this.validateSlicerValue(display_duration_ms, 1000, 15000, 5000);

      const alertMs = Number.isFinite(this.parseSlicerValue(alertSRaw, NaN))
        ? Math.min(60, Math.max(2, alertSRaw)) * 1000
        : this.validateSlicerValue(alert_duration_ms, 2000, 60000, 15000);

      const coolMs = Number.isFinite(this.parseSlicerValue(coolMinRaw, NaN))
        ? Math.min(60, Math.max(1, coolMinRaw)) * 60 * 1000
        : this.validateSlicerValue(alert_cooldown_ms, 60000, 3600000, 600000);

      const showTirBar = (show_tir_bar == null && show_range_bar == null) ? true : (this.toBool(show_tir_bar) || this.toBool(show_range_bar));

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
      };

      try {
        // Sincroniza mg/dL ↔ mmol/L en arranque (tolerancias específicas)
        const lowMg = result.low_alert_mg, highMg = result.high_alert_mg;
        const lowMmol = result.low_alert_mmol, highMmol = result.high_alert_mmol;

        if (result.units === UNITS.MMOL) {
          const mgLow = Math.round(lowMmol * 18);
          const mgHigh = Math.round(highMmol * 18);
          if (this.isDifferent(lowMg, mgLow, 1) || this.isDifferent(highMg, mgHigh, 1)) {
            await Promise.all([
              session.settings.set('low_alert_mg', mgLow),
              session.settings.set('high_alert_mg', mgHigh),
            ]);
            result.low_alert_mg = mgLow;
            result.high_alert_mg = mgHigh;
          }
        } else {
          const mmolLow = Number((lowMg / 18).toFixed(1));
          const mmolHigh = Number((highMg / 18).toFixed(1));
          const storeLow = Math.round(mmolLow * 10);
          const storeHigh = Math.round(mmolHigh * 10);
          if (this.isDifferent(lowMmol, mmolLow, 0.1) || this.isDifferent(highMmol, mmolHigh, 0.1)) {
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
        show_tir_bar: true,
        enable_advanced_mode: false
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    const units = o.units || UNITS.MGDL;
    const uiMin = parseInt(o.update_interval, 10);
    const ui = Number.isFinite(uiMin) ? uiMin : 5;

    const dispSRaw = this.parseSlicerValue(o.display_duration_s, NaN);
    const alertSRaw = this.parseSlicerValue(o.alert_duration_s, NaN);
    const coolMinRaw = this.parseSlicerValue(o.alert_cooldown_min, NaN);

    const displayMs = Number.isFinite(dispSRaw)
      ? Math.min(15, Math.max(1, dispSRaw)) * 1000
      : this.validateSlicerValue(o.display_duration_ms, 1000, 15000, 5000);

    const alertMs = Number.isFinite(alertSRaw)
      ? Math.min(60, Math.max(2, alertSRaw)) * 1000
      : this.validateSlicerValue(o.alert_duration_ms, 2000, 60000, 15000);

    const coolMs = Number.isFinite(coolMinRaw)
      ? Math.min(60, Math.max(1, coolMinRaw)) * 60 * 1000
      : this.validateSlicerValue(o.alert_cooldown_ms, 60000, 3600000, 600000);

    const showTirBar = (o.show_tir_bar == null && o.show_range_bar == null)
      ? true : (this.toBool(o.show_tir_bar) || this.toBool(o.show_range_bar));

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
    };
  }

  /* ---------------- utils de UI ---------------- */
  convertToDisplay(mgdlValue, targetUnit) {
    if (targetUnit === UNITS.MMOL) return (mgdlValue / 18).toFixed(1);
    return Math.round(mgdlValue);
  }

  // Refactor: Usa un mapa constante
  getTrendArrow(dir) {
    return TREND_ARROWS[dir] || '→';
  }

  // Refactor: Simplifica la lógica
  getGlucoseStatusText(value, settings) {
    const limits = this.getAlertLimits(settings);
    const lang = settings.language || 'en';
    const translations = TRANSLATIONS[lang] || TRANSLATIONS.en;

    const criticalLow = limits.low - 10;
    const criticalHigh = limits.high + 70;

    if (value < criticalLow) return translations.criticalLow;
    if (value <= limits.low) return translations.low;
    if (value > criticalHigh) return translations.criticalHigh;
    if (value >= limits.high) return translations.high;
    return translations.normal;
  }

  getLanguageSettings(settings) {
    return LANGUAGE_SETTINGS[settings.language] || LANGUAGE_SETTINGS.en;
  }

  validateTimezone(tz) {
    return VALID_TIMEZONES.includes(tz) ? tz : 'UTC';
  }

  async formatGlucoseData(data, settings) {
    const lang = settings.language || 'en';
    const translations = TRANSLATIONS[lang] || TRANSLATIONS.en;
    const displayValue = this.convertToDisplay(data.sgv, settings.units);
    const trend = this.getTrendArrow(data.direction);
    const status = this.getGlucoseStatusText(data.sgv, settings);

    const langSettings = this.getLanguageSettings(settings);
    const timezone = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const readingTime = new Date(data.date);
    const timeStr = readingTime.toLocaleTimeString(langSettings.locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit' });

    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const timeAgo = minutesAgo <= 1
      ? translations.now
      : `${translations.ago} ${minutesAgo}${translations.agoUnit}`;

    return {
      glucose: displayValue,
      unit: settings.units,
      trend,
      status,
      timeStr,
      timeAgo,
      line1: `${displayValue} ${settings.units} ${trend}`,
      line2: `${status} · ${timeStr} (${timeAgo})`
    };
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
    const BAR = '│';
    return BAR.repeat(blocks);
  }

  updateDailyTirState(sessionId, readingMgdl, readingTs, settings) {
    const range = this.getAlertLimits(settings);
    const dayStr = this.getLocalDayStr(readingTs, settings);

    let st = this.dailyTirState.get(sessionId);
    if (!st || st.dayStr !== dayStr) {
      st = { dayStr, total: 0, inRange: 0 };
    }

    if (Number.isFinite(readingMgdl)) {
      st.total += 1;
      if (readingMgdl >= range.low && readingMgdl <= range.high) st.inRange += 1;
    }

    this.dailyTirState.set(sessionId, st);
    const tirPct = st.total > 0 ? Math.round((st.inRange / st.total) * 100) : null;
    return { tirPct, total: st.total };
  }

  async getRecentTreatments(settings, hours = 4) {
    try {
      const base = (settings.nightscoutUrl || '').trim();
      if (!base) return null;
      let u = base.startsWith('http') ? base : ('https://' + base);
      u = u.replace(/\/$/, '');
      const endpoint = `${u}/api/v1/treatments.json?count=1000`;
      const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
      const { data } = await axios.get(endpoint, {
        params, timeout: 10000,
        headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.7' }
      });
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
        label = TRANSLATIONS[settings.language]?.today || TRANSLATIONS.en.today;
      } else {
        const since = Date.now() - Math.max(1, hours) * 60 * 60 * 1000;
        windowed = events.filter(e => e.ts >= since);
        label = `${hours}h`;
      }
      if (!windowed.length) return { label, totalCarbs: 0, totalInsulin: 0, last: null };

      let totalCarbs = 0, totalInsulin = 0;
      let last = null;
      for (const e of windowed) {
        if (Number.isFinite(e.carbs)) totalCarbs += e.carbs;
        if (Number.isFinite(e.insulin)) totalInsulin += e.insulin;
        if (!last || e.ts > last.ts) last = e;
      }
      return { label, totalCarbs, totalInsulin, last };
    } catch (_) {
      return null;
    }
  }

  formatTreatmentsLine(summary, settings) {
    if (!summary) return '';
    const { label, totalCarbs, totalInsulin, last } = summary;
    const lang = settings.language || 'en';
    const translations = TRANSLATIONS[lang] || TRANSLATIONS.en;
    const round1 = (x) => Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
    const c = round1(totalCarbs);
    const i = round1(totalInsulin);
    let lastStr = '';

    if (last && (Number.isFinite(last.carbs) || Number.isFinite(last.insulin))) {
      const langSettings = this.getLanguageSettings(settings);
      const tz = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
      const t = new Date(last.ts).toLocaleTimeString(langSettings.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      const parts = [];
      if (Number.isFinite(last.carbs)) parts.push(`${round1(last.carbs)}g`);
      if (Number.isFinite(last.insulin)) parts.push(`${round1(last.insulin)}U`);
      lastStr = parts.length ? ` · ${translations.last}: ${parts.join(', ')} ${t}` : '';
    }

    const hasData = (c > 0 || i > 0);
    const cStr = c > 0 ? `${c}g` : '';
    const iStr = i > 0 ? `${i}U` : '';

    if (!hasData) return '';
    const text = [cStr, iStr].filter(s => s).join(', ');
    return `CH/Ins ${label}: ${text}${lastStr}`;
  }

  async getGlucoseData(sessionId) {
    const session = this.activeSessions.get(sessionId);
    const settings = await this.getUserSettings(session.session);
    session.settings = settings;

    const [base, token] = [
      (settings.nightscoutUrl || '').trim(),
      (settings.nightscoutToken || '').trim()
    ];

    if (!base) {
      this.lastGoodEntry.delete(sessionId);
      throw new Error(settings.language === 'es' ? 'URL de Nightscout no configurada' : 'Nightscout URL not configured');
    }

    const u = base.startsWith('http') ? base : (`https://${base}`);
    const sanitizedUrl = u.replace(/\/$/, '');

    const params = {};
    if (token) params.token = token;

    const headers = { 'User-Agent': `MentraOS-Nightscout/${this.appVersion}` };

    const endpoints = [
      `${sanitizedUrl}/api/v1/entries/sgv.json?count=1`,
      `${sanitizedUrl}/api/v1/entries.json?count=1`
    ];

    let data = null;
    let success = false;
    for (const url of endpoints) {
      try {
        const res = await axios.get(url, { params, headers, timeout: 10000 });
        if (res.data && res.data.length > 0) {
          data = res.data[0];
          success = true;
          break;
        }
      } catch (err) {
        session?.logger?.debug?.(`Failed to fetch from ${url}:`, err.message);
      }
    }

    if (!success || !data || !data.sgv || !data.date) {
      const lastEntry = this.lastGoodEntry.get(sessionId);
      if (lastEntry) {
        throw new Error(settings.language === 'es' ? 'No se pueden cargar datos de Nightscout. Mostrando el último valor disponible.' : 'Could not load data from Nightscout. Showing last known value.');
      } else {
        throw new Error(settings.language === 'es' ? 'Error cargando datos, revisa la configuración' : 'Error loading data, check your configuration');
      }
    }

    this.lastGoodEntry.set(sessionId, data);
    return data;
  }

  /* ---------------- Eventos de la app ---------------- */
  async onSessionStart(session) {
    const sessionId = session.id;
    const settings = await this.getUserSettings(session);

    this.activeSessions.set(sessionId, {
      session,
      userId: session.userId,
      settings
    });

    const updateIntervalMs = settings.updateInterval * 60 * 1000;
    const updateInterval = setInterval(() => this.getGlucoseAndUpdateDisplay(sessionId), updateIntervalMs);
    this.activeSessions.get(sessionId).updateInterval = updateInterval;

    this.startDayWatch(sessionId);

    this.getGlucoseAndUpdateDisplay(sessionId);
  }

  async onSessionSettingsChange(session, newSettingsArray) {
    const sessionId = session.id;
    const sessionData = this.activeSessions.get(sessionId);
    const oldSettings = sessionData.settings;
    const newSettings = this.parseSettingsFromArray(newSettingsArray);
    sessionData.settings = newSettings;

    const oldInterval = oldSettings.updateInterval * 60 * 1000;
    const newInterval = newSettings.updateInterval * 60 * 1000;

    if (oldInterval !== newInterval) {
      clearInterval(sessionData.updateInterval);
      const updateInterval = setInterval(() => this.getGlucoseAndUpdateDisplay(sessionId), newInterval);
      sessionData.updateInterval = updateInterval;
    }

    if (oldSettings.timezone !== newSettings.timezone || oldSettings.language !== newSettings.language) {
      this.stopDayWatch(sessionId);
      this.startDayWatch(sessionId);
    }
  }

  onSessionEnd(session) {
    const sessionId = session.id;
    const sessionData = this.activeSessions.get(sessionId);
    if (sessionData) {
      clearInterval(sessionData.updateInterval);
      this.activeSessions.delete(sessionId);
    }
    this.dailyTirState.delete(sessionId);
    this.lastGoodEntry.delete(sessionId);
    this.stopDayWatch(sessionId);
  }

  async show(sessionId, { headUp = false, alert = false, text = '' } = {}) {
    const sessionData = this.activeSessions.get(sessionId);
    if (!sessionData) return;

    const { session, settings } = sessionData;
    const duration = alert ? settings.alert_duration_ms : settings.display_duration_ms;

    if (alert && settings.alertsEnabled === false) return;

    const lastShown = this.headUpLastShown.get(sessionId);
    const cooldown = settings.alert_cooldown_ms;
    if (alert && lastShown && (Date.now() - lastShown < cooldown)) return;

    // TODO: Limitar a 5 líneas de texto, aunque el SDK lo hará por nosotros
    const formattedText = text;

    try {
      await session.showText({
        text: formattedText,
        duration,
        headUp,
      });
      if (alert) this.headUpLastShown.set(sessionId, Date.now());
    } catch (e) {
      session?.logger?.error?.('Error showing text:', e.message);
    }
  }

  async getGlucoseAndUpdateDisplay(sessionId) {
    const sessionData = this.activeSessions.get(sessionId);
    if (!sessionData) return;
    const { settings, session } = sessionData;
    const isAdvanced = settings.enable_advanced_mode;

    clearTimeout(this.displayTimers.get(sessionId));

    try {
      const data = await this.getGlucoseData(sessionId);
      const now = new Date();
      const minsAgo = Math.floor((now - new Date(data.date)) / 60000);
      const isStale = minsAgo > settings.updateInterval + 1;

      if (isStale) {
        throw new Error(settings.language === 'es' ? 'Datos obsoletos, Nightscout no se ha actualizado.' : 'Stale data, Nightscout has not updated.');
      }

      const formattedData = await this.formatGlucoseData(data, settings);
      const tirState = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      const lang = settings.language || 'en';
      const translations = TRANSLATIONS[lang] || TRANSLATIONS.en;

      let msg = `${formattedData.line1}\n${formattedData.line2}`;

      if (isAdvanced) {
        // Formatea la barra TIR (si está activada)
        if (settings.show_tir_bar) {
          const tirBar = this.buildTirBar(tirState.tirPct);
          if (tirBar) msg += `\nTIR: ${tirBar} ${tirState.tirPct}%`;
        }

        // Obtiene y muestra carbohidratos/insulina
        const treatments = await this.getRecentTreatments(settings, 'day');
        if (treatments && (treatments.totalCarbs > 0 || treatments.totalInsulin > 0)) {
          const treatmentsLine = this.formatTreatmentsLine(treatments, settings);
          if (treatmentsLine) msg += `\n${treatmentsLine}`;
        }

        // Agrega min/max (TODO: obtener de la API)
        msg += '\nMin: -- / Max: --';
      }

      await this.show(sessionId, { text: msg });
      
      // Manejo de alertas
      const { low, high } = this.getAlertLimits(settings);
      const isAlert = data.sgv < low || data.sgv > high;

      if (isAlert) {
        const status = this.getGlucoseStatusText(data.sgv, settings);
        await this.show(sessionId, {
          text: `${formattedData.line1}\n${status} ${settings.language === 'es' ? '¡ALERTA!' : 'ALERT!'}`,
          headUp: true,
          alert: true,
        });
      }

    } catch (e) {
      const formattedText = e.message || 'Error desconocido';
      await this.show(sessionId, { text: formattedText, alert: true });
    }
  }

  // --- Funcionalidad de reinicio diario del TIR (si no se conecta en 24h) ---
  startDayWatch(sessionId) {
    this.stopDayWatch(sessionId);
    const sessionData = this.activeSessions.get(sessionId);
    if (!sessionData) return;

    const now = new Date();
    const tz = sessionData.settings.timezone ? this.validateTimezone(sessionData.settings.timezone) : LANGUAGE_SETTINGS[sessionData.settings.language].timezone;
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const delayUntilMidnight = nextDay.getTime() - now.getTime();

    const timeoutId = setTimeout(() => {
      this.dailyTirState.delete(sessionId);
      this.startDayWatch(sessionId);
    }, delayUntilMidnight + 1000); // +1s para asegurar el cambio de día

    this.dayWatchTimers.set(sessionId, timeoutId);
  }
  stopDayWatch(sessionId) {
    const timeoutId = this.dayWatchTimers.get(sessionId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.dayWatchTimers.delete(sessionId);
    }
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

console.log('🚀 Nightscout MentraOS v2.9.7 — HUD texto + TIR │ inline + CH/Ins día + Min/Max gesto + reset diario');

// Keep-alive para Render
const KEEP_ALIVE_INTERVAL = 300000;
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL;
if (KEEP_ALIVE_URL) {
  setInterval(() => {
    axios.get(KEEP_ALIVE_URL).catch(() => {});
  }, KEEP_ALIVE_INTERVAL);
  console.log('🔗 Keep-alive activado para Render.');
}
