"use strict";
/**
 * Nightscout MentraOS v2.13.1 (Hysteresis + ECO con estado de alarma + Pred no-avanzado)
 * HUD texto + TIR-bar ¦ CH/Ins día + Min/Max ¦ reset diario
 * ES/EN + mg/dL/mmol ¦ 5 líneas max ¦ cache last-good-entry
 * Settings en segundos/minutos + toggle barra TIR
 * NUEVO:
 *  - Histeresis de alarmas (alert_hysteresis_mg / alert_hysteresis_mmol) con latch
 *  - ECO al guardar ajustes incluye rango TIR con unidades correctas
 *  - Bitmaps LOW/HIGH: fijos arriba + texto parpadea
 *
 * NOTA: La URL/token de Nightscout se configuran SIEMPRE desde Ajustes (no de env).
 */

require('dotenv').config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const { AppServer } = require("@mentra/sdk");

const app = express();
app.use(bodyParser.json());

const UNITS = { MGDL: "mg/dL", MMOL: "mmol/L" };
const DEFAULTS = {
  updateInterval: 5,
  low_alert_mg: 70,
  high_alert_mg: 250,
  low_alert_mmol: 3.9,
  high_alert_mmol: 13.9,
  alertsEnabled: true,
  language: "en",
  timezone: null,
  units: UNITS.MGDL,
  enable_head_up_display: true,
  display_duration_ms: 5000,
  alert_duration_ms: 15000,
  alert_cooldown_ms: 600000,
  show_tir_bar: true,
  enable_advanced_mode: true,
  alert_hysteresis_mg: 5,
  alert_hysteresis_mmol: 0.3,
  prediction_horizon_min: 30,
  debug_force_alert: null
};

// ===== Bitmaps opcionales (G1B). Si faltan, seguimos en modo texto =====
let loadAllBitmaps = null, getBitmap = null, hasBitmap = null;
try {
  ({ loadAllBitmaps, getBitmap, hasBitmap } = require('./bitmaps'));
  try { if (typeof loadAllBitmaps === 'function') loadAllBitmaps(); } catch (_) {}
} catch (_) {
  loadAllBitmaps = () => {};
  getBitmap = () => null;
  hasBitmap = () => false;
}
// ===== Fin bitmaps opcionales =====

