"use strict";
/**
 * Nightscout MentraOS v2.13.x — Bitmaps integrados con BitmapView/ClearView
 *
 * Qué hace:
 *  - Carga BMPs (desde ./assets/bitmaps) usando tu bitmaps.js (padding a 576 px).
 *  - Convierte los BMP a HEX (requisito de BitmapView).
 *  - Muestra overlay de arranque 5s si DEBUG_BOOT_BITMAP=low|high|sun|cloud|rain.
 *  - Usa bitmaps para alertas (LOW/HIGH) con duración controlada.
 *  - Limpia la pantalla con ClearView tras overlays/alertas.
 *  - Mantiene tu HUD (texto, TIR, predicción básica, etc.).
 *
 * Notas:
 *  - Los bitmaps deben ser 526x100 (el módulo añade padding a 576 px).
 *  - Tamaño típico 7–10 KB; no uses otros tamaños salvo que sepas lo que haces.
 */

require("dotenv").config();
const { AppServer, ViewType } = require("@mentra/sdk");
const axios = require("axios");
const path = require("path");

/* ---------- BMPs: carga y conversión a HEX ---------- */
const { loadBitmapsFromDir } = require("./bitmaps");
const BITMAPS_DIR = path.join(process.cwd(), "assets", "bitmaps");

// Aliases que usábamos cuando “sol” y “low” funcionaban
const BOOT_ALIAS = {
  low:   "alert-low-526x100",
  high:  "alert-high-526x100",
  sun:   "weather-sun-526x100",
  cloud: "weather-cloud-526x100",
  rain:  "weather-rain-526x100",
};

const DEBUG_BOOT_BITMAP = (process.env.DEBUG_BOOT_BITMAP || "")
  .toLowerCase()
  .trim(); // 'low'|'high'|'sun'|'cloud'|'rain'

/** Carga buffers BMP normalizados (padding a 576) y devuelve también mapa HEX */
const BITMAPS_BUF = loadBitmapsFromDir(BITMAPS_DIR);
const BITMAPS_HEX = Object.fromEntries(
  Object.entries(BITMAPS_BUF).map(([k, buf]) => [k, buf.toString("hex")])
);

function getBitmapHexByAlias(alias) {
  const key = BOOT_ALIAS[alias];
  if (!key) return null;
  return BITMAPS_HEX[key] || null;
}

/* ---------- Utilidades ---------- */
const UNITS = { MGDL: "mg/dL", MMOL: "mmol/L" };

