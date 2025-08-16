// src/index.js — Nightscout MentraOS v2.8.0
// Optimizado: anti-parpadeo, layouts MAIN/DASHBOARD, duraciones configurables, mg/dL↔mmol/L coherente, sparkline opcional

require('dotenv').config();

const { AppServer, ViewType } = require('@mentra/sdk');
const axios = require('axios');

/* ---------- Compat: evita crash si el SDK llama a métodos inexistentes ---------- */
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async function () { /* noop */ },
    writable: true, configurable: true, enumerable: false
  });
}
/* ------------------------------------------------------------------------------- */

const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error('❌ MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

/* ========== Utilidades ========== */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const toNumber = (x, fb) => {
  const n = (typeof x === 'object' && x) ? parseFloat(x.value) : parseFloat(x);
  return Number.isFinite(n) ? n : fb;
};
const asBool = (v) => (v === true || v === 'true' || v === 1 || v === '1');

/** Sparkline ASCII simple */
function renderSparkline(values) {
  if (!values || !values.length) return '';
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const levels = ['▁','▂','▃','▄','▅','▆','▇','█'];
  if (max === min) return levels[0].repeat(nums.length);
  const range = max - min;
  return nums.map(v => {
    const idx = Math.floor(((v - min) / range) * (levels.length - 1));
    return levels[clamp(idx, 0, levels.length - 1)];
  }).join('');
}

/** Mapea direction a flecha */
function trendArrow(dir) {
  const map = {
    'DoubleUp':'⇈', 'SingleUp':'↑', 'FortyFiveUp':'↗',
    'Flat':'→', 'FortyFiveDown':'↘', 'SingleDown':'↓', 'DoubleDown':'⇊',
    'NONE':'-', 'NOT COMPUTABLE':'→'
  };
  return map[dir] || '→';
}

/** Conv a unidad visual */
function displayValue(mgdl, unit) {
  if (unit === UNITS.MMOL) return (Number(mgdl) / 18).toFixed(1);
  return Math.round(Number(mgdl));
}

/** Normaliza lecturas de Nightscout -> {sgv, date, direction}[] */
function normalizeReadings(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  const readings = arr.map(r => {
    const sgv = Number(r?.sgv ?? r?.glucose);
    const dateValue = r?.date || r?.dateString || r?.sysTime;
    const ts = typeof dateValue === 'string' ? new Date(dateValue).getTime() : Number(dateValue);
    const direction = r?.direction || r?.trend || 'NONE';
    return { sgv, date: ts, direction };
  }).filter(r => Number.isFinite(r.sgv) && Number.isFinite(r.date));
  readings.sort((a,b) => b.date - a.date);
  return readings;
}

/* ========== App ========== */
class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions = new Map(); // sessionId -> { session, userId, settings, updateIv, cache: {MAIN, DASHBOARD} }
    this.lastAlert = new Map(); // sessionId -> ts
    this.headUpLast = new Map(); // sessionId -> ts
  }

  /* ----- Settings ----- */
  async getSettings(session) {
    const [
      url, token, updateInterval,
      lowMg, highMg, lowMmol, highMmol,
      alertsEnabled, language, timezone, units,
      enable_head_up_display, enable_sparkline_display,
      display_duration_ms, dashboard_duration_ms, alert_duration_ms
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
      session.settings.get('enable_sparkline_display'),
      session.settings.get('display_duration_ms'),
      session.settings.get('dashboard_duration_ms'),
      session.settings.get('alert_duration_ms'),
    ]).catch(() => []);

    const settings = {
      nightscoutUrl: String(url || '').trim(),
      nightscoutToken: String(token || '').trim(),
      updateInterval: clamp(toNumber(updateInterval, 5), 1, 60),
      low_alert_mg: clamp(toNumber(lowMg, 70), 40, 90),
      high_alert_mg: clamp(toNumber(highMg, 250), 180, 400),
      low_alert_mmol: clamp(toNumber(lowMmol, 3.9), 2, 5),
      high_alert_mmol: clamp(toNumber(highMmol, 13.9), 8, 30),
      alertsEnabled: asBool(alertsEnabled),
      language: language || 'es',
      timezone: timezone || 'Europe/Madrid',
      units: units || UNITS.MGDL,
      enable_head_up_display: asBool(enable_head_up_display),
      enable_sparkline_display: asBool(enable_sparkline_display),
      display_duration_ms: Math.trunc(toNumber(display_duration_ms, 5000)),
      dashboard_duration_ms: Math.trunc(toNumber(dashboard_duration_ms, 4000)),
      alert_duration_ms: Math.trunc(toNumber(alert_duration_ms, 15000)),
    };

    // Sincroniza el par no activo (para mantener consola coherente)
    try {
      if (settings.units === UNITS.MMOL) {
        const mgLow = Math.round(settings.low_alert_mmol * 18);
        const mgHigh = Math.round(settings.high_alert_mmol * 18);
        if (mgLow !== settings.low_alert_mg) await session.settings.set('low_alert_mg', mgLow);
        if (mgHigh !== settings.high_alert_mg) await session.settings.set('high_alert_mg', mgHigh);
        settings.low_alert_mg = mgLow;
        settings.high_alert_mg = mgHigh;
      } else {
        const mmolLow = Number((settings.low_alert_mg / 18).toFixed(1));
        const mmolHigh = Number((settings.high_alert_mg / 18).toFixed(1));
        if (mmolLow !== settings.low_alert_mmol) await session.settings.set('low_alert_mmol', mmolLow);
        if (mmolHigh !== settings.high_alert_mmol) await session.settings.set('high_alert_mmol', mmolHigh);
        settings.low_alert_mmol = mmolLow;
        settings.high_alert_mmol = mmolHigh;
      }
    } catch { /* best-effort */ }

    return settings;
  }

  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    return {
      nightscoutUrl: String(o.nightscout_url || '').trim(),
      nightscoutToken: String(o.nightscout_token || '').trim(),
      updateInterval: clamp(toNumber(o.update_interval, 5), 1, 60),
      low_alert_mg: clamp(toNumber(o.low_alert_mg, 70), 40, 90),
      high_alert_mg: clamp(toNumber(o.high_alert_mg, 250), 180, 400),
      low_alert_mmol: clamp(toNumber(o.low_alert_mmol, 3.9), 2, 5),
      high_alert_mmol: clamp(toNumber(o.high_alert_mmol, 13.9), 8, 30),
      alertsEnabled: asBool(o.alerts_enabled),
      language: o.language || 'es',
      timezone: o.timezone || 'Europe/Madrid',
      units: o.units || UNITS.MGDL,
      enable_head_up_display: asBool(o.enable_head_up_display),
      enable_sparkline_display: asBool(o.enable_sparkline_display),
      display_duration_ms: Math.trunc(toNumber(o.display_duration_ms, 5000)),
      dashboard_duration_ms: Math.trunc(toNumber(o.dashboard_duration_ms, 4000)),
      alert_duration_ms: Math.trunc(toNumber(o.alert_duration_ms, 15000)),
    };
  }

  /* ----- Nightscout ----- */
  async fetchReadings(settings, count = 8) {
    let base = settings.nightscoutUrl;
    if (!base) throw new Error('URL no configurada');
    if (!base.startsWith('http')) base = 'https://' + base;
    base = base.replace(/\/$/, '');

    const eps = [
      `${base}/api/v1/entries/sgv.json?count=${count}`,
      `${base}/api/v1/entries.json?count=${count}`,
      `${base}/api/v1/entries/current.json`
    ];

    let lastErr;
    for (const ep of eps) {
      try {
        const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
        const { data } = await axios.get(ep, {
          params, timeout: 10000,
          headers: { 'User-Agent': 'MentraOS-Nightscout/2.8.0' }
        });
        const readings = normalizeReadings(data);
        if (readings.length) return readings;
        lastErr = new Error('No glucose rows');
      } catch (e) { lastErr = e; }
    }
    throw new Error(`All endpoints failed: ${lastErr?.message || 'unknown'}`);
  }

  /* ----- Render helpers con anti-parpadeo ----- */
  ensureSessionCache(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    const state = this.sessions.get(sessionId);
    if (!state.cache) state.cache = { MAIN: '', DASHBOARD: '' };
    this.sessions.set(sessionId, state);
  }
  renderIfChanged(sessionId, view, content, renderFn) {
    const key = view === ViewType.DASHBOARD ? 'DASHBOARD' : 'MAIN';
    this.ensureSessionCache(sessionId);
    const state = this.sessions.get(sessionId);
    const prev = state.cache[key];
    if (content === prev) return false; // no re-render → evita parpadeo
    renderFn();
    state.cache[key] = content;
    this.sessions.set(sessionId, state);
    return true;
  }

  showMainCard(sessionId, session, settings, reading) {
    if (!reading || !Number.isFinite(reading.sgv)) return;
    const val = displayValue(reading.sgv, settings.units);
    const arrow = trendArrow(reading.direction);
    const contentKey = `Glucosa|${val}|${settings.units}|${arrow}`;

    this.renderIfChanged(
      sessionId,
      ViewType.MAIN,
      contentKey,
      () => session.layouts.showDashboardCard(
        'Glucosa',
        `${val} ${settings.units} ${arrow}`,
        { view: ViewType.MAIN, durationMs: settings.display_duration_ms || 5000 }
      )
    );
  }

  showDashboard(sessionId, session, settings, readings) {
    const latest = readings?.[0];
    if (!latest) return;

    const sparkOn = settings.enable_sparkline_display;
    let bottom;
    if (sparkOn && readings.length >= 3) {
      const hist = readings
        .slice(0, 8)
        .map(r => Number(displayValue(r.sgv, settings.units)))
        .reverse(); // antiguo → reciente
      bottom = renderSparkline(hist);
    } else {
      const val = displayValue(latest.sgv, settings.units);
      const arrow = trendArrow(latest.direction);
      bottom = `${val} ${settings.units} ${arrow}`;
    }

    const contentKey = `Dash|${settings.units}|${bottom}`;
    this.renderIfChanged(
      sessionId,
      ViewType.DASHBOARD,
      contentKey,
      () => session.layouts.showDoubleTextWall(
        'Últimas lecturas',
        bottom,
        { view: ViewType.DASHBOARD, durationMs: settings.dashboard_duration_ms || 4000 }
      )
    );
  }

  showAlert(sessionId, session, settings, reading, type /* 'low'|'high' */) {
    const val = displayValue(reading.sgv, settings.units);
    const title = 'Alerta';
    const text = type === 'low'
      ? `🚨 ¡GLUCOSA BAJA!\n${val} ${settings.units}`
      : `🚨 ¡GLUCOSA ALTA!\n${val} ${settings.units}`;
    const contentKey = `Alert|${type}|${val}|${settings.units}`;

    const now = Date.now();
    const last = this.lastAlert.get(sessionId) || 0;
    if (now - last < 10 * 60 * 1000) return; // antispam 10 min

    const rendered = this.renderIfChanged(
      sessionId,
      ViewType.MAIN,
      contentKey,
      () => session.layouts.showReferenceCard(
        title, text,
        { view: ViewType.MAIN, durationMs: settings.alert_duration_ms || 15000 }
      )
    );
    if (rendered) this.lastAlert.set(sessionId, now);
  }

  /* ----- Sesión ----- */
  async onSession(session, sessionId, userId) {
    session.logger?.info('Session started', { userId, sessionId });

    try {
      const settings = await this.getSettings(session);
      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        session.layouts.showTextWall(
          'Configura URL y token de Nightscout en ajustes',
          { view: ViewType.MAIN, durationMs: 6000 }
        );
        return;
      }

      this.sessions.set(sessionId, { session, userId, settings, updateIv: null, cache: { MAIN: '', DASHBOARD: '' } });

      // Handlers
      this.setupHandlers(session, sessionId, userId);

      // Primer render corto (MAIN)
      try {
        const readings = await this.fetchReadings(settings, 1);
        this.showMainCard(sessionId, session, settings, readings[0]);
      } catch (e) {
        session.layouts.showReferenceCard(
          'Nightscout',
          'No se puede conectar. Revisa URL y token',
          { view: ViewType.MAIN, durationMs: 6000 }
        );
      }

      // Loop periódico (alertas)
      await this.startLoop(session, sessionId);

    } catch (e) {
      session.logger?.error(e, 'Error iniciando sesión');
      session.layouts.showReferenceCard('Error', 'Check app settings', { view: ViewType.MAIN, durationMs: 5000 });
    }
  }

  setupHandlers(session, sessionId, userId) {
    // Botón: refresco rápido en MAIN
    session.events?.onButtonPress?.(async () => {
      const st = this.sessions.get(sessionId)?.settings || await this.getSettings(session);
      try {
        const readings = await this.fetchReadings(st, 1);
        this.showMainCard(sessionId, session, st, readings[0]);
      } catch {/* silent */}
    });

    // Settings update (varios nombres por compat)
    const onSettings = async (payload) => {
      const parsed = this.parseSettingsFromArray(payload || []);
      const state = this.sessions.get(sessionId);
      if (!state) return;

      // Reinicio del intervalo si cambia frecuencia
      if (state.settings.updateInterval !== parsed.updateInterval) {
        if (state.updateIv) clearInterval(state.updateIv);
        state.updateIv = null;
        await this.startLoop(session, sessionId, parsed);
      }

      // Sincroniza pares mg↔mmol (best-effort)
      try {
        if (parsed.units === UNITS.MMOL) {
          const mgLow = Math.round(parsed.low_alert_mmol * 18);
          const mgHigh = Math.round(parsed.high_alert_mmol * 18);
          if (mgLow !== parsed.low_alert_mg) await session.settings.set('low_alert_mg', mgLow);
          if (mgHigh !== parsed.high_alert_mg) await session.settings.set('high_alert_mg', mgHigh);
          parsed.low_alert_mg = mgLow; parsed.high_alert_mg = mgHigh;
        } else {
          const mmolLow = Number((parsed.low_alert_mg / 18).toFixed(1));
          const mmolHigh = Number((parsed.high_alert_mg / 18).toFixed(1));
          if (mmolLow !== parsed.low_alert_mmol) await session.settings.set('low_alert_mmol', mmolLow);
          if (mmolHigh !== parsed.high_alert_mmol) await session.settings.set('high_alert_mmol', mmolHigh);
          parsed.low_alert_mmol = mmolLow; parsed.high_alert_mmol = mmolHigh;
        }
      } catch { /* best-effort */ }

      // Actualiza y resetea cache de render para evitar “quedar clavado”
      state.settings = parsed;
      state.cache = { MAIN: '', DASHBOARD: '' };
      this.sessions.set(sessionId, state);

      // Eco breve
      const lines = ['Ajustes guardados'];
      if (parsed.units === UNITS.MMOL) {
        lines.push(`Low: ${parsed.low_alert_mmol} mmol/L`);
        lines.push(`High: ${parsed.high_alert_mmol} mmol/L`);
      } else {
        lines.push(`Low: ${parsed.low_alert_mg} mg/dL`);
        lines.push(`High: ${parsed.high_alert_mg} mg/dL`);
      }
      lines.push(`HUD:${parsed.enable_head_up_display ? 'ON':'OFF'} Spark:${parsed.enable_sparkline_display ? 'ON':'OFF'}`);
      session.layouts.showTextWall(`\n${lines.join('\n')}`, { view: ViewType.MAIN, durationMs: 1800 });
    };

    session.events?.onAppSettingsUpdate?.(onSettings);
    session.events?.onSettingsUpdate?.(onSettings);
    session.events?.onSettingsChange?.(onSettings);

    // Head up: mostrar DASHBOARD (con sparkline si está ON)
    session.events?.onHeadPosition?.(async (data) => {
      if (!data || data.position !== 'up') return;
      const state = this.sessions.get(sessionId); if (!state) return;
      const s = state.settings; if (!s?.enable_head_up_display) return;

      const now = Date.now();
      const last = this.headUpLast.get(sessionId) || 0;
      if (now - last < 10_000) return; // cooldown 10s
      this.headUpLast.set(sessionId, now);

      try {
        const readings = await this.fetchReadings(s, 8);
        this.showDashboard(sessionId, session, s, readings);
      } catch {
        session.layouts.showDoubleTextWall('Nightscout', 'Sin datos', { view: ViewType.DASHBOARD, durationMs: s.dashboard_duration_ms || 2500 });
      }
    });

    // Limpieza
    session.events?.onDisconnected?.(() => {
      const st = this.sessions.get(sessionId);
      if (st?.updateIv) clearInterval(st.updateIv);
      this.sessions.delete(sessionId);
      this.lastAlert.delete(sessionId);
      this.headUpLast.delete(sessionId);
      session.logger?.info('Session disconnected');
    });
  }

  /* ----- Loop periódico (alertas) ----- */
  async startLoop(session, sessionId, settingsOverride = null) {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    const settings = settingsOverride || st.settings || await this.getSettings(session);
    const everyMs = clamp(Number(settings.updateInterval) || 5, 1, 60) * 60 * 1000;

    const iv = setInterval(async () => {
      if (!this.sessions.has(sessionId)) return clearInterval(iv);
      try {
        const s = this.sessions.get(sessionId)?.settings || settings;
        const readings = await this.fetchReadings(s, 1);
        const r = readings[0];
        if (!r) return;

        // Alertas
        if (s.alertsEnabled) {
          const lowMg  = Math.round(s.units === UNITS.MMOL ? s.low_alert_mmol * 18 : s.low_alert_mg);
          const highMg = Math.round(s.units === UNITS.MMOL ? s.high_alert_mmol * 18 : s.high_alert_mg);
          if (r.sgv <= lowMg) this.showAlert(sessionId, session, s, r, 'low');
          else if (r.sgv >= highMg) this.showAlert(sessionId, session, s, r, 'high');
        }
      } catch (e) {
        session.logger?.debug('Periodic cycle failed', { error: e?.message });
      }
    }, everyMs);

    if (st.updateIv) clearInterval(st.updateIv);
    st.updateIv = iv;
    this.sessions.set(sessionId, st);
  }

  /* ----- Mira tool ----- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;
    const isEs = ['obtener_glucosa','revisar_glucosa','nivel_glucosa','mi_glucosa'].includes(toolId);
    const lang = isEs ? 'es' : 'en';

    try {
      let settings = null, session = null;
      if (activeSession?.settings?.settings) {
        settings = this.parseSettingsFromArray(activeSession.settings.settings);
      } else {
        for (const [sid, st] of this.sessions) {
          if (st.userId === userId) { settings = st.settings; session = st.session; break; }
        }
      }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
        throw new Error(isEs ? 'Nightscout no configurado' : 'Nightscout not configured');
      }

      const readings = await this.fetchReadings(settings, 1);
      const r = readings[0];
      if (!r) throw new Error('Sin datos');

      const val = displayValue(r.sgv, settings.units);
      const tr = trendArrow(r.direction);

      const lowMg  = Math.round(settings.units === UNITS.MMOL ? settings.low_alert_mmol * 18 : settings.low_alert_mg);
      const highMg = Math.round(settings.units === UNITS.MMOL ? settings.high_alert_mmol * 18 : settings.high_alert_mg);

      let status = 'Normal';
      if (r.sgv < 70) status = isEs ? 'Crítico Bajo' : 'Critical Low';
      else if (r.sgv <= lowMg) status = isEs ? 'Bajo' : 'Low';
      else if (r.sgv > 250) status = isEs ? 'Crítico Alto' : 'Critical High';
      else if (r.sgv >= highMg) status = isEs ? 'Alto' : 'High';

      const msg = isEs
        ? `Tu glucosa está en ${val} ${settings.units} ${tr}. Estado: ${status}.`
        : `Your glucose is ${val} ${settings.units} ${tr}. Status: ${status}.`;

      return { success: true, data: { glucose: val, unit: settings.units, trend: tr, status }, message: msg };
    } catch (e) {
      return { success: false, error: isEs ? `Error: ${e.message}` : `Error: ${e.message}` };
    }
  }
}

/* ----- Init ----- */
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server.start().catch(err => {
  console.error('❌ Error iniciando servidor:', err);
  process.exit(1);
});

console.log('🚀 Nightscout MentraOS v2.8.0 — Anti-flicker + Layouts + Sparkline + Durations');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.8.0',
  activeSessions: server.sessions.size
}));
setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
