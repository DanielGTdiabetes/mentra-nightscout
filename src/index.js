
'use strict';
/**
 * Mentra Nightscout – index.js
 * - Lecturas en UI humana (s y min) con fallback a ms
 * - Toggle show_tir_bar respetado
 * - Caché de última lectura buena (fallback si hay error)
 * - Handlers onSession/onShow/onToolCall seguros (sin variables fuera de scope)
 * - Conectividad "conservadora": ?token + User-Agent
 */

require('dotenv').config();

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

// ----------------- Constantes -----------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.MENTRAOS_API_KEY || '';

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

const DEFAULTS = {
  UPDATE_INTERVAL_MIN: 5,
  DISPLAY_DURATION_MS: 5000,
  ALERT_DURATION_MS: 15000,
  ALERT_COOLDOWN_MS: 10 * 60 * 1000, // 10 min
};

// ----------------- Utilidades -----------------
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function parseSlicerValue(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object' && val !== null && 'value' in val) {
    const n = parseFloat(val.value);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : fallback;
}

function validateSlicerValue(val, min, max, fallback) {
  const n = parseSlicerValue(val, NaN);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeMmol(raw) {
  const n = parseSlicerValue(raw, NaN);
  if (!Number.isFinite(n)) return null;
  // si llegan como enteros x10 (39 = 3.9)
  return n > 30 ? Number((n / 10).toFixed(1)) : Number(Number(n).toFixed(1));
}

function ensureValidTimezone(tz, fallback) {
  try {
    if (!tz) return fallback || 'Europe/Madrid';
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback || 'Europe/Madrid';
  }
}

function sanitizeBaseUrl(u) {
  const raw = (u == null ? '' : String(u)).trim();
  const withProto = raw.startsWith('http') ? raw : 'https://' + raw;
  return withProto.replace(/\/+$/, '');
}

function getTrendArrow(dir) {
  const map = {
    'DoubleUp': '⇈', 'SingleUp': '↑', 'FortyFiveUp': '↗',
    'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '↓', 'DoubleDown': '⇊',
    'NONE': '-', 'NOT COMPUTABLE': '→'
  };
  return map[dir] || '→';
}

function getLanguageSettings(lang) {
  const isEs = (String(lang || 'en').toLowerCase().startsWith('es'));
  return isEs ? {
    locale: 'es-ES',
    tzDefault: 'Europe/Madrid',
    labels: {
      now: 'ahora',
      minutesAgo: (m) => `hace ${m}m`,
      noData: 'Sin datos',
    },
  } : {
    locale: 'en-GB',
    tzDefault: 'Europe/London',
    labels: {
      now: 'now',
      minutesAgo: (m) => `${m}m ago`,
      noData: 'No data',
    },
  };
}

function convertToDisplay(mgdlValue, unit) {
  if (unit === UNITS.MMOL) return Number((mgdlValue / 18).toFixed(1));
  return Math.round(mgdlValue);
}

// ----------------- App -----------------
class NightscoutMentraApp {
  constructor() {
    this.server = new AppServer({
      port: PORT,
      apiKey: API_KEY,
      onStart: this.onStart.bind(this),
      onStop: this.onStop.bind(this),
      onShow: this.onShow.bind(this),
      onToolCall: this.onToolCall.bind(this),
      onSettingsChanged: this.onSettingsChanged.bind(this),
      onSession: this.onSession.bind(this),
    });

    // estado
    this.displayTimers = new Map();     // sessionId -> timeoutId
    this.lastGoodEntry = new Map();     // sessionId -> última entrada válida
  }

  log(...args) { try { console.log(...args); } catch {} }
  logError(...args) { try { console.error(...args); } catch {} }

  // ------------- Settings -------------
  async getUserSettings(session) {
    try {
      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units,
        enable_head_up_display,

        // nuevos toggles / UI
        show_tir_bar, show_range_bar,

        // nuevos (UI humana)
        display_duration_s, alert_duration_s, alert_cooldown_min,

        // antiguos (ms) fallback
        display_duration_ms_old, alert_duration_ms_old, alert_cooldown_ms_old,
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

        session.settings.get('show_tir_bar'),
        session.settings.get('show_range_bar'),

        session.settings.get('display_duration_s'),
        session.settings.get('alert_duration_s'),
        session.settings.get('alert_cooldown_min'),

        session.settings.get('display_duration_ms'),
        session.settings.get('alert_duration_ms'),
        session.settings.get('alert_cooldown_ms'),
      ]);

      const uiMin = parseInt(updateInterval, 10);
      const updateIntervalMin = Number.isFinite(uiMin) ? uiMin : DEFAULTS.UPDATE_INTERVAL_MIN;

      // s/min -> ms si existen; si no, fallback *_ms antiguos
      const dispSRaw   = parseSlicerValue(display_duration_s, NaN);
      const alertSRaw  = parseSlicerValue(alert_duration_s, NaN);
      const coolMinRaw = parseSlicerValue(alert_cooldown_min, NaN);

      const display_duration_ms = Number.isFinite(dispSRaw)
        ? Math.min(15, Math.max(1, dispSRaw)) * 1000
        : validateSlicerValue(display_duration_ms_old, 1000, 15000, DEFAULTS.DISPLAY_DURATION_MS);

      const alert_duration_ms = Number.isFinite(alertSRaw)
        ? Math.min(60, Math.max(2, alertSRaw)) * 1000
        : validateSlicerValue(alert_duration_ms_old, 2000, 60000, DEFAULTS.ALERT_DURATION_MS);

      const alert_cooldown_ms = Number.isFinite(coolMinRaw)
        ? Math.min(60, Math.max(1, coolMinRaw)) * 60 * 1000
        : validateSlicerValue(alert_cooldown_ms_old, 60000, 3600000, DEFAULTS.ALERT_COOLDOWN_MS);

      // show_tir_bar con compatibilidad show_range_bar
      const showTirBar = (show_tir_bar == null && show_range_bar == null)
        ? true
        : (toBool(show_tir_bar) || toBool(show_range_bar));

      return {
        nightscoutUrl: String(url || '').trim(),
        nightscoutToken: String(token || '').trim(),
        updateInterval: updateIntervalMin,
        low_alert_mg: validateSlicerValue(lowMg, 40, 90, 70),
        high_alert_mg: validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: normalizeMmol(lowMmol) ?? 3.9,
        high_alert_mmol: normalizeMmol(highMmol) ?? 13.9,
        alertsEnabled: toBool(alertsEnabled),
        language: language || 'en',
        timezone: timezone || null,
        units: units || UNITS.MGDL,
        enable_head_up_display: toBool(enable_head_up_display),
        show_tir_bar: showTirBar,

        display_duration_ms,
        alert_duration_ms,
        alert_cooldown_ms,
      };
    } catch (e) {
      this.logError('[getUserSettings] error', e);
      return null;
    }
  }

  // ------------- Nightscout API -------------
  async fetchLatestEntries(url, token, count) {
    const base = sanitizeBaseUrl(url);
    const endpoint = base + '/api/v1/entries/sgv.json?count=' + (count || 12);
    const params = token ? { token: token } : {};
    const headers = { 'User-Agent': 'MentraOS-Nightscout/GB1' };
    const res = await axios.get(endpoint, { params, headers, timeout: 10000 });
    return Array.isArray(res.data) ? res.data : [];
  }

  // ------------- Display helpers -------------
  truncateLines(str, maxLines) {
    const lines = String(str || '').split(/\r?\n/);
    return lines.slice(0, maxLines || 5).join('\n');
  }

  async showText(session, text, durationMs) {
    try {
      const prev = this.displayTimers.get(session.id);
      if (prev) clearTimeout(prev);
    } catch {}
    await session.showText({ text: this.truncateLines(text, 5) });
    if (durationMs && durationMs > 0) {
      const t = setTimeout(async () => {
        try { await session.removeText(); } catch {}
      }, durationMs);
      this.displayTimers.set(session.id, t);
    }
  }

  async showClamped(session, sessionId, text) {
    try {
      const prev = this.displayTimers.get(sessionId);
      if (prev) clearTimeout(prev);
    } catch {}
    await session.showText({ text: this.truncateLines(text, 5) });
  }

  formatReadingLine(entry, settings) {
    if (!entry) return '';
    const langCfg = getLanguageSettings(settings.language);
    const tz = ensureValidTimezone(settings.timezone, langCfg.tzDefault);

    const mgdl = entry.sgv;
    const value = convertToDisplay(mgdl, settings.units);
    const arrow = getTrendArrow(entry.direction || 'Flat');

    const t = new Date(entry.date || entry.dateString || Date.now());
    const timeStr = t.toLocaleTimeString(langCfg.locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });

    const minutesAgo = Math.max(0, Math.floor((Date.now() - t.getTime()) / 60000));
    const timeAgoText = minutesAgo <= 1 ? langCfg.labels.now : langCfg.labels.minutesAgo(minutesAgo);

    return String(value) + ' ' + (settings.units || UNITS.MGDL) + ' ' + arrow + '\n' + timeStr + ' (' + timeAgoText + ')';
  }

  // TIR simple a partir de últimas N entradas (no acumulado por día para simplificar)
  computeSimpleTirPct(entries, settings) {
    try {
      const e = Array.isArray(entries) ? entries : [];
      if (e.length === 0) return null;

      // límites: intenta time_in_range_*, luego tir_*, si no, alertas
      const lowMg = (settings.time_in_range_low_mg != null) ? settings.time_in_range_low_mg
                   : (settings.tir_low_mg != null) ? settings.tir_low_mg
                   : settings.low_alert_mg;

      const highMg = (settings.time_in_range_high_mg != null) ? settings.time_in_range_high_mg
                    : (settings.tir_high_mg != null) ? settings.tir_high_mg
                    : settings.high_alert_mg;

      let total = 0, inRange = 0;
      for (let i = 0; i < e.length; i++) {
        const x = e[i];
        if (x && typeof x.sgv === 'number') {
          total++;
          if (x.sgv >= lowMg && x.sgv <= highMg) inRange++;
        }
      }
      if (total === 0) return null;
      return Math.round((inRange / total) * 100);
    } catch {
      return null;
    }
  }

  buildTirBar(pct, lang) {
    const totalBlocks = 10;
    const filled = Math.round((pct / 100) * totalBlocks);
    let bar = '';
    for (let i = 0; i < totalBlocks; i++) {
      bar += (i < filled) ? '█' : '░';
    }
    const label = (String(lang || 'en').startsWith('es')) ? 'TIR hoy' : 'TIR today';
    return label + ' ' + pct + '%\n' + bar;
  }

  async safeAdvancedText(session, latest, settings) {
    try {
      // pedir más muestras para un TIR más estable (por ejemplo, 36 ≈ 3h)
      const entries = await this.fetchLatestEntries(settings.nightscoutUrl, settings.nightscoutToken, 36);
      const tir = this.computeSimpleTirPct(entries, settings);
      let lines = [ this.formatReadingLine(latest, settings) ];

      if (toBool(settings.show_tir_bar) && tir != null) {
        lines.push(this.buildTirBar(tir, settings.language));
      }
      return lines.join('\n');
    } catch (e) {
      // fallback a la línea simple si falla el cálculo
      return this.formatReadingLine(latest, settings);
    }
  }

  // ------------- Handlers -------------
  async onStart({ sessions }) {
    this.log('Nightscout MentraOS app listening on', PORT, 'sessions:', sessions.length);
  }

  async onStop() { this.log('App stopped'); }

  async onSettingsChanged({ session }) {
    try {
      // Podríamos refrescar algo si hace falta
      this.log('Settings changed for session', session.id);
    } catch {}
  }

  async onSession({ session, userId }) {
    let settings = null;
    try {
      settings = await this.getUserSettings(session);

      if (!settings || !settings.nightscoutUrl) {
        const lang = (settings && settings.language) || 'en';
        const msg = (String(lang).startsWith('es')) ? 'Revisa la configuración (URL/Token)' : 'Check app settings (URL/Token)';
        await this.showClamped(session, session.id, msg);
        return;
      }

      const entries = await this.fetchLatestEntries(settings.nightscoutUrl, settings.nightscoutToken, 12);
      if (!Array.isArray(entries) || entries.length === 0) {
        const langCfg = getLanguageSettings((settings && settings.language) || 'en');
        await this.showClamped(session, session.id, langCfg.labels.noData);
        return;
      }

      const latest = entries[0];
      this.lastGoodEntry.set(session.id, latest);

      const text = toBool(settings.enable_head_up_display)
        ? await this.safeAdvancedText(session, latest, settings)
        : this.formatReadingLine(latest, settings);

      await this.showText(session, text, settings.display_duration_ms);
    } catch (err) {
      this.logError('[onSession] error', err);
      try {
        const lang = (settings && settings.language) || 'en';
        const cached = this.lastGoodEntry.get(session.id);
        if (cached) {
          const text = toBool(settings && settings.enable_head_up_display)
            ? await this.safeAdvancedText(session, cached, settings || { language: 'en', units: UNITS.MGDL })
            : this.formatReadingLine(cached, settings || { language: 'en', units: UNITS.MGDL });
          await this.showText(session, text, (settings && settings.display_duration_ms) || DEFAULTS.DISPLAY_DURATION_MS);
        } else {
          const msg = (String(lang).startsWith('es')) ? 'Sin datos' : 'No data';
          await this.showClamped(session, session.id, msg);
        }
      } catch {
        await this.showClamped(session, session.id, 'No data');
      }
    }
  }

  async onShow({ session }) {
    let settings = null;
    try {
      settings = await this.getUserSettings(session);
      if (!settings || !settings.nightscoutUrl) {
        const lang = (settings && settings.language) || 'en';
        const msg = (String(lang).startsWith('es')) ? 'Revisa la configuración (URL/Token)' : 'Check app settings (URL/Token)';
        await this.showClamped(session, session.id, msg);
        return;
      }
      const entries = await this.fetchLatestEntries(settings.nightscoutUrl, settings.nightscoutToken, 12);
      if (!Array.isArray(entries) || entries.length === 0) {
        const cached = this.lastGoodEntry.get(session.id);
        if (cached) {
          const textCached = toBool(settings.enable_head_up_display)
            ? await this.safeAdvancedText(session, cached, settings)
            : this.formatReadingLine(cached, settings);
          await this.showText(session, textCached, settings.display_duration_ms);
        } else {
          const langCfg = getLanguageSettings((settings && settings.language) || 'en');
          await this.showClamped(session, session.id, langCfg.labels.noData);
        }
        return;
      }
      const latest = entries[0];
      this.lastGoodEntry.set(session.id, latest);

      const text = toBool(settings.enable_head_up_display)
        ? await this.safeAdvancedText(session, latest, settings)
        : this.formatReadingLine(latest, settings);

      await this.showText(session, text, settings.display_duration_ms);
    } catch (err) {
      this.logError('[onShow] error', err);
      try {
        const lang = (settings && settings.language) || 'en';
        const cached = this.lastGoodEntry.get(session.id);
        if (cached) {
          const txt = toBool(settings && settings.enable_head_up_display)
            ? await this.safeAdvancedText(session, cached, settings || { language: 'en', units: UNITS.MGDL })
            : this.formatReadingLine(cached, settings || { language: 'en', units: UNITS.MGDL });
          await this.showText(session, txt, (settings && settings.display_duration_ms) || DEFAULTS.DISPLAY_DURATION_MS);
        } else {
          const msg = (String(lang).startsWith('es')) ? 'Sin datos' : 'No data';
          await this.showClamped(session, session.id, msg);
        }
      } catch {
        await this.showClamped(session, session.id, 'No data');
      }
    }
  }

  async onToolCall(data) {
    const activeSession = data.activeSession;
    let settings = null;
    try {
      if (!activeSession) return { success: false };

      settings = await this.getUserSettings(activeSession);
      if (!settings || !settings.nightscoutUrl) {
        const lang = (settings && settings.language) || 'en';
        const msg = (String(lang).startsWith('es')) ? 'Revisa la configuración (URL/Token)' : 'Check app settings (URL/Token)';
        await this.showClamped(activeSession, activeSession.id, msg);
        return { success: false };
      }

      const entries = await this.fetchLatestEntries(settings.nightscoutUrl, settings.nightscoutToken, 12);
      if (!Array.isArray(entries) || entries.length === 0) {
        const cached = this.lastGoodEntry.get(activeSession.id);
        if (cached) {
          const textCached = toBool(settings.enable_head_up_display)
            ? await this.safeAdvancedText(activeSession, cached, settings)
            : this.formatReadingLine(cached, settings);
          await this.showText(activeSession, textCached, settings.display_duration_ms);
          return { success: true, cached: true };
        } else {
          const langCfg = getLanguageSettings((settings && settings.language) || 'en');
          await this.showClamped(activeSession, activeSession.id, langCfg.labels.noData);
          return { success: false };
        }
      }

      const latest = entries[0];
      this.lastGoodEntry.set(activeSession.id, latest);

      const text = toBool(settings.enable_head_up_display)
        ? await this.safeAdvancedText(activeSession, latest, settings)
        : this.formatReadingLine(latest, settings);

      await this.showText(activeSession, text, settings.display_duration_ms);
      return { success: true };
    } catch (err) {
      this.logError('[onToolCall] error', err);
      try {
        const cached = this.lastGoodEntry.get(activeSession && activeSession.id);
        if (cached) {
          const txt = toBool(settings && settings.enable_head_up_display)
            ? await this.safeAdvancedText(activeSession, cached, settings || { language: 'en', units: UNITS.MGDL })
            : this.formatReadingLine(cached, settings || { language: 'en', units: UNITS.MGDL });
          await this.showText(activeSession, txt, (settings && settings.display_duration_ms) || DEFAULTS.DISPLAY_DURATION_MS);
          return { success: true, cached: true };
        }
      } catch {}
      try {
        const lang = (settings && settings.language) || 'en';
        const msg = (String(lang).startsWith('es')) ? 'Sin datos' : 'No data';
        await this.showClamped(activeSession, activeSession.id, msg);
      } catch {}
      return { success: false };
    }
  }
}

// ----------------- Bootstrap -----------------
(async () => {
  const app = new NightscoutMentraApp();
  await app.server.start();
})();
