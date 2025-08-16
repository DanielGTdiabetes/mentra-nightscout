// src/index.js — Nightscout MentraOS v2.9.0 (server-side)
// Mejoras clave:
// - Sparkline siempre visible: si hay pocos puntos, se sintetiza desde el último valor (padding inteligente)
// - SDK Layouts correctos (TextWall/DoubleTextWall/ReferenceCard) + durationMs siempre presente + ViewType
// - Ajustes leídos: enable_head_up_display + enable_sparkline_display + duraciones clamp (1000–60000 ms)
// - Anti-parpadeo básico mediante cache de contenido + timeouts más cortos (arranque más ágil)
// - mg/dL ↔ mmol/L coherente en límites y display

require('dotenv').config();

const { AppServer, ViewType } = require('@mentra/sdk');
const axios = require('axios');

// ViewType seguro por compatibilidad
const SafeViewType = ViewType || { MAIN: 'MAIN', DASHBOARD: 'DASHBOARD' };

// Fallbacks de layouts para builds sin APIs nuevas
function safeLayouts(session) {
  return {
    showDashboardCard: (t, s, opts) =>
      session.layouts?.showDashboardCard?.(t, s, opts) ||
      session.layouts?.showTextWall?.(`${t}
${s}`, { view: opts?.view, durationMs: opts?.durationMs }),
    showDoubleTextWall: (h, b, opts) =>
      session.layouts?.showDoubleTextWall?.(h, b, opts) ||
      session.layouts?.showTextWall?.(`${h}
${b}`, { view: opts?.view, durationMs: opts?.durationMs }),
    showReferenceCard: (t, s, opts) =>
      session.layouts?.showReferenceCard?.(t, s, opts) ||
      session.layouts?.showTextWall?.(`${t}
${s}`, { view: opts?.view, durationMs: opts?.durationMs }),
    showTextWall: (txt, opts) => session.layouts?.showTextWall?.(txt, opts),
    clearView: (opts) => session.layouts?.clearView?.(opts),
  };
}

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
if (!MENTRAOS_API_KEY) { console.error('❌ MENTRAOS_API_KEY environment variable is required'); process.exit(1); }

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const toNumber = (x, fb) => { const n = (typeof x === 'object' && x) ? parseFloat(x.value) : parseFloat(x); return Number.isFinite(n) ? n : fb; };
const asBool = (v) => (v === true || v === 'true' || v === 1 || v === '1');

// Sparkline ASCII (bloques). Si hay <MIN_POINTS, rellena (padding) con el último valor para que SIEMPRE se vea algo.
const MIN_POINTS = 3;      // mínimo para usar datos reales
const SPARK_WIDTH = 12;    // ancho fijo recomendado
function renderSparkline(values) {
  let nums = (values || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return ''.padEnd(SPARK_WIDTH, '.');
  if (nums.length < MIN_POINTS) {
    const last = nums[nums.length - 1];
    while (nums.length < SPARK_WIDTH) nums.push(last);
  }
  const min = Math.min(...nums); const max = Math.max(...nums);
  // Caracteres seguros para todas las fuentes de las gafas
  const blocks = ['.', '-', '_', '=', '~', '^', '*', '#'];
  if (max === min) return blocks[0].repeat(Math.max(nums.length, SPARK_WIDTH));
  const range = Math.max(1e-6, max - min);
  const out = nums.map(v => {
    const idx = Math.floor(((v - min) / range) * (blocks.length - 1));
    return blocks[clamp(idx, 0, blocks.length - 1)];
  }).join('');
  // Ajusta a ancho fijo
  return out.slice(-SPARK_WIDTH).padStart(SPARK_WIDTH, blocks[0]);
}
  const min = Math.min(...nums); const max = Math.max(...nums);
  const blocks = ['▁','▂','▃','▄','▅','▆','▇','█'];
  if (max === min) return blocks[0].repeat(nums.length);
  const range = max - min || 1e-6;
  return nums.map(v => {
    const idx = Math.floor(((v - min) / range) * (blocks.length - 1));
    return blocks[clamp(idx, 0, blocks.length - 1)];
  }).join('');
}

function trendArrow(dir) {
  const map = { 'DoubleUp':'⇈','SingleUp':'↑','FortyFiveUp':'↗','Flat':'→','FortyFiveDown':'↘','SingleDown':'↓','DoubleDown':'⇊','NONE':'-','NOT COMPUTABLE':'→' };
  return map[dir] || '→';
}
function displayValue(mgdl, unit) { return unit === UNITS.MMOL ? (Number(mgdl) / 18).toFixed(1) : Math.round(Number(mgdl)); }

