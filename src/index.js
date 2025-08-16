// index.js – Mentra + Nightscout (revisión 2025-08-16)
// Objetivos clave:
// - HUD con sparkline opcional y fallback a último valor cuando no hay datos suficientes.
// - Watchdog anti-bloqueos: si el HUD o la app quedan "atascados", forzar refresco seguro.
// - Relectura en caliente de settings (sin reiniciar) y límites de seguridad para los tiempos.
// - Logs detallados (nivel debug) para diagnosticar eventos head-up y pipeline de datos.
//
// NOTA: Esta versión asume un runtime Mentra con API similar a:
//   - mentra.settings.get(key), .onChange(callback)
//   - mentra.events.onHeadPosition((pos) => { 'up' | 'down' })
//   - mentra.display.showHUD(payload), mentra.display.hideHUD()
//   - mentra.display.showTextWall(text), mentra.display.showToast(text, ms)
//   - mentra.app.onStart(cb), mentra.app.onStop(cb)
// Si alguna API difiere, adapta los adaptadores al final de este archivo (Adapter Layer).

////////////////////
// Configuración   //
////////////////////
const SETTINGS = {
  enable_head_up_display: { type: 'toggle', default: true },
  enable_sparkline_display: { type: 'toggle', default: true },
  display_duration_ms: { type: 'number', default: 5000, min: 1000, max: 60000 },
  dashboard_duration_ms: { type: 'number', default: 4000, min: 1000, max: 60000 },
  alert_duration_ms: { type: 'number', default: 15000, min: 1000, max: 60000 },
  // Sugerido: unidad y umbrales pueden estar ya en tu backend/App Console.
  glucose_units: { type: 'select', default: 'mg/dL', options: ['mg/dL', 'mmol/L'] },
};

const MIN_POINTS_FOR_SPARKLINE = 5; // si <5 puntos, caemos a fallback de último valor
const FETCH_COUNT = 36;              // ~3 horas si entrada cada 5 min (ajustable)
const DATA_STALE_MS = 10 * 60 * 1000; // considerar datos "viejos" si >10 min
const HEAD_EVENT_DEBOUNCE_MS = 400;   // evita flapping por movimientos rápidos
const WATCHDOG_INTERVAL_MS = 8000;    // revisa estado cada 8s

////////////////////
// Estado runtime  //
////////////////////
let state = {
  settings: {},
  lastHeadPos: 'down',
  hudVisible: false,
  lastHudRenderAt: 0,
  lastDataFetchAt: 0,
  lastSgv: null,
  watchdogTimer: null,
  headDebounceTimer: null,
  refreshingUI: false,
};

////////////////////
// Utilidades      //
////////////////////
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const now = () => Date.now();

function dlog(...args) {
  // Toggle global si quieres silenciar logs
  const ENABLE_DEBUG = true;
  if (ENABLE_DEBUG) console.log('[MentraNS]', ...args);
}

function msSetting(key) {
  const def = SETTINGS[key];
  if (!def) return 0;
  const raw = Number(state.settings[key] ?? def.default);
  return clamp(isNaN(raw) ? def.default : raw, def.min ?? 0, def.max ?? 1e9);
}

function toUserUnits(valueMgdl, units) {
  if (units === 'mmol/L') return +(valueMgdl / 18.0).toFixed(1);
  return Math.round(valueMgdl);
}

function isStale(ts) {
  return now() - ts > DATA_STALE_MS;
}

