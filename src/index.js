
/**
 * Nightscout MentraOS — v18.stable.pro
 * -------------------------------------------------------
 * Objetivo:
 *  - HUD fiable para G1 (texto + TIR + predicción opcional)
 *  - Animación suave sin "pantallas que se pisan" (token)
 *  - Alertas claras (sin parpadeos), ES/EN + mg/dL/mmol/L
 *  - Predicción en modo "threshold" o "always"
 *  - Compatibilidad Render/Node: sin literales anidados raros
 *  - Inicio robusto (listen/start/run/init)
 *
 * Nota: este archivo evita APIs exóticas del SDK y se limita a:
 *   - app.on('session', ...)
 *   - session.layouts.showTextWall(text)
 *   - session.on('close', ...)
 */

"use strict";

require("dotenv").config();
const axios = require("axios");
const { AppServer } = require("@mentra/sdk");

/* ──────────────────────────────────────────────────────
 * Constantes y helpers
 * ────────────────────────────────────────────────────── */
const UNITS = { MGDL: "mg/dL", MMOL: "mmol/L" };
const DEFAULT_PORT = parseInt(process.env.PORT || "3000", 10);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mgdlToMmol(mg) { return +((mg / 18)).toFixed(1); }
function mmolToMgdl(mmol) { return Math.round(mmol * 18); }

function normUrl(u) {
  if (!u) return "";
  let x = String(u).trim();
  if (!/^https?:\/\//i.test(x)) x = "https://" + x;
  return x.replace(/\/+$/, "");
}

function toBool(x) { return x === true || x === "true" || x === 1 || x === "1"; }
function asNumber(x, def) { const n = Number(x); return Number.isFinite(n) ? n : def; }

/** Entrada mmol que podría venir como 30 (3.0) o 3.0 → mg/dL */
function normalizeThresholdToMgdl(v, units) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (units === "mmol") {
    const mmol = (n >= 30 ? n / 10 : n);
    return mmolToMgdl(mmol);
  }
  return Math.round(n);
}