function toBool(x) {
  return x === true || x === "true" || x === 1 || x === "1";
}
function parseNum(val, fallback) {
  const n =
    typeof val === "object" && val !== null ? parseFloat(val.value) : parseFloat(val);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeMmol(x) {
  const v = parseNum(x, null);
  return v !== null && Number.isFinite(v) ? (v >= 30 ? v / 10 : v) : null;
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/* ---------- App principal ---------- */
const PACKAGE_NAME =
  process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error("⛔ MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.activeSessions = new Map();
    this._http = new Map();
    this._lastText = new Map();
    this._displayTimers = new Map();
    this._renderToken = new Map();

    // Alertas y estados
    this.alertHistory = new Map();
    this.alertLatch = new Map(); // 'low' | 'high' | null

    // TIR por día
    this.dailyTirState = new Map();
    this.dayWatchTimers = new Map();

    // Cache de lectura válida
    this.lastGoodEntry = new Map();

    // Head-up throttle
    this.headUpLastShown = new Map();
  }

  /* ======= Helpers generales ======= */
  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  _scheduleHide(sessionId, ms) {
    if (this._displayTimers.has(sessionId))
      clearTimeout(this._displayTimers.get(sessionId));
    const t = setTimeout(() => {
      const sd = this.activeSessions.get(sessionId);
      if (sd) this.clearDisplay(sd.session);
    }, ms);
    this._displayTimers.set(sessionId, t);
  }
  clearDisplay(session) {
    try {
      session.layouts.clearView(); // Limpia todo (MAIN por defecto)
      session.layouts.clearView({ view: ViewType.DASHBOARD });
      // También vaciamos el texto cacheado:
      this._lastText.delete(session.sessionId);
    } catch {}
  }

  /* ======= Cliente HTTP Nightscout ======= */
  _ensureHttp(sessionId, settings) {
    let cli = this._http.get(sessionId);
    const baseRaw = (settings.nightscoutUrl || "").trim();
    if (!baseRaw) return null;
    const base = baseRaw.startsWith("http") ? baseRaw : "https://" + baseRaw;
    const baseURL = base.replace(/\/$/, "");
    const tokenParam = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
    if (!cli || cli.defaults.baseURL !== baseURL) {
      cli = axios.create({
        baseURL,
        headers: { "User-Agent": "MentraOS-Nightscout/2.13.x" },
        timeout: 10000,
        params: tokenParam,
      });
      this._http.set(sessionId, cli);
    }
    return cli;
  }

  /* ======= Settings ======= */
  validateNum(val, min, max, fallback) {
    const v = parseNum(val, fallback);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  }

  async getUserSettings(session) {
    try {
      const keys = [
        "nightscout_url",
        "nightscout_token",
        "update_interval",
        "low_alert_mg",
        "high_alert_mg",
        "low_alert_mmol",
        "high_alert_mmol",
        "alerts_enabled",
        "language",
        "timezone",
        "units",
        "enable_head_up_display",
        "display_duration_s",
        "alert_duration_s",
        "alert_cooldown_min",
        "show_tir_bar",
        "enable_advanced_mode",
        // histeresis
        "alert_hysteresis_mg",
        "alert_hysteresis_mmol",
        // legacy tolerados
        "prediction_horizon_min",
        "prediction_horizon_mins",
        "debug_force_alert",
      ];
      const vals = await Promise.all(keys.map((k) => session.settings.get(k)));
      const kv = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));

      const uiMin = parseInt(kv.update_interval, 10);
      const updateInterval = Number.isFinite(uiMin) ? uiMin : 5;

      const display_duration_ms = Number.isFinite(parseNum(kv.display_duration_s, NaN))
        ? Math.min(15, Math.max(1, parseNum(kv.display_duration_s))) * 1000
        : 5000;

      const alert_duration_ms = Number.isFinite(parseNum(kv.alert_duration_s, NaN))
        ? Math.min(60, Math.max(2, parseNum(kv.alert_duration_s))) * 1000
        : 15000;

      const alert_cooldown_ms = Number.isFinite(parseNum(kv.alert_cooldown_min, NaN))
        ? Math.min(60, Math.max(1, parseNum(kv.alert_cooldown_min))) * 60 * 1000
        : 600000;

      return {
        nightscoutUrl: String(kv.nightscout_url || "").trim(),
        nightscoutToken: String(kv.nightscout_token || "").trim(),
        updateInterval,
        low_alert_mg: this.validateNum(kv.low_alert_mg, 50, 120, 70),
        high_alert_mg: this.validateNum(kv.high_alert_mg, 180, 400, 250),
        low_alert_mmol: normalizeMmol(kv.low_alert_mmol) ?? 3.9,
        high_alert_mmol: normalizeMmol(kv.high_alert_mmol) ?? 13.9,
        alertsEnabled: toBool(kv.alerts_enabled),
        language: kv.language || "en",
        timezone: kv.timezone || null,
        units: kv.units || UNITS.MGDL,
        enable_head_up_display: toBool(kv.enable_head_up_display),
        display_duration_ms,
        alert_duration_ms,
        alert_cooldown_ms,
        show_tir_bar: toBool(kv.show_tir_bar) || kv.show_tir_bar == null,
        enable_advanced_mode:
          toBool(kv.enable_advanced_mode),
        alert_hysteresis_mg: this.validateNum(kv.alert_hysteresis_mg, 0, 50, 5),
        alert_hysteresis_mmol: normalizeMmol(kv.alert_hysteresis_mmol) ?? 0.3,
        prediction_horizon_min: [15, 30, 60].includes(
          Number(kv.prediction_horizon_min || kv.prediction_horizon_mins)
        )
          ? Number(kv.prediction_horizon_min || kv.prediction_horizon_mins)
          : 30,
        debug_force_alert:
          typeof kv.debug_force_alert === "string" ? kv.debug_force_alert : null,
      };
    } catch (e) {
      console.error("Error leyendo settings:", e);
      return {
        nightscoutUrl: "",
        nightscoutToken: "",
        updateInterval: 5,
        low_alert_mg: 70,
        high_alert_mg: 250,
        low_alert_mmol: 3.9,
        high_alert_mmol: 13.9,
        alertsEnabled: true,
        language: "en",
        timezone: null,
        units: UNITS.MGDL,
        enable_head_up_display: false,
        display_duration_ms: 5000,
        alert_duration_ms: 15000,
        alert_cooldown_ms: 600000,
        show_tir_bar: true,
        enable_advanced_mode: false,
        alert_hysteresis_mg: 5,
        alert_hysteresis_mmol: 0.3,
        prediction_horizon_min: 30,
        debug_force_alert: null,
      };
    }
  }

  getLimitsMg(settings) {
    const lmg = Number(settings.low_alert_mg);
    const hmg = Number(settings.high_alert_mg);
    if (Number.isFinite(lmg) && Number.isFinite(hmg)) return { low: lmg, high: hmg };
    // fallback mmol
    const lowM = Number(settings.low_alert_mmol ?? 3.9);
    const highM = Number(settings.high_alert_mmol ?? 13.9);
    return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
  }
  getHysteresisMg(settings) {
    const mg = Number(settings.alert_hysteresis_mg);
    if (Number.isFinite(mg)) return mg;
    const mmol = Number(settings.alert_hysteresis_mmol);
    return Number.isFinite(mmol) ? Math.round(mmol * 18) : 5;
  }

  convertToDisplay(mgdl, unit) {
    return unit === UNITS.MMOL ? (mgdl / 18).toFixed(1) : Math.round(mgdl);
  }

  trendArrow(dir) {
    const map = {
      DoubleUp: "↑↑",
      SingleUp: "↑",
      FortyFiveUp: "↗",
      Flat: "→",
      FortyFiveDown: "↘",
      SingleDown: "↓",
      DoubleDown: "↓↓",
      NONE: "-",
      "NOT COMPUTABLE": "?",
    };
    return map[dir] || "?";
  }

  async getGlucoseData(settings, sessionId = "default") {
    const http = this._ensureHttp(sessionId, settings);
    if (!http) throw new Error("URL no configurada");

    const endpoints = [
      "/api/v1/entries/sgv.json?count=1",
      "/api/v1/entries.json?count=1",
      "/api/v1/entries/current.json",
    ];
    for (const ep of endpoints) {
      try {
        const { data } = await http.get(ep);
        const r = Array.isArray(data) ? data[0] : data;
        const sgv = Number(r?.sgv ?? r?.glucose);
        if (!Number.isFinite(sgv)) continue;
        const d = r?.date || r?.dateString || r?.sysTime;
        const ts = typeof d === "string" ? Date.parse(d) : Number(d);
        return { sgv, date: ts, direction: r?.direction || r?.trend || "NONE" };
      } catch (_) {}
    }
    throw new Error("Sin datos");
  }

  getLocalDayStr(ts, tz = "UTC") {
    return new Date(ts).toLocaleDateString("es-ES", { timeZone: tz });
  }

  updateTIR(sessionId, mgdl, ts, settings) {
    const tz = settings.timezone || "Europe/Madrid";
    const dayStr = this.getLocalDayStr(ts, tz);
    let st = this.dailyTirState.get(sessionId);
    const lim = this.getLimitsMg(settings);
    if (!st || st.dayStr !== dayStr) st = { dayStr, total: 0, inRange: 0 };
    if (Number.isFinite(mgdl)) {
      st.total += 1;
      if (mgdl >= lim.low && mgdl <= lim.high) st.inRange += 1;
    }
    this.dailyTirState.set(sessionId, st);
    return st.total ? Math.round((st.inRange / st.total) * 100) : null;
  }

  showText(session, sessionId, text, { view = ViewType.MAIN, durationMs = 5000 } = {}) {
    try {
      const clean = String(text || "").replace(/\r/g, "");
      if (this._lastText.get(sessionId) === clean) return;
      this._lastText.set(sessionId, clean);
      session.layouts.showTextWall(clean, { view, durationMs });
    } catch {}
  }

  /* ======= Bitmaps con BitmapView ======= */
  async showBitmapHex(session, hex, { view = ViewType.DASHBOARD, durationMs = 5000 } = {}) {
    try {
      if (!hex || typeof hex !== "string" || !hex.startsWith("424d")) {
        // Fallback suave si no es hex BMP válido
        session.layouts.showTextWall("(bitmap inválido)", { view, durationMs });
        return;
      }
      session.layouts.showBitmapView(hex, { view, durationMs });
    } catch (e) {
      // Fallback final
      session.layouts.showTextWall("(bitmap error)", { view, durationMs });
    }
  }

  /* ======= Alertas (con BitmapView y latch + histeresis) ======= */
  async maybeAlert(session, sessionId, reading, settings) {
    if (!settings.alertsEnabled) return;
    const lim = this.getLimitsMg(settings);
    const hys = this.getHysteresisMg(settings);
    const mg = reading.sgv;

    // Rearme de latch
    const latch = this.alertLatch.get(sessionId) || null;
    if (latch === "low" && mg >= lim.low + hys) this.alertLatch.set(sessionId, null);
    if (latch === "high" && mg <= lim.high - hys) this.alertLatch.set(sessionId, null);

    // Si sigue latcheado, no volvemos a alertar
    if (this.alertLatch.get(sessionId)) return;

    // Cooldown
    const last = this.alertHistory.get(sessionId);
    const cooldown = settings.alert_cooldown_ms || 600000;
    if (last && Date.now() - last < cooldown) return;

    const forced = (settings.debug_force_alert || "").toLowerCase();
    let kind = null;
    if (mg <= lim.low || forced === "low") kind = "low";
    else if (mg >= lim.high || forced === "high") kind = "high";

    if (!kind) return;

    // Latch y registro
    this.alertLatch.set(sessionId, kind);
    this.alertHistory.set(sessionId, Date.now());

    // Mostrar bitmap de alerta
    const hex = getBitmapHexByAlias(kind);
    const unit = settings.units || UNITS.MGDL;
    const msg =
      (settings.language || "en") === "es"
        ? `¡GLUCOSA ${kind === "low" ? "BAJA" : "ALTA"}!\n${this.convertToDisplay(
            mg,
            unit
          )} ${unit}`
        : `GLUCOSE ${kind.toUpperCase()}!\n${this.convertToDisplay(mg, unit)} ${unit}`;

    if (hex) {
      await this.showBitmapHex(session, hex, {
        view: ViewType.DASHBOARD,
        durationMs: settings.alert_duration_ms || 15000,
      });
      // Limpieza explícita
      this.clearDisplay(session);
    } else {
      // Fallback a texto (si faltara el BMP)
      this.showText(session, sessionId, `[!] ${msg}`, {
        view: ViewType.DASHBOARD,
        durationMs: settings.alert_duration_ms || 15000,
      });
      this.clearDisplay(session);
    }
  }

  /* ======= Formateo HUD ======= */
  formatBase(reading, settings) {
    const v = this.convertToDisplay(reading.sgv, settings.units || UNITS.MGDL);
    const trend = this.trendArrow(reading.direction);
    const ts = new Date(reading.date);
    const timeStr = ts.toLocaleTimeString(
      (settings.language || "en") === "es" ? "es-ES" : "en-US",
      { hour: "2-digit", minute: "2-digit", hour12: false }
    );
    return `${v} ${settings.units || UNITS.MGDL} ${trend}\n${timeStr}`;
  }

  /* ======= Ciclo de vida ======= */
  async onSession(session, sessionId, userId) {
    session.logger?.info?.("Session started", { userId, sessionId });

    let settings = await this.getUserSettings(session);
    if (!settings.nightscoutUrl) {
      const msg =
        (settings.language || "en") === "es"
          ? "Configura URL y token\nde Nightscout en ajustes"
          : "Please configure Nightscout\nURL and token in settings";
      this.showText(session, sessionId, msg, { view: ViewType.MAIN, durationMs: 5000 });
      return;
    }

    this.activeSessions.set(sessionId, { session, userId, settings, updateInterval: null });

    // Overlay de arranque si se define DEBUG_BOOT_BITMAP
    if (DEBUG_BOOT_BITMAP) {
      const bootHex = getBitmapHexByAlias(DEBUG_BOOT_BITMAP);
      if (bootHex) {
        console.log(
          `[debug] DEBUG_BOOT_BITMAP=${DEBUG_BOOT_BITMAP} → mostrando 5s en DASHBOARD`
        );
        await this.showBitmapHex(session, bootHex, {
          view: ViewType.DASHBOARD,
          durationMs: 5000,
        });
        this.clearDisplay(session);
      } else {
        console.warn(
          `[debug] DEBUG_BOOT_BITMAP="${DEBUG_BOOT_BITMAP}" no encontrado en assets/bitmaps`
        );
      }
    }

    // Sembrar TIR del día (para porcentajes más reales)
    try {
      const tz = settings.timezone || "Europe/Madrid";
      const http = this._ensureHttp(sessionId, settings);
      const { data } = await http.get(`/api/v1/entries/sgv.json?count=400`);
      const arr = Array.isArray(data) ? data : data ? [data] : [];
      const todayStr = new Date().toLocaleDateString("es-ES", { timeZone: tz });
      let total = 0,
        inRange = 0;
      const lim = this.getLimitsMg(settings);
      for (const r of arr) {
        const mgdl = Number(r.sgv ?? r.glucose);
        const d = r.date || r.dateString || r.sysTime;
        const ts = typeof d === "string" ? Date.parse(d) : Number(d);
        if (!Number.isFinite(mgdl) || !ts) continue;
        const day = new Date(ts).toLocaleDateString("es-ES", { timeZone: tz });
        if (day !== todayStr) continue;
        total++;
        if (mgdl >= lim.low && mgdl <= lim.high) inRange++;
      }
      this.dailyTirState.set(sessionId, {
        dayStr: todayStr,
        total,
        inRange,
      });
    } catch {}

    // Primer render
    await this.showOnce(session, sessionId, settings);

    // Loop de operación normal (polling Nightscout + alertas)
    const iv = setInterval(async () => {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return clearInterval(iv);
      try {
        const s = sd.settings || (await this.getUserSettings(session));
        const reading = await this.getGlucoseData(s, sessionId);
        this.lastGoodEntry.set(sessionId, reading);
        this.updateTIR(sessionId, reading.sgv, reading.date, s);
        await this.maybeAlert(session, sessionId, reading, s);
      } catch (e) {
        session.logger?.debug?.("Cycle failed", { msg: e?.message });
      }
    }, (settings.updateInterval || 5) * 60 * 1000);

    const sd = this.activeSessions.get(sessionId);
    if (sd) {
      if (sd.updateInterval) clearInterval(sd.updateInterval);
      sd.updateInterval = iv;
      this.activeSessions.set(sessionId, sd);
    }

    // Eventos
    session.events?.onHeadPosition?.(async (data) => {
      try {
        if (data?.position !== "up") return;
        const sd = this.activeSessions.get(sessionId);
        const s = sd?.settings || (await this.getUserSettings(session));
        if (!s.enable_head_up_display) return;
        const now = Date.now();
        const last = this.headUpLastShown.get(sessionId) || 0;
        if (now - last < 10000) return;
        this.headUpLastShown.set(sessionId, now);

        await this.showOnce(session, sessionId, s);
      } catch (e) {
        session.logger?.debug?.("onHeadPosition error", { msg: e?.message });
      }
    });

    session.events?.onDisconnected?.(() => {
      const t = this._displayTimers.get(sessionId);
      if (t) clearTimeout(t);
      this._displayTimers.delete(sessionId);
      const sd2 = this.activeSessions.get(sessionId);
      if (sd2?.updateInterval) clearInterval(sd2.updateInterval);
      this.activeSessions.delete(sessionId);
      this.alertHistory.delete(sessionId);
      this.alertLatch.delete(sessionId);
      this.dailyTirState.delete(sessionId);
      this.lastGoodEntry.delete(sessionId);
      this.headUpLastShown.delete(sessionId);
      this._http.delete(sessionId);
      session.logger?.info?.("Session disconnected");
    });
  }

  async showOnce(session, sessionId, settings) {
    try {
      const reading = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, reading);

      const header = this.formatBase(reading, settings);

      if (!settings.enable_advanced_mode) {
        // HUD simple
        this.showText(session, sessionId, header, {
          view: ViewType.MAIN,
          durationMs: settings.display_duration_ms || 5000,
        });
        this._scheduleHide(sessionId, settings.display_duration_ms || 5000);
        return;
      }

      // HUD avanzado con TIR-bar simple (no animaciones para evitar parpadeo)
      const tirPct = this.updateTIR(sessionId, reading.sgv, reading.date, settings);
      const barSlots = 20;
      const filled = Math.round(clamp01((tirPct || 0) / 100) * barSlots);
      const bar = `¦`.repeat(filled);
      const tirLine =
        (settings.language || "en") === "es"
          ? `TIR hoy: ${tirPct == null ? "n/d" : `${tirPct}%`} ${bar}`
          : `TIR: ${tirPct == null ? "n/a" : `${tirPct}%`} ${bar}`;

      const out = `${header}\n${tirLine}`;
      this.showText(session, sessionId, out, {
        view: ViewType.MAIN,
        durationMs: settings.display_duration_ms || 5000,
      });
      this._scheduleHide(sessionId, settings.display_duration_ms || 5000);
    } catch (e) {
      // Fallback a cache si hay
      const cached = this.lastGoodEntry.get(sessionId);
      if (cached) {
        const header = this.formatBase(cached, settings);
        this.showText(session, sessionId, header, {
          view: ViewType.MAIN,
          durationMs: settings.display_duration_ms || 5000,
        });
        this._scheduleHide(sessionId, settings.display_duration_ms || 5000);
        return;
      }
      const msg =
        (settings.language || "en") === "es"
          ? "Error cargando datos\nRevisa URL y token"
          : "Error loading data\nCheck URL and token";
      this.showText(session, sessionId, msg, { view: ViewType.MAIN, durationMs: 5000 });
      this._scheduleHide(sessionId, 5000);
    }
  }
}

/* ---------- Start server ---------- */
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server
  .start()
  .then(() => {
    console.log("🚀 MentraOS started on port", PORT);
  })
  .catch((err) => {
    console.error("⛔ Error iniciando servidor:", err);
    process.exit(1);
  });

/* ---------- Keep-alive opcional para Render ---------- */
const KEEP_ALIVE_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;
server.app.get("/health", (_, res) =>
  res.json({
    status: "alive",
    ts: new Date().toISOString(),
    pkg: PACKAGE_NAME,
  })
);
setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