////////////////////
// Nightscout I/O  //
////////////////////
async function fetchNightscoutEntries() {
  const baseUrl = await adapter.getNightscoutBaseUrl();
  if (!baseUrl) throw new Error('Nightscout URL no configurada.');
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/entries.json?count=${FETCH_COUNT}`;
  dlog('Fetching', url);
  const res = await adapter.fetch(url);
  if (!res.ok) throw new Error(`Nightscout HTTP ${res.status}`);
  const data = await res.json();
  // data: [{ sgv, date, direction, ... }]
  return Array.isArray(data) ? data : [];
}

function normalizeEntries(entries) {
  // Ordenar por fecha ascendente (antiguo -> reciente)
  const sorted = [...entries].sort((a, b) => (a.date || 0) - (b.date || 0));
  return sorted.map(e => ({
    ts: e.date || (e.dateString ? new Date(e.dateString).getTime() : null),
    mgdl: e.sgv ?? null,
    dir: e.direction || null,
  })).filter(e => e.ts && e.mgdl);
}

async function getGlucoseSeries() {
  const entries = await fetchNightscoutEntries();
  const norm = normalizeEntries(entries);
  state.lastDataFetchAt = now();
  if (norm.length === 0) return { series: [], last: null };
  const last = norm[norm.length - 1];
  state.lastSgv = last;
  return { series: norm, last };
}

///////////////////////////////
// Render HUD + Fallback     //
///////////////////////////////
async function renderHUD(reason = 'manual') {
  try {
    dlog('renderHUD start', { reason });
    const units = state.settings.glucose_units || SETTINGS.glucose_units.default;
    const enableSpark = !!(state.settings.enable_sparkline_display ?? SETTINGS.enable_sparkline_display.default);

    const { series, last } = await getGlucoseSeries();

    // Validaciones de datos
    if (!last) {
      dlog('Sin datos Nightscout. Fallback texto.');
      await adapter.displayHUD({
        title: 'Glucosa',
        subtitle: 'Sin datos recientes',
        body: 'Comprueba conexión o URL.',
        units,
        value: null,
        sparkline: null,
      });
      state.hudVisible = true;
      state.lastHudRenderAt = now();
      return;
    }

    const valueUser = toUserUnits(last.mgdl, units);
    const timeStr = new Date(last.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let sparkline = null;
    if (enableSpark && series.length >= MIN_POINTS_FOR_SPARKLINE) {
      // Genera sparkline base: pares [ts, valor]
      sparkline = series.map(p => [p.ts, toUserUnits(p.mgdl, units)]);
    }

    const isDataStale = isStale(last.ts);
    const subtitle = isDataStale ? `Último: ${timeStr} (desactualizado)` : `Último: ${timeStr}`;

    await adapter.displayHUD({
      title: 'Glucosa',
      subtitle,
      body: sparkline ? 'Últimas lecturas' : 'Último valor',
      units,
      value: valueUser,
      trend: last.dir || null,
      sparkline, // null -> el adaptador cae a modo texto
    });

    state.hudVisible = true;
    state.lastHudRenderAt = now();

    // Auto-ocultar tras display_duration_ms si está en posición UP y luego DOWN
    const displayMs = msSetting('display_duration_ms');
    setTimeout(async () => {
      if (state.hudVisible && state.lastHeadPos === 'down') {
        await adapter.hideHUD();
        state.hudVisible = false;
      }
    }, displayMs + 50);

  } catch (err) {
    dlog('renderHUD error', err);
    await adapter.showToast(`HUD error: ${err.message}`, 3000);
  }
}

///////////////////////////////
// Head position handling    //
///////////////////////////////
async function onHeadPosition(pos) {
  // Debounce para evitar repetición por micro-movimientos
  if (state.headDebounceTimer) clearTimeout(state.headDebounceTimer);
  state.headDebounceTimer = setTimeout(async () => {
    if (pos === state.lastHeadPos) return; // sin cambio real
    state.lastHeadPos = pos;
    dlog('Head position:', pos);

    const hudEnabled = !!(state.settings.enable_head_up_display ?? SETTINGS.enable_head_up_display.default);
    if (!hudEnabled) return;

    if (pos === 'up') {
      await renderHUD('head_up');
    } else if (pos === 'down') {
      await adapter.hideHUD();
      state.hudVisible = false;
    }
  }, HEAD_EVENT_DEBOUNCE_MS);
}

////////////////////
// Watchdog        //
////////////////////
async function watchdogTick() {
  try {
    // Si la app muestra "Iniciando" demasiado tiempo, forzar un refresh suave
    const sinceRender = now() - (state.lastHudRenderAt || 0);
    const sinceFetch = now() - (state.lastDataFetchAt || 0);

    // 1) Si el HUD está visible pero llevamos >alert_duration_ms sin refrescar, re-render
    const alertMs = msSetting('alert_duration_ms');
    if (state.hudVisible && sinceRender > alertMs) {
      dlog('Watchdog: re-render HUD (timeout render)');
      await renderHUD('watchdog_refresh');
      return;
    }

    // 2) Si hace mucho que no fetcheamos, fuerza una lectura para evitar quedar con datos viejos
    if (sinceFetch > 2 * alertMs) {
      dlog('Watchdog: refresh data');
      await getGlucoseSeries();
    }

    // 3) Si el HUD debía ocultarse y cabeza abajo, asegura hideHUD()
    if (!state.hudVisible && state.lastHeadPos === 'down') {
      await adapter.hideHUD();
    }
  } catch (err) {
    dlog('Watchdog error', err);
  }
}

////////////////////
// Settings live   //
////////////////////
async function loadSettings() {
  const loaded = {};
  for (const k of Object.keys(SETTINGS)) {
    try {
      let v = await adapter.getSetting(k);
      if (v == null) v = SETTINGS[k].default;
      if (SETTINGS[k].type === 'number') {
        v = clamp(Number(v), SETTINGS[k].min, SETTINGS[k].max);
      }
      loaded[k] = v;
    } catch {
      loaded[k] = SETTINGS[k].default;
    }
  }
  state.settings = loaded;
  dlog('Settings loaded:', loaded);
}

function subscribeSettingsChanges() {
  adapter.onSettingsChange(async (changed) => {
    dlog('Settings changed:', changed);
    // Mezcla cambios y aplica límites
    for (const [k, v] of Object.entries(changed || {})) {
      const def = SETTINGS[k];
      if (!def) continue;
      let val = v;
      if (def.type === 'number') {
        val = clamp(Number(v), def.min, def.max);
      }
      state.settings[k] = val;
    }
    // Refresca HUD si está visible o si el cambio afecta a la manera de renderizar
    if (state.hudVisible || 'enable_sparkline_display' in changed || 'glucose_units' in changed) {
      await renderHUD('settings_changed');
    }
  });
}

////////////////////
// Ciclo de vida   //
////////////////////
async function startApp() {
  if (state.refreshingUI) return;
  state.refreshingUI = true;

  // Mensaje inicial breve (evita quedar atascado)
  await adapter.showText('Iniciando app de Mentra…');

  await loadSettings();
  subscribeSettingsChanges();

  // Suscribirse a eventos de cabeza
  adapter.onHeadPosition(onHeadPosition);

  // Primer render si ya está la cabeza arriba (por si el evento se perdió)
  if (state.lastHeadPos === 'up') {
    await renderHUD('startup_head_up');
  } else {
    // Pre-carga datos para que el primer UP sea instantáneo
    try { await getGlucoseSeries(); } catch (e) { dlog('Preload data error', e); }
  }

  // Inicia watchdog
  if (state.watchdogTimer) clearInterval(state.watchdogTimer);
  state.watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);

  // Limpia el texto inicial si todo fue bien
  await adapter.clearText();
  state.refreshingUI = false;
}

async function stopApp() {
  if (state.watchdogTimer) clearInterval(state.watchdogTimer);
  await adapter.hideHUD();
}

// Registro de ciclo de vida
///////////////////////////////////////////////
// Adapter Layer – aísla diferencias de SDK  //
///////////////////////////////////////////////
// Adapter Layer – aísla diferencias de SDK  //
///////////////////////////////////////////////
// Sustituye las funciones aquí si tu entorno difiere.
const adapter = {
  // ==== App lifecycle ====
  onStart(cb) {
    if (globalThis.mentra?.app?.onStart) return globalThis.mentra.app.onStart(cb);
    // Fallback inmediato: llama al callback al cargar
    document?.addEventListener?.('DOMContentLoaded', cb);
  },
  onStop(cb) {
    if (globalThis.mentra?.app?.onStop) return globalThis.mentra.app.onStop(cb);
    // No-op en fallback
  },

  // ==== Settings ====
  async getSetting(key) {
    if (globalThis.mentra?.settings?.get) return await globalThis.mentra.settings.get(key);
    return SETTINGS[key]?.default;
  },
  onSettingsChange(handler) {
    if (globalThis.mentra?.settings?.onChange) return globalThis.mentra.settings.onChange(handler);
    // No-op fallback
  },

  // ==== Events ====
  onHeadPosition(handler) {
    if (globalThis.mentra?.events?.onHeadPosition) return globalThis.mentra.events.onHeadPosition(handler);
    // Fallback: solo en entornos con window (no-Node)
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', (e) => {
        const k = (e.key || '').toLowerCase();
        if (k === 'u') handler('up');
        if (k === 'd') handler('down');
      });
    }
  },

  // ==== Display ====
  async displayHUD({ title, subtitle, body, units, value, trend, sparkline }) {
    // Si existe API HUD nativa
    if (globalThis.mentra?.display?.showHUD) {
      return await globalThis.mentra.display.showHUD({ title, subtitle, body, units, value, trend, sparkline });
    }
    // Fallback: renderiza texto (sin sparkline)
    const txt = `${title || ''}\n${subtitle || ''}\n${body || ''}\n${value != null ? `${value} ${units || ''}` : ''}`.trim();
    await this.showText(txt);
  },
  async hideHUD() {
    if (globalThis.mentra?.display?.hideHUD) return await globalThis.mentra.display.hideHUD();
    await this.clearText();
  },
  async showText(text) {
    if (globalThis.mentra?.display?.showTextWall) return await globalThis.mentra.display.showTextWall(text);
    if (typeof document === 'undefined') { console.log('[MentraNS][TEXT]', text); return; }
    const el = ensurePad(); el.textContent = text;
  },
  async clearText() {
    if (globalThis.mentra?.display?.clear) return await globalThis.mentra.display.clear();
    if (typeof document === 'undefined') { return; }
    const el = ensurePad(); el.textContent = '';
  },
  async showToast(text, ms = 2000) {
    if (globalThis.mentra?.display?.showToast) return await globalThis.mentra.display.showToast(text, ms);
    console.warn('Toast:', text);
  },

  // ==== Network ====
  async fetch(url, options) {
    return await fetch(url, options);
  },
  async getNightscoutBaseUrl() {
    // Intenta setting dedicado; si no, .env u otra clave
    const k = 'nightscout_base_url';
    if (globalThis.mentra?.settings?.get) {
      const v = await globalThis.mentra.settings.get(k);
      if (v) return v;
    }
    // Fallback: window.NS_URL definido por entorno de pruebas
    return globalThis.NS_URL || '';
  },
};

// Helpers DOM fallback (solo en modos web/testing)
function ensurePad() {
  let el = document.getElementById('mentra-pad');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'mentra-pad';
    el.style.cssText = 'position:fixed;left:8px;top:8px;right:8px;bottom:8px;padding:12px;background:#000;color:#0f0;font:14px/1.4 monospace;white-space:pre-wrap;overflow:auto;z-index:99999;border-radius:12px;';
    document.body.appendChild(el);
  }
  return el;
}

// Registro de ciclo de vida (colocado aquí para evitar TDZ)
adapter.onStart(startApp);
adapter.onStop(stopApp);