function clampLines(txt, max=5){
  const lines = String(txt || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (let i=0;i<lines.length && out.length<max;i++){
    if (i===0 || lines[i].trim()!=="") out.push(lines[i]);
  }
  return out.join("\n");
}

/* ──────────────────────────────────────────────────────
 * App + Settings
 * ────────────────────────────────────────────────────── */
const app = new AppServer({
  name: "Nightscout G1 HUD",
  version: "v18.stable.pro",
  settings: {
    nightscout_url:   { type: "text",   default: "",  label: "Nightscout URL (https://...)" },
    nightscout_token: { type: "text",   default: "",  label: "Nightscout Token/API-secret" },
    language:         { type: "select", default: "es",   options: ["es","en"], label: "Language" },
    units:            { type: "select", default: "mgdl", options: ["mgdl","mmol"], label: "Units" },

    // HUD
    enable_advanced_mode: { type: "toggle", default: true,  label: "Advanced HUD" },
    show_tir_bar:         { type: "toggle", default: true,  label: "Show TIR bar" },
    enable_animations:    { type: "toggle", default: true,  label: "Enable animations" },

    // Límites alerta (introducidos en mg/dL o mmol/L según 'units')
    low_alert_mg:  { type: "number", default: 70,  min: 50,  max: 120, label: "Low alert (mg/dL or mmol input*)" },
    high_alert_mg: { type: "number", default: 180, min: 150, max: 300, label: "High alert (mg/dL or mmol input*)" },

    // Predicción
    prediction_horizon_min: { type: "select", default: 30, options: [15,30,60], label: "Prediction horizon (min)" },
    prediction_mode:        { type: "select", default: "threshold", options: ["threshold","always"], label: "Prediction mode" },

    // Duración en pantalla
    display_duration_ms: { type: "number", default: 5000, min: 1000, max: 15000, label: "Display duration (ms)" }
  }
});

/* ──────────────────────────────────────────────────────
 * Estado por sesión
 * ────────────────────────────────────────────────────── */
const SESS = new WeakMap(); // session -> { token, hideTimer, tirPct, lastHeader, lastReading, animEnabled }

function getSess(session) {
  let st = SESS.get(session);
  if (!st) {
    st = { token: 0, hideTimer: null, tirPct: null, lastHeader: "", lastReading: null, animEnabled: true };
    SESS.set(session, st);
  }
  return st;
}

/* ──────────────────────────────────────────────────────
 * Nightscout API
 * ────────────────────────────────────────────────────── */
async function fetchEntries(base, token, count) {
  const params  = token ? { token: token } : {};
  const headers = token ? { "api-secret": token, "User-Agent":"MentraOS-G1/18" } : { "User-Agent":"MentraOS-G1/18" };
  const url = base + "/api/v1/entries.json?count=" + String(count);
  const { data } = await axios.get(url, { params, timeout: 10000, headers });
  return Array.isArray(data) ? data : (data ? [data] : []);
}

async function fetchLatest(base, token) {
  const arr = await fetchEntries(base, token, 2);
  return arr.length ? arr[0] : null;
}

async function fetchPredictionSeries(base, token, horizonMin) {
  // 1) devicestatus.predBGs (series cada 5 min)
  try {
    const params  = token ? { token } : {};
    const headers = token ? { "api-secret": token, "User-Agent":"MentraOS-G1/18" } : { "User-Agent":"MentraOS-G1/18" };
    const url = base + "/api/v1/devicestatus.json?count=8";
    const { data } = await axios.get(url, { params, timeout: 8000, headers });
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    for (let i = 0; i < arr.length; i++) {
      const ds = arr[i];
      if (!ds) continue;
      const p = (ds.predBGs) || (ds.openaps && ds.openaps.suggested && ds.openaps.suggested.predBGs) || (ds.ar2 && ds.ar2.predBGs);
      const series = (p && (p.IOB || p.COB || p.UAM || p.ZT)) || (Array.isArray(p) ? p : null);
      if (series && series.length) {
        const maxIdx = Math.min(series.length - 1, Math.round(horizonMin / 5));
        const out = [];
        for (let j = 0; j <= maxIdx; j++) {
          const v = Number(series[j]);
          if (Number.isFinite(v)) out.push(v);
        }
        if (out.length >= 2) return out;
      }
    }
  } catch (_) {}

  // 2) Fallback lineal con 2 entradas
  try {
    const arr = await fetchEntries(base, token, 4);
    if (arr.length >= 2) {
      const a = arr[0], b = arr[1];
      const mgA = Number(a.sgv ?? a.glucose);
      const mgB = Number(b.sgv ?? b.glucose);
      const tA = new Date(a.dateString || a.date || a.mills || a.sysTime).getTime();
      const tB = new Date(b.dateString || b.date || b.mills || b.sysTime).getTime();
      if ([mgA, mgB, tA, tB].every(Number.isFinite) && tA > tB) {
        const rate = (mgA - mgB) / ((tA - tB) / 60000);
        const len = Math.max(3, Math.round(horizonMin / 5));
        const out = [];
        for (let i = 0; i <= len; i++) {
          const minutes = i * 5;
          const v = mgA + rate * minutes;
          const clamped = Math.max(40, Math.min(400, Math.round(v)));
          out.push(clamped);
        }
        return out;
      }
    }
  } catch (_) {}

  return null;
}

/* ──────────────────────────────────────────────────────
 * Predicción
 * ────────────────────────────────────────────────────── */
function buildPredictionString(series, horizonMin, lowMg, highMg, units, lang, mode) {
  if (!series || !series.length) return null;

  if (mode === "threshold") {
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v <= lowMg) {
        const minutes = i * 5;
        const val = (units === "mmol") ? String(mgdlToMmol(lowMg)) : String(lowMg);
        return (lang === "es") ? ("Baja " + val + " @" + String(minutes) + "m")
                               : ("Low " + val + " @" + String(minutes) + "m");
      }
      if (v >= highMg) {
        const minutes = i * 5;
        const val = (units === "mmol") ? String(mgdlToMmol(highMg)) : String(highMg);
        return (lang === "es") ? ("Alta " + val + " @" + String(minutes) + "m")
                               : ("High " + val + " @" + String(minutes) + "m");
      }
    }
    return null;
  }

  const idx = Math.max(0, Math.min(series.length - 1, Math.round(horizonMin / 5)));
  const mg = series[idx];
  const vStr = (units === "mmol") ? (String(mgdlToMmol(mg)) + " " + UNITS.MMOL)
                                  : (String(Math.round(mg)) + " " + UNITS.MGDL);
  return vStr + " @" + String(horizonMin) + "m";
}

/* ──────────────────────────────────────────────────────
 * TIR (modelo simple acumulativo)
 * ────────────────────────────────────────────────────── */