function normalizeReadings(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = arr.map(r => {
    const sgv = Number(r?.sgv ?? r?.glucose);
    const dateValue = r?.date || r?.dateString || r?.sysTime;
    const ts = typeof dateValue === 'string' ? new Date(dateValue).getTime() : Number(dateValue);
    const direction = r?.direction || r?.trend || 'NONE';
    return { sgv, date: ts, direction };
  }).filter(r => Number.isFinite(r.sgv) && Number.isFinite(r.date));
  out.sort((a,b) => b.date - a.date);
  return out;
}

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions = new Map(); // sessionId -> { session, userId, settings, updateIv, cache: { MAIN, DASHBOARD } }
    this.lastAlert = new Map();
    this.headUpLast = new Map();
    this.headUpShowing = new Map(); // sessionId -> boolean (debounce visual)
  }

  /* ----- Settings ----- */
  async getSettings(session) {
    const [ url, token, updateInterval,
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
      display_duration_ms: clamp(Math.trunc(toNumber(display_duration_ms, 5000)), 1000, 60000),
      dashboard_duration_ms: clamp(Math.trunc(toNumber(dashboard_duration_ms, 4000)), 1000, 60000),
      alert_duration_ms: clamp(Math.trunc(toNumber(alert_duration_ms, 15000)), 1000, 60000),
    };

    // Sincronización del par no activo (coherencia de consola)
    try {
      if (settings.units === UNITS.MMOL) {
        const mgLow = Math.round(settings.low_alert_mmol * 18);
        const mgHigh = Math.round(settings.high_alert_mmol * 18);
        if (mgLow !== settings.low_alert_mg) await session.settings.set('low_alert_mg', mgLow);
        if (mgHigh !== settings.high_alert_mg) await session.settings.set('high_alert_mg', mgHigh);
        settings.low_alert_mg = mgLow; settings.high_alert_mg = mgHigh;
      } else {
        const mmolLow = Number((settings.low_alert_mg / 18).toFixed(1));
        const mmolHigh = Number((settings.high_alert_mg / 18).toFixed(1));
        if (mmolLow !== settings.low_alert_mmol) await session.settings.set('low_alert_mmol', mmolLow);
        if (mmolHigh !== settings.high_alert_mmol) await session.settings.set('high_alert_mmol', mmolHigh);
        settings.low_alert_mmol = mmolLow; settings.high_alert_mmol = mmolHigh;
      }
    } catch { /* best-effort */ }

    return settings;
  }

  parseSettingsFromArray(arr) {
    const o = {}; (arr || []).forEach(s => (o[s.key] = s.value));
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
      display_duration_ms: clamp(Math.trunc(toNumber(o.display_duration_ms, 5000)), 1000, 60000),
      dashboard_duration_ms: clamp(Math.trunc(toNumber(o.dashboard_duration_ms, 4000)), 1000, 60000),
      alert_duration_ms: clamp(Math.trunc(toNumber(o.alert_duration_ms, 15000)), 1000, 60000),
    };
  }

  /* ----- Nightscout ----- */
  async fetchReadings(settings, count = 24) {
    let base = settings.nightscoutUrl; if (!base) throw new Error('URL no configurada');
    if (!base.startsWith('http')) base = 'https://' + base; base = base.replace(/\/$/, '');
    const eps = [
      `${base}/api/v1/entries/sgv.json?count=${count}`,
      `${base}/api/v1/entries.json?count=${count}`,
      `${base}/api/v1/entries/current.json`
    ];
    let lastErr;
    for (const ep of eps) {
      try {
        const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
        const { data } = await axios.get(ep, { params, timeout: 5000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.9.0' } });
        const readings = normalizeReadings(data);
        if (readings.length) return readings;
        lastErr = new Error('No glucose rows');
      } catch (e) { lastErr = e; }
    }
    throw new Error(`All endpoints failed: ${lastErr?.message || 'unknown'}`);
  }

  /* ----- Cache anti-parpadeo ----- */
  ensureCache(sessionId) { if (!this.sessions.has(sessionId)) return; const st = this.sessions.get(sessionId); if (!st.cache) st.cache = { MAIN: '', DASHBOARD: '' }; this.sessions.set(sessionId, st); }
  renderIfChanged(sessionId, view, content, renderFn) {
    const key = view === SafeViewType.DASHBOARD ? 'DASHBOARD' : 'MAIN';
    this.ensureCache(sessionId);
    const st = this.sessions.get(sessionId);
    const prev = st.cache[key];
    if (content === prev) return false; // evita parpadeo
    renderFn(); st.cache[key] = content; this.sessions.set(sessionId, st); return true;
  }

  /* ----- UI helpers ----- */
  showMain(sessionId, session, settings, reading, spark) {
    const L = safeLayouts(session);
    const val = displayValue(reading.sgv, settings.units);
    const arrow = trendArrow(reading.direction);
    if (settings.enable_sparkline_display && spark) {
      const contentKey = `MAIN|${val}|${settings.units}|${arrow}|${spark}`;
      this.renderIfChanged(sessionId, SafeViewType.MAIN, contentKey, () =>
        L.showDoubleTextWall('Glucosa', `${spark}   ${val} ${settings.units} ${arrow}`, { view: SafeViewType.MAIN, durationMs: settings.dashboard_duration_ms })
      );
    } else {
      const contentKey = `MAIN|${val}|${settings.units}|${arrow}`;
      this.renderIfChanged(sessionId, SafeViewType.MAIN, contentKey, () =>
        L.showReferenceCard('Glucosa', `${val} ${settings.units} ${arrow}`, { view: SafeViewType.MAIN, durationMs: settings.dashboard_duration_ms })
      );
    }
  }|${settings.units}|${arrow}|${spark}`;
      this.renderIfChanged(sessionId, SafeViewType.MAIN, contentKey, () =>
        L.showDoubleTextWall('Glucosa', `${val} ${settings.units} ${arrow}
${spark}`, { view: SafeViewType.MAIN, durationMs: settings.dashboard_duration_ms })
      );
    } else {
      const contentKey = `MAIN|${val}|${settings.units}|${arrow}`;
      this.renderIfChanged(sessionId, SafeViewType.MAIN, contentKey, () =>
        L.showReferenceCard('Glucosa', `${val} ${settings.units} ${arrow}`, { view: SafeViewType.MAIN, durationMs: settings.dashboard_duration_ms })
      );
    }
  }

  showDashboard(sessionId, session, settings, readings, spark) {
    const L = safeLayouts(session);
    const latest = readings?.[0]; if (!latest) return;
    const val = displayValue(latest.sgv, settings.units);
    const arrow = trendArrow(latest.direction);

    if (settings.enable_sparkline_display && spark) {
      const contentKey = `DASH|${settings.units}|${spark}|${val}|${arrow}`;
      this.renderIfChanged(sessionId, SafeViewType.DASHBOARD, contentKey, () =>
        L.showDoubleTextWall('Últimas lecturas', `${spark}   ${val} ${settings.units} ${arrow}`, { view: SafeViewType.DASHBOARD, durationMs: settings.display_duration_ms })
      );
    } else {
      const contentKey = `DASH|${settings.units}|${val}|${arrow}`;
      this.renderIfChanged(sessionId, SafeViewType.DASHBOARD, contentKey, () =>
        L.showReferenceCard('Glucosa', `${val} ${settings.units} ${arrow}`, { view: SafeViewType.DASHBOARD, durationMs: settings.display_duration_ms })
      );
    }
  }|${spark}`;
      this.renderIfChanged(sessionId, SafeViewType.DASHBOARD, contentKey, () =>
        L.showDoubleTextWall('Últimas lecturas', `${val} ${settings.units} ${arrow}
${spark}`, { view: SafeViewType.DASHBOARD, durationMs: settings.display_duration_ms })
      );
    } else {
      const contentKey = `DASH|${settings.units}|${val}|${arrow}`;
      this.renderIfChanged(sessionId, SafeViewType.DASHBOARD, contentKey, () =>
        L.showReferenceCard('Glucosa', `${val} ${settings.units} ${arrow}`, { view: SafeViewType.DASHBOARD, durationMs: settings.display_duration_ms })
      );
    }
  }

  /* ----- Sesión ----- */
  async onSession(session, sessionId, userId) {
    const L = safeLayouts(session);
    session.logger?.info('Session started', { userId, sessionId });

    // Mensaje de arranque corto para evitar sensación de cuelgue
    L.showTextWall('Cargando…', { view: SafeViewType.MAIN, durationMs: 1200 });

    try {
      const settings = await this.getSettings(session);
      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        L.showReferenceCard('Nightscout', 'Configura URL y token en ajustes', { view: SafeViewType.MAIN, durationMs: 6000 });
        return;
      }

      this.sessions.set(sessionId, { session, userId, settings, updateIv: null, cache: { MAIN: '', DASHBOARD: '' } });
      this.setupHandlers(session, sessionId, userId);

      // Primer render
      try {
        const readings = await this.fetchReadings(settings, 24);
        const seriesVals = readings.slice(0, 8).map(r => Number(displayValue(r.sgv, settings.units))).reverse();
        const spark = renderSparkline(seriesVals.length ? seriesVals : [Number(displayValue(readings[0].sgv, settings.units))]);
        this.showMain(sessionId, session, settings, readings[0], spark);
      } catch (e) {
        L.showReferenceCard('Nightscout', 'No se puede conectar. Revisa URL y token', { view: SafeViewType.MAIN, durationMs: 6000 });
      }

      await this.startLoop(session, sessionId);
    } catch (e) {
      session.logger?.error(e, 'Error iniciando sesión');
      L.showReferenceCard('Error', 'Check app settings', { view: SafeViewType.MAIN, durationMs: 5000 });
    }
  }

  setupHandlers(session, sessionId, userId) {
    const L = safeLayouts(session);

    // Botón físico: refresco rápido MAIN
    session.events?.onButtonPress?.(async () => {
      const st = this.sessions.get(sessionId)?.settings || await this.getSettings(session);
      try {
        const readings = await this.fetchReadings(st, 24);
        const seriesVals = readings.slice(0, 8).map(r => Number(displayValue(r.sgv, st.units))).reverse();
        const spark = renderSparkline(seriesVals.length ? seriesVals : [Number(displayValue(readings[0].sgv, st.units))]);
        this.showMain(sessionId, session, st, readings[0], spark);
      } catch {}
    });

    // Cambios de ajustes (varias señales por compatibilidad)
    const onSettings = async (payload) => {
      const parsed = this.parseSettingsFromArray(payload || []);
      const st = this.sessions.get(sessionId); if (!st) return;

      // Reinicia intervalo si cambia
      if (st.settings.updateInterval !== parsed.updateInterval) {
        if (st.updateIv) clearInterval(st.updateIv);
        st.updateIv = null;
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

      // Actualiza estado y resetea cache para forzar re-render limpio
      st.settings = parsed; st.cache = { MAIN: '', DASHBOARD: '' }; this.sessions.set(sessionId, st);

      // Eco breve
      const lines = ['Ajustes guardados'];
      if (parsed.units === UNITS.MMOL) { lines.push(`Low: ${parsed.low_alert_mmol} mmol/L`); lines.push(`High: ${parsed.high_alert_mmol} mmol/L`); }
      else { lines.push(`Low: ${parsed.low_alert_mg} mg/dL`); lines.push(`High: ${parsed.high_alert_mg} mg/dL`); }
      lines.push(`HUD:${parsed.enable_head_up_display ? 'ON':'OFF'} Spark:${parsed.enable_sparkline_display ? 'ON':'OFF'}`);
      L.showTextWall('
' + lines.join('
'), { view: SafeViewType.MAIN, durationMs: 1800 });
    };

    session.events?.onAppSettingsUpdate?.(onSettings);
    session.events?.onSettingsUpdate?.(onSettings);
    session.events?.onSettingsChange?.(onSettings);

    // Head up → DASHBOARD (sparkline si procede)
    session.events?.onHeadPosition?.(async (data) => {
      if (!data || data.position !== 'up') return;
      const st = this.sessions.get(sessionId); if (!st) return;
      const s = st.settings; if (!s?.enable_head_up_display) return;

      // Debounce fuerte: ignora si ya estamos mostrando dashboard
      if (this.headUpShowing.get(sessionId)) return;

      const now = Date.now();
      const last = this.headUpLast.get(sessionId) || 0;
      if (now - last < 1200) return; // micro-debounce eventos rápidos
      this.headUpLast.set(sessionId, now);

      try {
        this.headUpShowing.set(sessionId, true);
        const readings = await this.fetchReadings(s, 24);
        const seriesVals = readings.slice(0, 8).map(r => Number(displayValue(r.sgv, s.units))).reverse();
        const base = seriesVals.length ? seriesVals : [Number(displayValue(readings[0].sgv, s.units))];
        const spark = renderSparkline(base);
        this.showDashboard(sessionId, session, s, readings, spark);
      } catch {
        safeLayouts(session).showReferenceCard('Nightscout', 'Sin datos', { view: SafeViewType.DASHBOARD, durationMs: s.display_duration_ms || 2500 });
      } finally {
        // libera el lock cuando expire el layout
        const releaseMs = clamp(Number(s.display_duration_ms) || 4000, 1000, 60000) + 100;
        setTimeout(() => this.headUpShowing.set(sessionId, false), releaseMs);
      }
    });
      }
    });

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
    const st = this.sessions.get(sessionId); if (!st) return;
    const settings = settingsOverride || st.settings || await this.getSettings(session);
    const everyMs = clamp(Number(settings.updateInterval) || 5, 1, 60) * 60 * 1000;

    const iv = setInterval(async () => {
      if (!this.sessions.has(sessionId)) return clearInterval(iv);
      try {
        const s = this.sessions.get(sessionId)?.settings || settings;
        const readings = await this.fetchReadings(s, 1);
        const r = readings[0]; if (!r) return;

        // Alertas con límites según unidad
        const lowMg  = Math.round(s.units === UNITS.MMOL ? s.low_alert_mmol * 18 : s.low_alert_mg);
        const highMg = Math.round(s.units === UNITS.MMOL ? s.high_alert_mmol * 18 : s.high_alert_mg);

        const last = this.lastAlert.get(sessionId) || 0; if (Date.now() - last < 10 * 60 * 1000) return; // antispam 10m
        if (s.alertsEnabled && (r.sgv <= lowMg || r.sgv >= highMg)) {
          const type = (r.sgv <= lowMg) ? 'low' : 'high';
          const val = displayValue(r.sgv, s.units);
          const text = type === 'low' ? `🚨 ¡GLUCOSA BAJA!
${val} ${s.units}` : `🚨 ¡GLUCOSA ALTA!
${val} ${s.units}`;
          this.renderIfChanged(sessionId, SafeViewType.MAIN, `ALERT|${type}|${val}|${s.units}`,
            () => safeLayouts(session).showReferenceCard('Alerta', text, { view: SafeViewType.MAIN, durationMs: s.alert_duration_ms })
          );
          this.lastAlert.set(sessionId, Date.now());
        }
      } catch (e) { session.logger?.debug('Periodic cycle failed', { error: e?.message }); }
    }, everyMs);

    if (st.updateIv) clearInterval(st.updateIv);
    st.updateIv = iv; this.sessions.set(sessionId, st);
  }

  /* ----- Mira tool ----- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName; const userId = data.userId; const activeSession = data.activeSession;
    const isEs = ['obtener_glucosa','revisar_glucosa','nivel_glucosa','mi_glucosa'].includes(toolId); const lang = isEs ? 'es' : 'en';
    try {
      let settings = null;
      if (activeSession?.settings?.settings) settings = this.parseSettingsFromArray(activeSession.settings.settings);
      else { for (const [sid, st] of this.sessions) { if (st.userId === userId) { settings = st.settings; break; } } }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) throw new Error(isEs ? 'Nightscout no configurado' : 'Nightscout not configured');

      const readings = await this.fetchReadings(settings, 1);
      const r = readings[0]; if (!r) throw new Error('Sin datos');
      const val = displayValue(r.sgv, settings.units); const tr = trendArrow(r.direction);

      const lowMg  = Math.round(settings.units === UNITS.MMOL ? settings.low_alert_mmol * 18 : settings.low_alert_mg);
      const highMg = Math.round(settings.units === UNITS.MMOL ? settings.high_alert_mmol * 18 : settings.high_alert_mg);
      let status = 'Normal';
      if (r.sgv < 70) status = isEs ? 'Crítico Bajo' : 'Critical Low';
      else if (r.sgv <= lowMg) status = isEs ? 'Bajo' : 'Low';
      else if (r.sgv > 250) status = isEs ? 'Crítico Alto' : 'Critical High';
      else if (r.sgv >= highMg) status = isEs ? 'Alto' : 'High';

      const msg = isEs ? `Tu glucosa está en ${val} ${settings.units} ${tr}. Estado: ${status}.` : `Your glucose is ${val} ${settings.units} ${tr}. Status: ${status}.`;
      return { success: true, data: { glucose: val, unit: settings.units, trend: tr, status }, message: msg };
    } catch (e) { return { success: false, error: isEs ? `Error: ${e.message}` : `Error: ${e.message}` }; }
  }
}

/* ----- Init ----- */
const server = new NightscoutMentraApp({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
server.start().catch(err => { console.error('❌ Error iniciando servidor:', err); process.exit(1); });
console.log('🚀 Nightscout MentraOS v2.9.0 — Sparkline robusto + Layouts + Durations + Anti-flicker');

const KEEP_ALIVE_URL = process.env.RENDER_URL || '';
server.app.get('/health', (_, res) => res.json({ status: 'alive', timestamp: new Date().toISOString(), version: '2.9.0', activeSessions: server.sessions.size }));
if (KEEP_ALIVE_URL) setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