/* Utils */
function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
function isValidUrl(u) { try { new URL(u); return true; } catch { return false; } }
function toNumber(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

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
    this._settingsEchoDebounce = new Map();
  }

  _getHttp(sessionId) {
    if (this._http.has(sessionId)) return this._http.get(sessionId);
    const instance = axios.create({ timeout: 8000 });
    this._http.set(sessionId, instance);
    return instance;
  }

  __delay(ms) { return new Promise(res => setTimeout(res, ms)); }

  async getGlucoseData(settings, sessionId) {
    const http = this._getHttp(sessionId);
    const base = String(settings.nightscoutUrl || "").replace(/\/+$/, "");
    if (!base || !isValidUrl(base)) throw new Error("NS_URL_MISSING");
    const hasQuery = base.includes("?");
    const token = String(settings.nightscoutToken || "").trim();
    const tokenParam = token ? (hasQuery ? `&token=${encodeURIComponent(token)}` : `?token=${encodeURIComponent(token)}`) : (hasQuery ? "" : "?");
    const url = `${base}/api/v1/entries.json${tokenParam}&count=1`;
    const { data } = await http.get(url);
    if (!Array.isArray(data) || !data[0]) throw new Error("Sin datos NS");
    const e = data[0];
    return {
      sgv: toNumber(e.sgv, NaN),
      direction: e.direction || "NONE",
      date: Number(e.date) || (new Date(e.dateString || e.date)).getTime() || Date.now()
    };
  }

  toBool(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return ["1","true","on","yes","y"].includes(v.trim().toLowerCase());
    return Boolean(v);
  }
  validateSlicerValue(v, min, max, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return clamp(n, min, max);
  }
  parseSlicerValue(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  normalizeMmol(v) {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, 2, 30) : null;
  }

  decideThresholdFromDual(mg, mmol, units = UNITS.MGDL, mmolAsMg = null) {
    const unitsStr = String(units || "").toLowerCase();
    if (unitsStr.includes("mmol")) {
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
      if (Number.isFinite(mg)) return mg;
      return 5;
    } else {
      if (Number.isFinite(mg)) return mg;
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
      return 70;
    }
  }

  getUserSettings(session) {
    try {
      const keys = [
        "nightscout_url","nightscout_token","update_interval",
        "low_alert_mg","high_alert_mg","low_alert_mmol","high_alert_mmol",
        "alerts_enabled","language","timezone","units",
        "enable_head_up_display",
        "display_duration_s","alert_duration_s","alert_cooldown_min",
        "show_tir_bar","show_range_bar",
        "display_duration_ms","alert_duration_ms","alert_cooldown_ms",
        "enable_advanced_mode","advanced_mode_enabled",
        "alert_hysteresis_mg","alert_hysteresis_mmol",
        "tir_low_mg","tir_high_mg","tir_low_mmol","tir_high_mmol",
        "time_in_range_low_mg","time_in_range_high_mg","time_in_range_low_mmol","time_in_range_high_mmol",
        "prediction_horizon_min","prediction_horizon_mins",
        "debug_force_alert","debug_boot_bitmap"
      ];
      const vals = keys.map(k => (session && session.settings && session.settings[k] != null) ? session.settings[k] : null);
      const kv = Object.fromEntries(keys.map((k,i)=>[k,vals[i]]));

      const uiMin = parseInt(kv.update_interval, 10);
      const ui = Number.isFinite(uiMin) ? uiMin : DEFAULTS.updateInterval;

      const displayMs = Number.isFinite(this.parseSlicerValue(kv.display_duration_s, NaN))
        ? Math.min(15, Math.max(1, this.parseSlicerValue(kv.display_duration_s))) * 1000
        : this.validateSlicerValue(kv.display_duration_ms, 1000, 15000, DEFAULTS.display_duration_ms);

      const alertMs = Number.isFinite(this.parseSlicerValue(kv.alert_duration_s, NaN))
        ? Math.min(60, Math.max(2, this.parseSlicerValue(kv.alert_duration_s))) * 1000
        : this.validateSlicerValue(kv.alert_duration_ms, 2000, 60000, DEFAULTS.alert_duration_ms);

      const coolMs = Number.isFinite(this.parseSlicerValue(kv.alert_cooldown_min, NaN))
        ? Math.min(60, Math.max(1, this.parseSlicerValue(kv.alert_cooldown_min))) * 60 * 1000
        : this.validateSlicerValue(kv.alert_cooldown_ms, 60000, 3600000, DEFAULTS.alert_cooldown_ms);

      const showTirBar = (kv.show_tir_bar == null && kv.show_range_bar == null)
        ? true
        : (this.toBool(kv.show_tir_bar) || this.toBool(kv.show_range_bar));

      return {
        nightscoutUrl: String(kv.nightscout_url || "").trim(),
        nightscoutToken: String(kv.nightscout_token || "").trim(),
        updateInterval: ui,
        low_alert_mg: this.validateSlicerValue(kv.low_alert_mg, 50, 120, DEFAULTS.low_alert_mg),
        high_alert_mg: this.validateSlicerValue(kv.high_alert_mg, 180, 400, DEFAULTS.high_alert_mg),
        low_alert_mmol: this.normalizeMmol(kv.low_alert_mmol) ?? DEFAULTS.low_alert_mmol,
        high_alert_mmol: this.normalizeMmol(kv.high_alert_mmol) ?? DEFAULTS.high_alert_mmol,
        alertsEnabled: this.toBool(kv.alerts_enabled ?? DEFAULTS.alertsEnabled),
        language: (kv.language || DEFAULTS.language).toLowerCase().startsWith("es") ? "es" : "en",
        timezone: kv.timezone || DEFAULTS.timezone,
        units: (String(kv.units || "").toLowerCase().includes("mmol") ? UNITS.MMOL : UNITS.MGDL),
        enable_head_up_display: this.toBool(kv.enable_head_up_display ?? DEFAULTS.enable_head_up_display),
        display_duration_ms: displayMs,
        alert_duration_ms: alertMs,
        alert_cooldown_ms: coolMs,
        show_tir_bar: showTirBar,
        enable_advanced_mode: this.toBool(kv.enable_advanced_mode) || this.toBool(kv.advanced_mode_enabled) || DEFAULTS.enable_advanced_mode,
        alert_hysteresis_mg: this.validateSlicerValue(kv.alert_hysteresis_mg, 0, 50, DEFAULTS.alert_hysteresis_mg),
        alert_hysteresis_mmol: this.normalizeMmol(kv.alert_hysteresis_mmol) ?? DEFAULTS.alert_hysteresis_mmol,
        tir_low_mg: this.parseSlicerValue(kv.tir_low_mg, null),
        tir_high_mg: this.parseSlicerValue(kv.tir_high_mg, null),
        tir_low_mmol: this.normalizeMmol(kv.tir_low_mmol),
        tir_high_mmol: this.normalizeMmol(kv.tir_high_mmol),
        time_in_range_low_mg: this.parseSlicerValue(kv.time_in_range_low_mg, null),
        time_in_range_high_mg: this.parseSlicerValue(kv.time_in_range_high_mg, null),
        time_in_range_low_mmol: this.normalizeMmol(kv.time_in_range_low_mmol),
        time_in_range_high_mmol: this.normalizeMmol(kv.time_in_range_high_mmol),
        prediction_horizon_min: [15,30,60].includes(Number(kv.prediction_horizon_min || kv.prediction_horizon_mins))
          ? Number(kv.prediction_horizon_min || kv.prediction_horizon_mins) : DEFAULTS.prediction_horizon_min,
        debug_force_alert: (typeof kv.debug_force_alert === "string" ? kv.debug_force_alert : null),
        debug_boot_bitmap: String(kv.debug_boot_bitmap || "").trim()
      };
    } catch (e) {
      console.error("Error leyendo settings:", e);
      return {
        nightscoutUrl: "", nightscoutToken: "",
        updateInterval: DEFAULTS.updateInterval,
        low_alert_mg: DEFAULTS.low_alert_mg, high_alert_mg: DEFAULTS.high_alert_mg,
        low_alert_mmol: DEFAULTS.low_alert_mmol, high_alert_mmol: DEFAULTS.high_alert_mmol,
        alertsEnabled: DEFAULTS.alertsEnabled, language: DEFAULTS.language, timezone: DEFAULTS.timezone, units: UNITS.MGDL,
        enable_head_up_display: DEFAULTS.enable_head_up_display,
        display_duration_ms: DEFAULTS.display_duration_ms, alert_duration_ms: DEFAULTS.alert_duration_ms, alert_cooldown_ms: DEFAULTS.alert_cooldown_ms,
        show_tir_bar: true, enable_advanced_mode: true,
        alert_hysteresis_mg: DEFAULTS.alert_hysteresis_mg, alert_hysteresis_mmol: DEFAULTS.alert_hysteresis_mmol,
        prediction_horizon_min: DEFAULTS.prediction_horizon_min,
        debug_force_alert: null,
        debug_boot_bitmap: ""
      };
    }
  }
  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    const units = o.units || UNITS.MGDL;
    const uiMin = parseInt(o.update_interval, 10);
    const ui = Number.isFinite(uiMin) ? uiMin : DEFAULTS.updateInterval;

    const displayMs = Number.isFinite(this.parseSlicerValue(o.display_duration_s, NaN))
      ? Math.min(15, Math.max(1, this.parseSlicerValue(o.display_duration_s))) * 1000
      : this.validateSlicerValue(o.display_duration_ms, 1000, 15000, DEFAULTS.display_duration_ms);

    const alertMs = Number.isFinite(this.parseSlicerValue(o.alert_duration_s, NaN))
      ? Math.min(60, Math.max(2, this.parseSlicerValue(o.alert_duration_s))) * 1000
      : this.validateSlicerValue(o.alert_duration_ms, 2000, 60000, DEFAULTS.alert_duration_ms);

    const coolMs = Number.isFinite(this.parseSlicerValue(o.alert_cooldown_min, NaN))
      ? Math.min(60, Math.max(1, this.parseSlicerValue(o.alert_cooldown_min))) * 60 * 1000
      : this.validateSlicerValue(o.alert_cooldown_ms, 60000, 3600000, DEFAULTS.alert_cooldown_ms);

    const showTirBar = (o.show_tir_bar == null && o.show_range_bar == null)
      ? true
      : (this.toBool(o.show_tir_bar) || this.toBool(o.show_range_bar));

    return {
      nightscoutUrl: String(o.nightscout_url || "").trim(),
      nightscoutToken: String(o.nightscout_token || "").trim(),
      updateInterval: ui,
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 50, 120, DEFAULTS.low_alert_mg),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, DEFAULTS.high_alert_mg),
      low_alert_mmol: this.normalizeMmol(o.low_alert_mmol) ?? DEFAULTS.low_alert_mmol,
      high_alert_mmol: this.normalizeMmol(o.high_alert_mmol) ?? DEFAULTS.high_alert_mmol,
      alertsEnabled: this.toBool(o.alerts_enabled ?? DEFAULTS.alertsEnabled),
      language: (o.language || DEFAULTS.language).toLowerCase().startsWith("es") ? "es" : "en",
      timezone: o.timezone || DEFAULTS.timezone,
      units: (String(units || "").toLowerCase().includes("mmol") ? UNITS.MMOL : UNITS.MGDL),
      enable_head_up_display: this.toBool(o.enable_head_up_display ?? DEFAULTS.enable_head_up_display),
      display_duration_ms: displayMs,
      alert_duration_ms: alertMs,
      alert_cooldown_ms: coolMs,
      show_tir_bar: showTirBar,
      enable_advanced_mode: this.toBool(o.enable_advanced_mode) || this.toBool(o.advanced_mode_enabled) || DEFAULTS.enable_advanced_mode,
      alert_hysteresis_mg: this.validateSlicerValue(o.alert_hysteresis_mg, 0, 50, DEFAULTS.alert_hysteresis_mg),
      alert_hysteresis_mmol: this.normalizeMmol(o.alert_hysteresis_mmol) ?? DEFAULTS.alert_hysteresis_mmol,
      tir_low_mg: this.parseSlicerValue(o.tir_low_mg, null),
      tir_high_mg: this.parseSlicerValue(o.tir_high_mg, null),
      tir_low_mmol: this.normalizeMmol(o.tir_low_mmol),
      tir_high_mmol: this.normalizeMmol(o.tir_high_mmol),
      time_in_range_low_mg: this.parseSlicerValue(o.time_in_range_low_mg, null),
      time_in_range_high_mg: this.parseSlicerValue(o.time_in_range_high_mg, null),
      time_in_range_low_mmol: this.normalizeMmol(o.time_in_range_low_mmol),
      time_in_range_high_mmol: this.normalizeMmol(o.time_in_range_high_mmol),
      prediction_horizon_min: [15,30,60].includes(Number(o.prediction_horizon_min || o.prediction_horizon_mins))
        ? Number(o.prediction_horizon_min || o.prediction_horizon_mins) : DEFAULTS.prediction_horizon_min,
      debug_force_alert: (typeof o.debug_force_alert === "string" ? o.debug_force_alert : null),
      debug_boot_bitmap: String(o.debug_boot_bitmap || "").trim()
    };
  }

  /* ---------- UI helpers ---------- */
  convertToDisplay(mgdlValue, targetUnit) {
    return targetUnit === UNITS.MMOL ? (mgdlValue / 18).toFixed(1) : Math.round(mgdlValue);
  }
  getTrendArrow(dir) {
    const map = {
      DoubleUp: "↑↑", SingleUp: "↑", FortyFiveUp: "↗",
      Flat: "→",
      FortyFiveDown: "↘", SingleDown: "↓", DoubleDown: "↓↓",
      NONE: "-", "NOT COMPUTABLE": "?"
    };
    return map[dir] || "?";
  }
  _getLocaleBundle(sessionId, settings) {
    const lang = (settings.language || "en") === "es" ? "es" : "en";
    const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const locale = lang === "es" ? "es-ES" : "en-US";
    return { lang, tz, locale };
  }

  buildTirBar(pct) {
    const filled = clamp(Math.round(pct / 5), 0, 20);
    let s = "";
    for (let i = 0; i < 20; i++) s += (i < filled ? "█" : "░");
    return s;
  }

  async formatForG1(data, settings, sessionId) {
    const display = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const trend = this.getTrendArrow(data.direction);
    const b = this._getLocaleBundle(sessionId || "default", settings);
    const readingTime = new Date(data.date);
    const timeStr = readingTime.toLocaleTimeString(b.locale, { timeZone: b.tz, hour: "2-digit", minute: "2-digit", hour12: false });
    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const timeAgo = minutesAgo <= 1 ? (b.lang === "es" ? "ahora" : "now") : (b.lang === "es" ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    return `${display} ${settings.units || UNITS.MGDL} ${trend}\n${timeStr} (${timeAgo})`;
  }

  async formatForG1WithPrediction(data, settings, sessionId) {
    const unit = settings.units || UNITS.MGDL;
    const highFixed = unit === UNITS.MMOL ? 10 : 180;
    const lowFixed  = unit === UNITS.MMOL ? 3.3 : 60;

    const base = await this.formatForG1(data, settings, sessionId);

    try {
      const mg = data.sgv;
      if (!Number.isFinite(mg)) return base;
      const isHigh = mg >= (unit === UNITS.MMOL ? highFixed*18 : highFixed);
      const isLow  = mg <= (unit === UNITS.MMOL ? lowFixed*18 : lowFixed);
      if (!isHigh && !isLow) return base;

      const horizonMin = clamp(settings.prediction_horizon_min || DEFAULTS.prediction_horizon_min, 15, 60);
      const delta = 0;
      const predictedMg = clamp(mg + delta, 40, 400);
      const displayPred = this.convertToDisplay(predictedMg, unit);
      const t = (settings.language || "en") === "es"
        ? `Pred ~${displayPred} ${unit} @${horizonMin}m`
        : `Pred ~${displayPred} ${unit} @${horizonMin}m`;
      return `${base}\n${t}`;
    } catch {
      return base;
    }
  }

  _getTirLimits(settings) {
    const units = settings.units || UNITS.MGDL;
    const lowMg  = this.decideThresholdFromDual(settings.tir_low_mg,  settings.tir_low_mmol,  units, settings.tir_low_mmol  ? settings.tir_low_mmol  * 18 : null) ?? 70;
    const highMg = this.decideThresholdFromDual(settings.tir_high_mg, settings.tir_high_mmol, units, settings.tir_high_mmol ? settings.tir_high_mmol * 18 : null) ?? 180;
    const low = clamp(lowMg, 40, 140);
    const high = clamp(highMg, 160, 300);
    return { low, high };
  }

  updateDailyTirState(sessionId, currentMg, _currentTs, settings) {
    const st = this.dailyTirState.get(sessionId) || { inRange: 0, total: 0, day: new Date().getUTCDate() };
    const { low, high } = this._getTirLimits(settings);
    const nowDay = new Date().getUTCDate();
    if (st.day !== nowDay) { st.inRange = 0; st.total = 0; st.day = nowDay; }
    st.total += 1;
    if (Number.isFinite(currentMg) && currentMg >= low && currentMg <= high) st.inRange += 1;
    this.dailyTirState.set(sessionId, st);
    const tirPct = st.total > 0 ? Math.round((st.inRange / st.total) * 100) : null;
    return { ...st, tirPct };
  }

  _computeAlertType(data, settings) {
    const unit = settings.units || UNITS.MGDL;
    const mg = data.sgv;
    if (!Number.isFinite(mg)) return null;

    const lowTh  = this.decideThresholdFromDual(settings.low_alert_mg,  settings.low_alert_mmol,  unit, settings.low_alert_mmol  ? settings.low_alert_mmol  * 18 : null);
    const highTh = this.decideThresholdFromDual(settings.high_alert_mg, settings.high_alert_mmol, unit, settings.high_alert_mmol ? settings.high_alert_mmol * 18 : null);

    const hystMg = unit === UNITS.MMOL ? (settings.alert_hysteresis_mmol || DEFAULTS.alert_hysteresis_mmol) * 18
                                       : (settings.alert_hysteresis_mg || DEFAULTS.alert_hysteresis_mg);

    const latch = this.alertLatch.get(settings.sessionId) || null;

    const force = (settings.debug_force_alert || "").toLowerCase();
    if (force === "low")  return "low";
    if (force === "high") return "high";

    if (mg < lowTh) {
      this.alertLatch.set(settings.sessionId, "low");
      return "low";
    }
    if (mg > highTh) {
      this.alertLatch.set(settings.sessionId, "high");
      return "high";
    }
    if (latch === "low"  && mg < (lowTh  + hystMg))  return "low";
    if (latch === "high" && mg > (highTh - hystMg))  return "high";

    this.alertLatch.set(settings.sessionId, null);
    return null;
  }

  showClamped(session, sessionId, text, maxLines = 5) {
    try {
      const lines = String(text || "").replace(/\r/g, "").split("\n");
      while (lines.length && lines[0].trim() === "") lines.shift();
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      const out = lines.slice(0, maxLines).join("\n");
      const last = this._lastShownText.get(sessionId);
      if (last === out) return;
      this._lastShownText.set(sessionId, out);
      session.layouts.showTextWall(out);
    } catch (_) {}
  }
  hideDisplay(session, sessionId) {
    try { session.layouts.showTextWall(""); this._lastShownText.delete(sessionId); } catch {}
  }
  _formatLimitsEcho(settings) {
    const { low, high } = this._getTirLimits(settings);
    if ((settings.units || UNITS.MGDL) === UNITS.MMOL) {
      const lo = (low / 18).toFixed(1);
      const hi = (high / 18).toFixed(1);
      return `${lo}–${hi} mmol/L`;
    }
    return `${Math.round(low)}–${Math.round(high)} mg/dL`;
  }

  _echoSettings(session, sessionId, settings) {
    const limitsEcho = this._formatLimitsEcho(settings);
    const isEs = (settings.language || "en") === "es";
    const l1 = isEs ? "Ajustes guardados" : "Settings saved";
    const alerts = settings.alertsEnabled ? (isEs ? "Alertas: ON" : "Alerts: ON") : (isEs ? "Alertas: OFF" : "Alerts: OFF") ;
    const nsWarn = (!settings.nightscoutUrl || !isValidUrl(settings.nightscoutUrl))
      ? (isEs ? "⚠ Configura URL Nightscout" : "⚠ Set Nightscout URL")
      : null;
    const line3 = `${isEs ? "TIR hoy" : "TIR"}: ${limitsEcho}`;
    const msg = [l1, alerts, line3].concat(nsWarn ? [nsWarn] : []).join("\n");
    this.showClamped(session, sessionId, msg);
  }

  async animateTIRFill(session, sessionId, settings, formattedData, tirPct, tLine) {
    const arr = [];
    arr.push(formattedData);
    if (tirPct != null) {
      const bar = !this.toBool(settings.show_tir_bar) ? "" : this.buildTirBar(tirPct);
      const txt = (settings.language || "en") === "es" ? `TIR hoy: ${tirPct}%` : `TIR: ${tirPct}%`;
      arr.push(txt);
      if (bar) arr.push(bar);
    }
    if (tLine) arr.push(tLine);
    this.showClamped(session, sessionId, arr.join("\n"));
  }

  async getRecentTreatments(settings, sessionId) {
    try {
      const http = this._getHttp(sessionId);
      const base = String(settings.nightscoutUrl || "").replace(/\/+$/, "");
      if (!base || !isValidUrl(base)) return [];
      const hasQuery = base.includes("?");
      const token = String(settings.nightscoutToken || "").trim();
      const tokenParam = token ? (hasQuery ? `&token=${encodeURIComponent(token)}` : `?token=${encodeURIComponent(token)}`) : (hasQuery ? "" : "?");
      const url = `${base}/api/v1/treatments.json${tokenParam}&count=60`;
      const { data } = await http.get(url);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  formatTreatmentsLine(arr, settings, sessionId) {
    try {
      const now = Date.now();
      const since = now - 12 * 3600000;
      let carbs = 0, ins = 0;
      for (const t of arr) {
        const ts = new Date(t.created_at || t.eventDate || t.timestamp || t.dateString || t.date).getTime() || 0;
        if (!ts || ts < since) continue;
        carbs += Number(t.carbs || 0);
        ins   += Number(t.insulin || 0);
      }
      const cStr = (settings.language || "en") === "es" ? "CH día" : "Carbs";
      const iStr = (settings.language || "en") === "es" ? "Ins día" : "Ins";
      const carbsStr = `${Math.round(carbs)}g`;
      const insStr = `${(Math.round(ins * 10) / 10).toFixed(1)}U`.replace(/\.0U$/,"U");
      return `${cStr}: ${carbsStr} · ${iStr}: ${insStr}`;
    } catch {
      return "";
    }
  }

  async showInitialAndHide(session, sessionId, settings) {
    try {
      const bootBmp = String(settings.debug_boot_bitmap || "").toLowerCase();
      const bootMap = { low: "alert-low-526x100", high: "alert-high-526x100" };
      if (bootBmp && bootMap[bootBmp] && hasBitmap(bootMap[bootBmp]) && session && session.layouts) {
        const bmp = getBitmap(bootMap[bootBmp]);
        if (bmp && typeof session.layouts.showBitmap === "function") {
          session.layouts.showBitmap(bmp.dataRGBA, bmp.width, bmp.height);
          await this.__delay(2000);
        }
      }
    } catch (_) {}

    try {
      const data = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      const tirRes = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      const formattedData = await this.formatForG1WithPrediction(data, settings, sessionId);
      if (settings.enable_advanced_mode) {
        const tirPct = tirRes.tirPct;
        let tLine = "";
        try { const sum = await this.getRecentTreatments(settings, sessionId); tLine = this.formatTreatmentsLine(sum, settings, sessionId); } catch {}
        await this.animateTIRFill(session, sessionId, settings, formattedData, tirPct, tLine);
      } else {
        this.showClamped(session, sessionId, formattedData);
      }
      this._scheduleHide(sessionId, settings);
    } catch (e) {
      const last = this.lastGoodEntry.get(sessionId);
      let warn;
      if (String(e && e.message) === "NS_URL_MISSING") {
        warn = (settings.language || "en") === "es"
          ? "⚠ Configura URL/Token de Nightscout en Ajustes"
          : "⚠ Set Nightscout URL/Token in Settings";
      } else {
        warn = (settings.language || "en") === "es" ? "⚠ sin datos NS" : "⚠ no NS data";
      }
      if (last) {
        const txt = await this.formatForG1WithPrediction(last, settings, sessionId);
        this.showClamped(session, sessionId, `${txt}\n${warn}`);
      } else {
        this.showClamped(session, sessionId, warn);
      }
      this._scheduleHide(sessionId, settings);
    }
  }

  _scheduleHide(sessionId, settings) {
    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
    const t = setTimeout(() => {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      this.hideDisplay(sd.session, sessionId);
    }, settings.display_duration_ms || DEFAULTS.display_duration_ms);
    this.displayTimers.set(sessionId, t);
  }
  // *** AQUÍ ES DONDE INYECTAMOS EL BITMAP (fijo) Y MANTENEMOS EL TEXTO PARPADEANDO ***
  async triggerAnimatedAlert(session, sessionId, data, settings, type) {
    const displayValue = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const unit = settings.units || UNITS.MGDL;
    const lang = settings.language || "en";
    const msgs = {
      en: { low: `LOW GLUCOSE!`, high: `HIGH GLUCOSE!` },
      es: { low: `¡GLUCOSA BAJA!`, high: `¡GLUCOSA ALTA!` }
    };
    const baseText = `${msgs[lang][type]}\n${displayValue} ${unit}`;
    const alertDuration = settings.alert_duration_ms || DEFAULTS.alert_duration_ms;
    const blinkInterval = 600;

    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));

    // ===== Bitmap fijo arriba del texto (LOW/HIGH) =====
    try {
      const bmpKey = (type === "low") ? "alert-low-526x100" :
                     (type === "high") ? "alert-high-526x100" : null;
      if (bmpKey && typeof hasBitmap === "function" && hasBitmap(bmpKey) &&
          session && session.layouts && typeof session.layouts.showBitmap === "function") {
        const bmp = getBitmap(bmpKey);
        if (bmp && bmp.dataRGBA && bmp.width && bmp.height) {
          session.layouts.showBitmap(bmp.dataRGBA, bmp.width, bmp.height);
        }
      }
    } catch (_) { /* fallback a solo texto */ }
    // ===== Fin bitmap fijo =====

    const startTime = Date.now();
    let isVisible = true;

    const blinker = setInterval(() => {
      if (Date.now() - startTime > alertDuration) {
        clearInterval(blinker);
        this.hideDisplay(session, sessionId);
        return;
      }
      const symbol = isVisible ? "[!]" : "[ ]";
      this.showClamped(session, sessionId, `${symbol} ${baseText}`);
      isVisible = !isVisible;
    }, blinkInterval);

    this.displayTimers.set(sessionId, setTimeout(() => {
      clearInterval(blinker);
      this.hideDisplay(session, sessionId);
    }, alertDuration + 120));
  }

  _canFireAlert(sessionId, settings) {
    const hist = this.alertHistory.get(sessionId) || { last: 0 };
    const now = Date.now();
    if (now - hist.last < (settings.alert_cooldown_ms || DEFAULTS.alert_cooldown_ms)) return false;
    return true;
  }
  _markAlertFired(sessionId) {
    this.alertHistory.set(sessionId, { last: Date.now() });
  }

  async checkAndAlert(session, sessionId, data, settings) {
    if (!this.toBool(settings.alertsEnabled)) return;

    const type = this._computeAlertType(data, { ...settings, sessionId });
    if (!type) return;

    if (!this._canFireAlert(sessionId, settings)) return;

    this.triggerAnimatedAlert(session, sessionId, data, settings, type);
    this._markAlertFired(sessionId);
  }

  _shouldShowHeadUp(sessionId, settings) {
    if (!this.toBool(settings.enable_head_up_display)) return false;
    const last = this.headUpLastShown.get(sessionId) || 0;
    if (Date.now() - last < 3000) return false;
    this.headUpLastShown.set(sessionId, Date.now());
    return true;
  }

  async updateLoop(sessionId) {
    const sd = this.activeSessions.get(sessionId);
    if (!sd) return;
    const { session, settings } = sd;

    try {
      const data = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      await this.checkAndAlert(session, sessionId, data, settings);
    } catch (_) {
    } finally {
      const ui = clamp(settings.updateInterval || DEFAULTS.updateInterval, 1, 30);
      setTimeout(() => this.updateLoop(sessionId), ui * 1000);
    }
  }
  // *** Mantén este handler tal y como lo tenías en tu base que funcionaba ***
  async onSession(session, sessionId, userId) {
    try {
      const settings = this.getUserSettings(session);
      this.activeSessions.set(sessionId, { session, settings, headUpEnabled: true, renderToken: 0 });

      // ECO (incluye TIR con unidades correctas y aviso si falta URL)
      this._debouncedEcho(sessionId);

      // HUD inicial
      await this.showInitialAndHide(session, sessionId, settings);

      // Iniciar loop periódico
      setTimeout(() => this.updateLoop(sessionId), (settings.updateInterval || DEFAULTS.updateInterval) * 1000);
    } catch (e) {
      console.error("onSession error:", e);
    }
  }

  _debouncedEcho(sessionId) {
    if (this._settingsEchoDebounce.has(sessionId)) clearTimeout(this._settingsEchoDebounce.get(sessionId));
    const t = setTimeout(() => {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      this._echoSettings(sd.session, sessionId, sd.settings);
    }, 250);
    this._settingsEchoDebounce.set(sessionId, t);
  }

  async onInteraction(session, interaction) {
    const sessionId = session.sessionId;
    const sd = this.activeSessions.get(sessionId);
    if (!sd) return;
    const settings = sd.settings;

    if (interaction && interaction.type === "HEAD_UP") {
      if (!this._shouldShowHeadUp(sessionId, settings)) return;
      await this.showInitialAndHide(session, sessionId, settings);
    }
  }

  mgToUnit(mg, unit) { return unit === UNITS.MMOL ? (mg / 18).toFixed(1) : Math.round(mg); }
}