function updateTIR(state, mgdl, lowMg, highMg) {
  if (!Number.isFinite(mgdl)) return state.tirPct;
  if (state.tirPct == null) state.tirPct = 100;
  const inRange = (mgdl >= lowMg && mgdl <= highMg) ? 1 : 0;
  state.tirPct = Math.max(0, Math.min(100, Math.round(state.tirPct * 0.9 + (inRange * 100) * 0.1)));
  return state.tirPct;
}

/* ──────────────────────────────────────────────────────
 * Render helpers (5 líneas máx)
 * ────────────────────────────────────────────────────── */
function headerTwoLines(reading, units, lang) {
  const unitStr = (units === "mmol") ? UNITS.MMOL : UNITS.MGDL;
  const val = (units === "mmol") ? mgdlToMmol(reading.sgv) : Math.round(reading.sgv);
  const arrow = reading.direction || "→";
  const when = new Date(reading.dateString || reading.date || reading.mills || reading.sysTime || Date.now());
  const timeStr = when.toLocaleTimeString((lang === "es") ? "es-ES" : "en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  return String(val) + " " + unitStr + " " + arrow + "\n" + timeStr;
}

function injectPrediction(baseText, predStr) {
  if (!predStr) return baseText;
  const parts = String(baseText).split("\n");
  const l1 = parts[0] || "";
  const l2 = parts[1] || "";
  const rest = parts.slice(2);
  const line2 = l2 ? (l2 + " · " + predStr) : predStr;
  const out = [l1, line2].concat(rest);
  return out.join("\n");
}

function alertBlock(lang, kind, valueStr) {
  if (lang === "es") {
    return (kind === "low")
      ? ["[!] ¡GLUCOSA BAJA!", valueStr]
      : ["[!] ¡GLUCOSA ALTA!", valueStr];
  }
  return (kind === "low")
    ? ["[!] LOW GLUCOSE!", valueStr]
    : ["[!] HIGH GLUCOSE!", valueStr];
}

/* ──────────────────────────────────────────────────────
 * Animación TIR (800 ms, 24 frames) con token
 * ────────────────────────────────────────────────────── */
async function animateTIR(session, state, header, targetPct, lang) {
  if (!state.animEnabled) return;
  const token = ++state.token;
  const slots = 16;
  const frames = 24;
  const totalMs = 800;
  const perFrame = Math.max(10, Math.round(totalMs / frames));

  // Usamos ASCII puro para máxima compatibilidad en G1
  function bar(fill){
    const f = Math.max(0, Math.min(slots, fill));
    const filled = Array(f+1).join("|");
    const empty  = Array(Math.max(0, slots-f)+1).join(".");
    return "[" + filled + empty + "]";
  }

  const base = String(header || "");
  const baseLines = base.split("\n").slice(0, 2);

  for (let f = 0; f <= frames; f++) {
    if (state.token !== token) return; // cancelación
    const eased = clamp01(f / frames);
    const fill = Math.floor(clamp01((targetPct / 100) * eased) * slots);
    const line = (lang === "es" ? "TIR hoy: " : "TIR: ") + String(targetPct) + "%";
    const outLines = baseLines.concat([line, bar(fill)]);
    try { session.layouts.showTextWall(clampLines(outLines.join("\n"))); } catch (_) {}
    await delay(perFrame);
  }
}

/* ──────────────────────────────────────────────────────
 * TICK principal por sesión
 * ────────────────────────────────────────────────────── */
async function runTick(session) {
  const st = getSess(session);

  let cfg = {};
  try { cfg = await app.getSettings(); } catch (_) {}

  const lang  = (cfg.language === "en") ? "en" : "es";
  const units = (String(cfg.units).toLowerCase() === "mmol") ? "mmol" : "mgdl";

  const base = normUrl(cfg.nightscout_url || process.env.NIGHTSCOUT_URL || "");
  const token = (cfg.nightscout_token || process.env.NIGHTSCOUT_TOKEN || "").trim();

  if (!base) {
    const msg = (lang === "es") ? "Configura Nightscout\nURL y token" : "Set Nightscout\nURL and token";
    try { session.layouts.showTextWall(msg); } catch (_) {}
    return;
  }

  // Umbrales (en mg/dL)
  let lowMg  = normalizeThresholdToMgdl(cfg.low_alert_mg,  units);
  let highMg = normalizeThresholdToMgdl(cfg.high_alert_mg, units);
  if (!Number.isFinite(lowMg))  lowMg = 70;
  if (!Number.isFinite(highMg)) highMg = 180;

  // Lectura actual (con fallback a último bueno)
  let reading = null;
  try { reading = await fetchLatest(base, token); } catch (_) {}
  if (!reading && st.lastReading) {
    reading = st.lastReading;
  }
  if (!reading) {
    const msg = (lang === "es") ? "Sin datos" : "No data";
    try { session.layouts.showTextWall(msg); } catch (_) {}
    return;
  }
  st.lastReading = reading;

  // Header (2 líneas)
  let header = headerTwoLines(reading, units, lang);

  // Predicción
  const horizon = asNumber(cfg.prediction_horizon_min, 30);
  const mode    = (cfg.prediction_mode === "always") ? "always" : "threshold";
  let predStr = null;
  try {
    const series = await fetchPredictionSeries(base, token, horizon);
    predStr = buildPredictionString(series, horizon, lowMg, highMg, units, lang, mode);
  } catch (_) { predStr = null; }
  header = injectPrediction(header, predStr);
  st.lastHeader = header;

  // Pintar header ya
  try { session.layouts.showTextWall(clampLines(header)); } catch (_) {}

  // TIR y (posible) animación
  const currTir = updateTIR(st, Number(reading.sgv), lowMg, highMg);
  st.animEnabled = toBool(cfg.enable_advanced_mode) && toBool(cfg.show_tir_bar) && toBool(cfg.enable_animations);
  if (toBool(cfg.enable_advanced_mode) && toBool(cfg.show_tir_bar) && currTir != null) {
    await animateTIR(session, st, header, currTir, lang);
  }

  // Alertas (sustituyen la parte inferior si saltan)
  const valMg = Number(reading.sgv);
  let alert = null;
  if (Number.isFinite(valMg) && valMg < lowMg) {
    const vStr = (units === "mmol") ? (String(mgdlToMmol(valMg)) + " " + UNITS.MMOL) : (String(Math.round(valMg)) + " " + UNITS.MGDL);
    alert = alertBlock(lang, "low", vStr);
  } else if (Number.isFinite(valMg) && valMg > highMg) {
    const vStr = (units === "mmol") ? (String(mgdlToMmol(valMg)) + " " + UNITS.MMOL) : (String(Math.round(valMg)) + " " + UNITS.MGDL);
    alert = alertBlock(lang, "high", vStr);
  }
  if (alert) {
    const baseLines = String(header).split("\n").slice(0, 2); // 2 primeras
    const out = clampLines(baseLines.concat(alert).join("\n"));
    try { session.layouts.showTextWall(out); } catch (_) {}
  }

  // Ocultar tras N ms (cancelable por token)
  const hideMs = Math.max(1000, Math.min(15000, asNumber(cfg.display_duration_ms, 5000)));
  if (st.hideTimer) { try { clearTimeout(st.hideTimer); } catch (_) {} }
  const myToken = ++st.token;
  st.hideTimer = setTimeout(function () {
    if (st.token === myToken) {
      try { session.layouts.showTextWall(""); } catch (_) {}
    }
  }, hideMs);
}

/* ──────────────────────────────────────────────────────
 * Lifecycle de sesión
 * ────────────────────────────────────────────────────── */
app.on("session", function (session) {
  // Tick inmediato
  runTick(session).catch(function(){});

  // Bucle de actualización (5 minutos)
  const loop = setInterval(function () {
    runTick(session).catch(function(){});
  }, 5 * 60 * 1000);

  // Limpieza
  if (typeof session.on === "function") {
    session.on("close", function () {
      clearInterval(loop);
      const st = SESS.get(session);
      if (st && st.hideTimer) { try { clearTimeout(st.hideTimer); } catch (_) {} }
      SESS.delete(session);
    });
  }
});

/* ──────────────────────────────────────────────────────
 * Inicio robusto (listen/start/run/init)
 * ────────────────────────────────────────────────────── */
(async function start() {
  try {
    if (typeof app.listen === "function")      { await app.listen(DEFAULT_PORT); }
    else if (typeof app.start === "function")  { await app.start(DEFAULT_PORT); }
    else if (typeof app.run === "function")    { await app.run(DEFAULT_PORT); }
    else if (typeof app.init === "function")   { await app.init(DEFAULT_PORT); }
    else { console.log("SDK lifecycle handled by host."); }
    console.log("Nightscout G1 HUD ready on :", DEFAULT_PORT);
  } catch (err) {
    console.error("Fatal boot error", err);
    process.exit(1);
  }
})();