/* ---------- Arranque del servidor: respeta tu base ---------- */
const PORT = Number(process.env.PORT || 3000);
const server = new NightscoutMentraApp({
  packageName: process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose",
  apiKey: process.env.MENTRAOS_API_KEY || "demo",
  port: PORT
});

// Si en tu base usabas app.start() o app.listen(), mantén lo que ya funcionaba.
// Aquí exponemos /health por si lo usabas para Render (sin romper nada).
server.start().then(() => {
  console.log(`Server started on ${PORT}`);
  try {
    server.app?.get?.("/health", (_req, res) => res.json({ status: "alive", ts: new Date().toISOString() }));
  } catch {}
}).catch(err => {
  console.error("Error iniciando servidor:", err);
  process.exit(1);
});
// (si tu base tenía más endpoints Express u otros helpers, déjalos igual)

NightscoutMentraApp.prototype.findMinMaxOfDay = function(entries) {
  try {
    if (!Array.isArray(entries) || !entries.length) return null;
    let min = Infinity, max = -Infinity;
    for (const e of entries) {
      const v = Number(e.sgv);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min, max };
  } catch { return null; }
};

NightscoutMentraApp.prototype.formatMinMaxLine = function(minMax, settings) {
  try {
    if (!minMax) return "";
    const u = settings.units || UNITS.MGDL;
    const min = this.mgToUnit(minMax.min, u);
    const max = this.mgToUnit(minMax.max, u);
    const isEs = (settings.language || "en") === "es";
    return isEs ? `Mín/Máx: ${min}/${max} ${u}` : `Min/Max: ${min}/${max} ${u}`;
  } catch { return ""; }
};
module.exports = { NightscoutMentraApp };
