"use strict";
/**
 * Nightscout ↔ MentraOS (Even Realities G1) — stable-v3
 *
 * Cambios respecto a stable-v2:
 * - Eventos de settings actualizados al SDK actual:
 *     onSettingsUpdate  → recibe array completo de settings
 *     onSettingChange   → escucha clave individual
 *   (eliminados onAppSettingsUpdate y onSettingsChange que no existen en SDK actual)
 * - Boot bitmap eliminado: ningún método de imagen está documentado en el SDK actual.
 *   Se sustituye por texto de bienvenida.
 * - Lectura de settings simplificada usando session.settings.get() síncrono.
 * - Limpieza menor de código muerto.
 */
require("dotenv").config();

const { AppServer } = require("@mentra/sdk");
const axios = require("axios");

const PKG     = process.env.PACKAGE_NAME   || "com.tucompania.nightscout-glucose";
const PORT    = parseInt(process.env.PORT  || "3000", 10);
const API_KEY = process.env.MENTRAOS_API_KEY;

const UNITS  = { MGDL: "mg/dL", MMOL: "mmol/L" };
const LAYERS = { ECO: 0, HUD: 1, ALERT: 3 };

// ───────────────────────────────── Utilities ─────────────────────────────────
const clamp01   = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeCubic = (t) => (t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2);
const pickEase  = (name) =>
  name === "linear" ? (t) => t
  : name === "smooth" ? (t) => t*t*(3-2*t)
  : easeCubic;

const barFromRatio = (r, slots = 20) => {
  const n = Math.round(clamp01(r) * slots);
  return `[${"¦".repeat(n)}${"·".repeat(Math.max(0, slots - n))}]`;
};

function mmString(mg) { return (mg / 18).toFixed(1); }

// ──────────────────────────────── App Server ────────────────────────────────
class NightscoutMentraV3 extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions        = new Map(); // sessionId → { session, userId, settings, timers }
    this.httpClients     = new Map();
    this.locales         = new Map();
    this.lastShownText   = new Map();
    this.renderTokens    = new Map();
    this.renderLayers    = new Map();
    this.renderHoldUntil = new Map();
    this.alertHistory    = new Map();
    this.alertLatch      = new Map();
    this.lastGoodEntry   = new Map();
    this.dailyTIR        = new Map();
    this.headUpLastShown = new Map();
    this.startedAt       = Date.now();
  }

  // ─────────────────────────── Helpers numéricos ───────────────────────────
  toBool(x)  { return x === true || x === "true" || x === 1 || x === "1"; }
  parseNum(val, fb) {
    const n = (typeof val === "object" && val) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fb;
  }
  validateNum(val, min, max, fb) {
    const v = this.parseNum(val, fb);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fb;
  }
  normalizeMmol(val) {
    const v = this.parseNum(val, null);
    return (v !== null && Number.isFinite(v)) ? (v >= 30 ? v / 10 : v) : null;
  }

  // ─────────────────────────── Locale / Timezone ───────────────────────────
  getLanguageSettings(settings) {
    const map = {
      es: { locale: "es-ES", timezone: "Europe/Madrid" },
      en: { locale: "en-US", timezone: "America/New_York" },
    };
    return map[settings.language] || map.en;
  }
  validateTimezone(tz) {
    const valid = [
      "Europe/Madrid","Atlantic/Canary","Europe/London","Europe/Paris","Europe/Berlin","Europe/Rome",
      "America/New_York","America/Chicago","America/Los_Angeles","America/Mexico_City",
      "America/Argentina/Buenos_Aires","America/Sao_Paulo","Asia/Tokyo","Australia/Sydney","UTC",
    ];
    return valid.includes(tz) ? tz : "UTC";
  }
  getLocaleBundle(sessionId, settings) {
    const cached = this.locales.get(sessionId);
    const tzz = settings.timezone || null;
    if (cached && cached.lang === settings.language && cached.tz === tzz) return cached;
    const lang = this.getLanguageSettings(settings);
    const tz   = tzz ? this.validateTimezone(tzz) : lang.timezone;
    const b    = { lang: settings.language || "en", locale: lang.locale, tz };
    this.locales.set(sessionId, b);
    return b;
  }

  // ────────────────────────────── Settings ─────────────────────────────────
  /**
   * Lee todos los ajustes desde session.settings (SDK actual).
   * session.settings.get(key) devuelve el valor directamente (síncrono).
   */
  getUserSettings(session) {
    const g = (key) => session.settings.get(key);

    const updateInterval = Math.max(1, Math.min(60, parseInt(g("update_interval"), 10) || 5));
    const displayMs = Math.min(15, Math.max(1, this.parseNum(g("display_duration_s"), 5))) * 1000;
    const alertMs   = Math.min(60, Math.max(2,  this.parseNum(g("alert_duration_s"),  15))) * 1000;
    const cooldownMs= Math.min(60, Math.max(1,  this.parseNum(g("alert_cooldown_min"),10))) * 60000;

    const showTirRaw   = g("show_tir_bar");
    const showRangeRaw = g("show_range_bar");
    const showTirBar   = (showTirRaw == null && showRangeRaw == null) ? true : this.toBool(showTirRaw);
    const showRangeBar = this.toBool(showRangeRaw);

    return {
      nightscoutUrl:    String(g("nightscout_url")  || "").trim(),
      nightscoutToken:  String(g("nightscout_token")|| "").trim(),
      updateInterval,
      low_alert_mg:     this.validateNum(g("low_alert_mg"),  50,  120, 70),
      high_alert_mg:    this.validateNum(g("high_alert_mg"), 180, 400, 250),
      low_alert_mmol:   this.normalizeMmol(g("low_alert_mmol"))  ?? 3.9,
      high_alert_mmol:  this.normalizeMmol(g("high_alert_mmol")) ?? 13.9,
      alertsEnabled:    this.toBool(g("alerts_enabled")),
      language:         g("language") || "en",
      timezone:         g("timezone") || null,
      units:            g("units")    || UNITS.MGDL,
      enable_head_up_display: this.toBool(g("enable_head_up_display")),
      display_duration_ms: displayMs,
      alert_duration_ms:   alertMs,
      alert_cooldown_ms:   cooldownMs,
      show_tir_bar:    showTirBar,
      show_range_bar:  showRangeBar,
      enable_advanced_mode: this.toBool(g("enable_advanced_mode")) || this.toBool(g("advanced_mode_enabled")),
      alert_hysteresis_mg:   this.validateNum(g("alert_hysteresis_mg"),   0, 50, 5),
      alert_hysteresis_mmol: this.normalizeMmol(g("alert_hysteresis_mmol")) ?? 0.3,
      tir_low_mg:   this.parseNum(g("tir_low_mg"),  null),
      tir_high_mg:  this.parseNum(g("tir_high_mg"), null),
      tir_low_mmol: this.normalizeMmol(g("tir_low_mmol")),
      tir_high_mmol:this.normalizeMmol(g("tir_high_mmol")),
      time_in_range_low_mg:    this.parseNum(g("time_in_range_low_mg"),  null),
      time_in_range_high_mg:   this.parseNum(g("time_in_range_high_mg"), null),
      time_in_range_low_mmol:  this.normalizeMmol(g("time_in_range_low_mmol")),
      time_in_range_high_mmol: this.normalizeMmol(g("time_in_range_high_mmol")),
      prediction_horizon_min: [15,30,60].includes(Number(g("prediction_horizon_min") || g("prediction_horizon_mins")))
        ? Number(g("prediction_horizon_min") || g("prediction_horizon_mins")) : 30,
      debug_force_alert: typeof g("debug_force_alert") === "string" ? g("debug_force_alert") : null,
      animation_type:   g("animation_type")    || "cubic",
      enable_animations:g("enable_animations") === undefined ? true : this.toBool(g("enable_animations")),
    };
  }

  // ──────────────────────────── HTTP Nightscout ────────────────────────────
  ensureHttp(sessionId, settings) {
    const baseRaw = (settings.nightscoutUrl || "").trim();
    if (!baseRaw) return null;
    const base    = baseRaw.startsWith("http") ? baseRaw : "https://" + baseRaw;
    const baseURL = base.endsWith("/") ? base.slice(0, -1) : base;
    const params  = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
    let cli = this.httpClients.get(sessionId);
    const changed = !cli
      || cli.defaults.baseURL !== baseURL
      || JSON.stringify(cli.defaults.params || {}) !== JSON.stringify(params);
    if (changed) {
      cli = axios.create({ baseURL, params, timeout: 10000, headers: { "User-Agent": "MentraOS-Nightscout/v3" } });
      this.httpClients.set(sessionId, cli);
    }
    return cli;
  }

  // ───────────────────────────── Alertas / límites ─────────────────────────
  getAlertLimits(settings) {
    const units  = String(settings.units || "").toLowerCase();
    const lowMg  = this.parseNum(settings.low_alert_mg,  NaN);
    const highMg = this.parseNum(settings.high_alert_mg, NaN);
    const lowM   = this.normalizeMmol(settings.low_alert_mmol);
    const highM  = this.normalizeMmol(settings.high_alert_mmol);
    const mgOK   = Number.isFinite(lowMg) && Number.isFinite(highMg);
    const mmOK   = Number.isFinite(lowM)  && Number.isFinite(highM);
    if (units.includes("mmol")) {
      if (mmOK) return { low: Math.round(lowM * 18),  high: Math.round(highM * 18) };
      if (mgOK) return { low: Math.round(lowMg),      high: Math.round(highMg) };
      return { low: Math.round(3.9 * 18), high: Math.round(13.9 * 18) };
    }
    if (mgOK) return { low: Math.round(lowMg), high: Math.round(highMg) };
    if (mmOK) return { low: Math.round(lowM * 18), high: Math.round(highM * 18) };
    return { low: 70, high: 250 };
  }

  getHysteresisMg(settings) {
    const mg  = this.validateNum(settings.alert_hysteresis_mg, 0, 50, NaN);
    const raw = this.parseNum(settings.alert_hysteresis_mmol, NaN);
    let mmol  = NaN;
    if (Number.isFinite(raw)) {
      mmol = Number.isInteger(raw)
        ? (raw >= 0 && raw <= 10 ? raw / 10 : raw >= 30 ? raw / 10 : raw)
        : raw;
    }
    const mmolAsMg = Number.isFinite(mmol) ? Math.round(mmol * 18) : NaN;
    const units = String(settings.units || "").toLowerCase();
    if (units.includes("mmol")) return Number.isFinite(mmolAsMg) ? mmolAsMg : (Number.isFinite(mg) ? mg : 5);
    return Number.isFinite(mg) ? mg : (Number.isFinite(mmolAsMg) ? mmolAsMg : 5);
  }

  alertLimitsChanged(oldS, newS) {
    if (!oldS) return false;
    return (
      oldS.low_alert_mg    !== newS.low_alert_mg    ||
      oldS.high_alert_mg   !== newS.high_alert_mg   ||
      oldS.low_alert_mmol  !== newS.low_alert_mmol  ||
      oldS.high_alert_mmol !== newS.high_alert_mmol ||
      oldS.units           !== newS.units           ||
      oldS.alert_hysteresis_mg   !== newS.alert_hysteresis_mg   ||
      oldS.alert_hysteresis_mmol !== newS.alert_hysteresis_mmol
    );
  }

  // ─────────────────────────── Display helpers ─────────────────────────────
  convertToDisplay(mgdl, unit) {
    return unit === UNITS.MMOL ? (mgdl / 18).toFixed(1) : Math.round(mgdl);
  }
  arrowFromDirection(dir) {
    const map = {
      DoubleUp:"↑↑", SingleUp:"↑", FortyFiveUp:"↗", Flat:"→",
      FortyFiveDown:"↘", SingleDown:"↓", DoubleDown:"↓↓", NONE:"-", "NOT COMPUTABLE":"?",
    };
    return map[dir] || "?";
  }
  canRender(sessionId, layer) {
    const hold = this.renderHoldUntil.get(sessionId) || 0;
    if (Date.now() < hold) return false;
    const current = this.renderLayers.get(sessionId);
    return current == null || current <= LAYERS.HUD || layer >= current;
  }
  beginOverlay(sessionId, layer, durationMs) {
    this.renderLayers.set(sessionId, layer);
    this.renderHoldUntil.set(sessionId, Date.now() + (durationMs || 0) + 100);
  }
  endOverlay(session, sessionId) {
    try { this.clearDisplay(session, sessionId); } catch {}
    this.renderLayers.set(sessionId, LAYERS.HUD);
    this.renderHoldUntil.set(sessionId, 0);
  }
  clearDisplay(session, sessionId) {
    try { session?.layouts?.showTextWall?.(""); } catch {}
    this.lastShownText.delete(sessionId);
  }
  showText(session, sessionId, text) {
    const out  = String(text || "");
    const last = this.lastShownText.get(sessionId);
    if (last === out) return;
    this.lastShownText.set(sessionId, out);
    try { session?.layouts?.showTextWall?.(out); } catch {}
  }
  showTextForce(session, sessionId, text) {
    this.lastShownText.delete(sessionId);
    this.showText(session, sessionId, text);
  }

  buildRangeBar(mgdl, settings) {
    const lim = this.getAlertLimits(settings);
    const { low, high } = lim;
    if (!Number.isFinite(mgdl) || high <= low) return "";
    const slots = 20;
    const pos   = Math.max(0, Math.min(1, (mgdl - low) / (high - low)));
    const idx   = Math.round(pos * slots);
    const left  = "═".repeat(Math.max(0, idx));
    const right = "═".repeat(Math.max(0, slots - idx));
    const unitIsMmol = String(settings.units || "").toLowerCase().includes("mmol");
    const lowTxt  = unitIsMmol ? mmString(low)  : String(low);
    const highTxt = unitIsMmol ? mmString(high) : String(high);
    return `L ${lowTxt}-${highTxt} ${settings.units || UNITS.MGDL}\n|${left}*${right}|`;
  }

  // ──────────────────────────── Timers centralizados ───────────────────────
  setDisplayTimeout(sessionId, ms, fn) {
    const sd = this.sessions.get(sessionId); if (!sd) return;
    if (sd.timers.display) clearTimeout(sd.timers.display);
    sd.timers.display = setTimeout(fn, ms);
  }
  setUpdateInterval(sessionId, ms, fn) {
    const sd = this.sessions.get(sessionId); if (!sd) return;
    if (sd.timers.update) clearInterval(sd.timers.update);
    sd.timers.update = setInterval(fn, ms);
  }
  setAnimationInterval(sessionId, ms, fn) {
    const sd = this.sessions.get(sessionId); if (!sd) return;
    if (sd.timers.animation) clearInterval(sd.timers.animation);
    sd.timers.animation = setInterval(fn, ms);
  }
  clearAllTimers(sessionId) {
    const sd = this.sessions.get(sessionId); if (!sd) return;
    ["display","update","animation","settings"].forEach(k => {
      if (sd.timers[k]) { (k === "update" || k === "animation" ? clearInterval : clearTimeout)(sd.timers[k]); sd.timers[k] = null; }
    });
  }
  clearTransientTimers(sessionId) {
    const sd = this.sessions.get(sessionId); if (!sd) return;
    ["display","animation","settings"].forEach(k => {
      if (sd.timers[k]) { (k === "animation" ? clearInterval : clearTimeout)(sd.timers[k]); sd.timers[k] = null; }
    });
  }

  // ──────────────────────────── Presentación / HUD ─────────────────────────
  async formatBase(data, settings, sessionId) {
    const display   = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const trend     = this.arrowFromDirection(data.direction);
    const b         = this.getLocaleBundle(sessionId, settings);
    const t         = new Date(data.date);
    const timeStr   = t.toLocaleTimeString(b.locale, { timeZone: b.tz, hour: "2-digit", minute: "2-digit", hour12: false });
    const minutesAgo= Math.floor((Date.now() - data.date) / 60000);
    const timeAgo   = minutesAgo <= 1
      ? (b.lang === "es" ? "ahora" : "now")
      : (b.lang === "es" ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);
    return `${display} ${settings.units || UNITS.MGDL} ${trend}\n${timeStr} (${timeAgo})`;
  }

  getLocalDayStr(ts, settings, sessionId = "default") {
    const b = this.getLocaleBundle(sessionId, settings);
    return new Date(ts).toLocaleDateString(b.locale, { timeZone: b.tz });
  }

  updateDailyTirState(sessionId, mgdl, ts, settings) {
    const range  = this.getAlertLimits(settings);
    const dayStr = this.getLocalDayStr(ts, settings, sessionId);
    let st = this.dailyTIR.get(sessionId);
    if (!st || st.dayStr !== dayStr) st = { dayStr, total: 0, inRange: 0 };
    if (Number.isFinite(mgdl)) { st.total += 1; if (mgdl >= range.low && mgdl <= range.high) st.inRange += 1; }
    this.dailyTIR.set(sessionId, st);
    return { tirPct: st.total > 0 ? Math.round((st.inRange / st.total) * 100) : null, total: st.total };
  }

  async getRecentTreatments(settings, hours = "day", sessionId = "default") {
    try {
      const http = this.ensureHttp(sessionId, settings);
      if (!http) return null;
      const { data } = await http.get("/api/v1/treatments.json?count=1000");
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      const b   = this.getLocaleBundle(sessionId, settings);
      const todayStr = new Date().toLocaleDateString(b.locale, { timeZone: b.tz });
      const events = arr.map(t => {
        const dateStr = t.created_at || t.timestamp || t.dateString || t.date || null;
        let ts = null;
        if (typeof dateStr === "number") ts = dateStr;
        else if (typeof dateStr === "string") ts = Date.parse(dateStr);
        return { ts, carbs: Number(t.carbs), insulin: Number(t.insulin) };
      }).filter(e => e.ts && (Number.isFinite(e.carbs) || Number.isFinite(e.insulin)));

      let windowed, label;
      if (hours === "day") {
        windowed = events.filter(e => new Date(e.ts).toLocaleDateString(b.locale, { timeZone: b.tz }) === todayStr);
        label    = (settings.language || "en") === "es" ? "hoy" : "today";
      } else {
        const since = Date.now() - Math.max(1, hours) * 3600000;
        windowed = events.filter(e => e.ts >= since);
        label    = `${hours}h`;
      }
      if (!windowed.length) return { label, totalCarbs: 0, totalInsulin: 0, last: null };
      let totalCarbs = 0, totalInsulin = 0, last = null;
      for (const e of windowed) {
        if (Number.isFinite(e.carbs))   totalCarbs   += e.carbs;
        if (Number.isFinite(e.insulin)) totalInsulin += e.insulin;
        if (!last || e.ts > last.ts) last = e;
      }
      return { label, totalCarbs, totalInsulin, last };
    } catch { return null; }
  }

  formatTreatmentsLine(summary, settings, sessionId = "default") {
    if (!summary) return "";
    const { label, totalCarbs, totalInsulin, last } = summary;
    const lang = settings.language || "en";
    const r1   = (x) => Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
    const c = r1(totalCarbs), i = r1(totalInsulin);
    let lastStr = "";
    if (last && (Number.isFinite(last.carbs) || Number.isFinite(last.insulin))) {
      const b     = this.getLocaleBundle(sessionId, settings);
      const t     = new Date(last.ts).toLocaleTimeString(b.locale, { timeZone: b.tz, hour: "2-digit", minute: "2-digit", hour12: false });
      const parts = [];
      if (Number.isFinite(last.carbs))   parts.push(`${r1(last.carbs)}g`);
      if (Number.isFinite(last.insulin)) parts.push(`${r1(last.insulin)}U`);
      lastStr = parts.length ? (lang === "es" ? ` · Últ: ${parts.join(", ")} ${t}` : ` · Last: ${parts.join(", ")} ${t}`) : "";
    }
    return lang === "es"
      ? (label === "hoy"   ? `CH/Ins hoy: ${c}g / ${i}U${lastStr}`   : `CH/Ins ${label}: ${c}g / ${i}U${lastStr}`)
      : (label === "today" ? `Carbs/Ins today: ${c}g / ${i}U${lastStr}` : `Carbs/Ins ${label}: ${c}g / ${i}U${lastStr}`);
  }

  async getTodayEntries(settings, sessionId = "default") {
    const http = this.ensureHttp(sessionId, settings);
    if (!http) throw new Error("URL not set");
    const { data } = await http.get("/api/v1/entries/sgv.json?count=400");
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    const b   = this.getLocaleBundle(sessionId, settings);
    const todayStr = new Date().toLocaleDateString(b.locale, { timeZone: b.tz });
    return arr
      .map(r => ({ mgdl: Number(r.sgv ?? r.glucose), date: typeof r.date === "string" ? new Date(r.date).getTime() : r.date }))
      .filter(r => Number.isFinite(r.mgdl) && r.date)
      .filter(r => new Date(r.date).toLocaleDateString(b.locale, { timeZone: b.tz }) === todayStr)
      .sort((a, b) => a.date - b.date);
  }

  async getGlucoseData(settings, sessionId = "default") {
    const http = this.ensureHttp(sessionId, settings);
    if (!http) throw new Error("URL not set");
    const eps = [
      "/api/v1/entries/sgv.json?count=1",
      "/api/v1/entries.json?count=1",
      "/api/v1/entries/current.json",
    ];
    let lastError;
    for (const ep of eps) {
      try {
        const { data }  = await http.get(ep);
        const reading   = Array.isArray(data) ? data[0] : data;
        if (!reading) throw new Error("Empty");
        const glucose   = Number(reading.sgv ?? reading.glucose);
        if (!Number.isFinite(glucose)) throw new Error("No glucose");
        const dateValue = reading.date || reading.dateString || reading.sysTime;
        if (!dateValue) throw new Error("No date");
        return {
          sgv: glucose,
          date: typeof dateValue === "string" ? new Date(dateValue).getTime() : dateValue,
          direction: reading.direction || reading.trend || "NONE",
        };
      } catch (e) { lastError = e; }
    }
    throw new Error(`All endpoints failed: ${lastError?.message || "unknown"}`);
  }

  // ─────────────────────────────── Alertas ─────────────────────────────────
  async triggerTextAlert(session, sessionId, data, settings, type) {
    const displayValue = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const unit         = settings.units || UNITS.MGDL;
    const lang         = settings.language || "en";
    const msgs         = { en: { low: "LOW GLUCOSE!", high: "HIGH GLUCOSE!" }, es: { low: "¡GLUCOSA BAJA!", high: "¡GLUCOSA ALTA!" } };
    const baseText     = `${msgs[lang][type]}\n${displayValue} ${unit}`;
    const alertDuration= settings.alert_duration_ms || 15000;

    this.beginOverlay(sessionId, LAYERS.ALERT, alertDuration);
    const blink = 650, start = Date.now();
    this.setAnimationInterval(sessionId, blink, () => {
      if (Date.now() - start > alertDuration) {
        this.clearAllTimers(sessionId);
        this.endOverlay(session, sessionId);
        return;
      }
      const on = Math.floor((Date.now() - start) / blink) % 2 === 0;
      this.showText(session, sessionId, `${on ? "[!!]" : "[  ]"} ${baseText}`);
    });
    this.setDisplayTimeout(sessionId, alertDuration + 120, async () => {
      try { await this.showGlucoseTemporarily(session, sessionId, settings.display_duration_ms || 5000, settings); } catch {}
    });
  }

  async checkAlerts(session, sessionId, data, settings) {
    const limits      = this.getAlertLimits(settings);
    const mgdl        = data.sgv;
    const cooldown    = settings.alert_cooldown_ms || 600000;
    const lastAlertTs = this.alertHistory.get(sessionId);
    const latch       = this.alertLatch.get(sessionId) || null;
    const h           = this.getHysteresisMg(settings);

    if (latch === "low"  && mgdl >= (limits.low  + h)) this.alertLatch.set(sessionId, null);
    if (latch === "high" && mgdl <= (limits.high - h)) this.alertLatch.set(sessionId, null);
    if (this.alertLatch.get(sessionId)) return;
    if (lastAlertTs && Date.now() - lastAlertTs < cooldown) return;

    const dbg = (settings.debug_force_alert || "").toLowerCase();
    let alertType = null;
    if (mgdl <= limits.low  || dbg === "low")  alertType = "low";
    else if (mgdl >= limits.high || dbg === "high") alertType = "high";

    if (alertType) {
      this.alertHistory.set(sessionId, Date.now());
      this.alertLatch.set(sessionId, alertType);
      await this.triggerTextAlert(session, sessionId, data, settings, alertType);
    }
  }

  // ────────────────────────── Animación TIR ────────────────────────────────
  async animateTIRFill(session, sessionId, s, headerText, tirPct, tLine = "", extraLine = "") {
    const showBar = !!s.show_tir_bar;
    const anims   = s.enable_animations !== false;
    const finalBar= (p) =>
      `${headerText}\n${s.language === "es" ? `TIR hoy: ${p}%` : `TIR: ${p}%`} ${barFromRatio(p / 100, 20)}`
      + (tLine     ? `\n${tLine}`     : "")
      + (extraLine ? `\n${extraLine}` : "");

    if (!showBar || !anims || tirPct == null || !Number.isFinite(tirPct)) {
      this.showText(session, sessionId, finalBar(tirPct || 0));
      return;
    }
    const token  = (this.renderTokens.get(sessionId) || 0) + 1;
    this.renderTokens.set(sessionId, token);
    const slots  = 20;
    const target = Math.floor(clamp01(tirPct / 100) * slots);
    this.showText(session, sessionId, finalBar(0));
    const ease   = pickEase(String(s.animation_type || "cubic"));
    const t0     = Date.now() + 150;
    let last     = -1;
    this.setAnimationInterval(sessionId, 33, () => {
      if (this.renderTokens.get(sessionId) !== token) { this.clearAllTimers(sessionId); return; }
      const t      = Math.max(0, Math.min(1, (Date.now() - t0) / 900));
      const filled = Math.min(target, Math.floor(ease(t) * target));
      if (filled !== last) { this.showText(session, sessionId, finalBar(Math.round((filled / slots) * 100))); last = filled; }
      if (t >= 1)          { this.clearAllTimers(sessionId); this.showText(session, sessionId, finalBar(Math.round((target / slots) * 100))); }
    });
  }

  // ─────────────────────────── showGlucoseTemporarily ──────────────────────
  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    try {
      const sd = this.sessions.get(sessionId); if (!sd) return;
      const s  = providedSettings || sd.settings;
      const d  = await this.getGlucoseData(s, sessionId);
      this.lastGoodEntry.set(sessionId, d);
      const header = await this.formatBase(d, s, sessionId);

      if (s.enable_advanced_mode) {
        let tLine = "";
        try { const sum = await this.getRecentTreatments(s, "day", sessionId); tLine = this.formatTreatmentsLine(sum, s, sessionId); } catch {}
        if (s.show_range_bar) {
          const rangeBar = this.buildRangeBar(d.sgv, s);
          this.showText(session, sessionId, [header, rangeBar, tLine].filter(Boolean).join("\n"));
        } else if (s.show_tir_bar) {
          const { tirPct } = this.updateDailyTirState(sessionId, d.sgv, d.date, s);
          await this.animateTIRFill(session, sessionId, s, header, tirPct, tLine);
        } else {
          this.showText(session, sessionId, [header, tLine].filter(Boolean).join("\n"));
        }
      } else {
        this.showText(session, sessionId, header);
      }
      this.setDisplayTimeout(sessionId, ms, () => this.clearDisplay(session, sessionId));
    } catch (_) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const s    = this.sessions.get(sessionId)?.settings || {};
          const base = await this.formatBase(cached, s, sessionId);
          this.showText(session, sessionId, base);
          this.setDisplayTimeout(sessionId, s.display_duration_ms || 4000, () => this.clearDisplay(session, sessionId));
        }
      } catch {}
    }
  }

  // ─────────────────────────── Operación normal ────────────────────────────
  startNormalOperation(session, sessionId, userId, settings) {
    const ms = Math.max(1, Number(settings.updateInterval || 5)) * 60000;
    this.setUpdateInterval(sessionId, ms, async () => {
      if (!this.sessions.has(sessionId)) return;
      try {
        const sd = this.sessions.get(sessionId);
        const s  = sd?.settings;
        const d  = await this.getGlucoseData(s, sessionId);
        this.lastGoodEntry.set(sessionId, d);
        this.updateDailyTirState(sessionId, d.sgv, d.date, s);
        if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
      } catch (_) {}
    });
  }

  // ─────────────────────────── Limpieza de sesión ──────────────────────────
  cleanupSession(sessionId) {
    try {
      this.clearAllTimers(sessionId);
      [
        this.sessions, this.httpClients, this.locales, this.lastShownText,
        this.renderTokens, this.renderLayers, this.renderHoldUntil,
        this.alertHistory, this.alertLatch, this.lastGoodEntry,
        this.dailyTIR, this.headUpLastShown,
      ].forEach(m => m.delete(sessionId));
    } catch {}
  }

  // ──────────────────────────── Event handlers ─────────────────────────────
  setupEventHandlers(session, sessionId, userId) {

    // Botón físico
    session?.events?.onButtonPress?.(async () => {
      const sd = this.sessions.get(sessionId);
      const s  = sd?.settings;
      if (s) await this.showGlucoseTemporarily(session, sessionId, s.display_duration_ms || 4000, s);
    });

    // Cabeza arriba (head-up gesture)
    session?.events?.onHeadPosition?.(async (data) => {
      try {
        if (data?.position !== "up") return;
        const sd = this.sessions.get(sessionId);
        const s  = sd?.settings;
        if (!s || !s.enable_head_up_display) return;
        const now = Date.now(), last = this.headUpLastShown.get(sessionId) || 0;
        if (now - last < 10000) return;
        this.headUpLastShown.set(sessionId, now);

        const reading = await this.getGlucoseData(s, sessionId);
        const header  = await this.formatBase(reading, s, sessionId);

        if (!s.enable_advanced_mode) {
          this.showText(session, sessionId, header);
          this.setDisplayTimeout(sessionId, s.display_duration_ms || 4000, () => this.clearDisplay(session, sessionId));
          return;
        }
        const { tirPct } = this.updateDailyTirState(sessionId, reading.sgv, reading.date, s);
        let minMaxLine = "";
        try {
          const entries = await this.getTodayEntries(s, sessionId);
          const vals    = entries.map(e => e.mgdl).filter(Number.isFinite);
          if (vals.length) {
            const min = Math.min(...vals), max = Math.max(...vals);
            minMaxLine = s.language === "es"
              ? `Min/Max hoy: ${this.convertToDisplay(min, s.units)} / ${this.convertToDisplay(max, s.units)} ${s.units}`
              : `Min/Max today: ${this.convertToDisplay(min, s.units)} / ${this.convertToDisplay(max, s.units)} ${s.units}`;
          }
        } catch {}
        let tLine = "";
        try { const sum = await this.getRecentTreatments(s, "day", sessionId); tLine = this.formatTreatmentsLine(sum, s, sessionId); } catch {}

        if (s.show_range_bar) {
          const rangeBar = this.buildRangeBar(reading.sgv, s);
          this.showText(session, sessionId, [header, rangeBar, tLine, minMaxLine].filter(Boolean).join("\n"));
        } else if (s.show_tir_bar) {
          await this.animateTIRFill(session, sessionId, s, header, tirPct, tLine, minMaxLine);
        } else {
          this.showText(session, sessionId, [header, tLine, minMaxLine].filter(Boolean).join("\n"));
        }
        this.setDisplayTimeout(sessionId, s.display_duration_ms || 4000, () => this.clearDisplay(session, sessionId));
      } catch {}
    });

    /**
     * Cambios de ajustes — SDK actual:
     *   session.events.onSettingsUpdate(handler) → recibe AppSettings[] completo
     *
     * NOTA: onAppSettingsUpdate y onSettingsChange no existen en el SDK actual
     * y se han eliminado. Si en una versión futura del SDK cambia de nuevo,
     * este es el único lugar a actualizar.
     */
    const runSettingsHandler = async () => {
      try {
        const sd = this.sessions.get(sessionId); if (!sd) return;
        const settings  = this.getUserSettings(session);
        const old       = sd.settings || {};
        const changedInterval = old.updateInterval !== settings.updateInterval;

        if (this.alertLimitsChanged(old, settings)) {
          this.alertHistory.delete(sessionId);
          this.alertLatch.delete(sessionId);
        }
        sd.settings = settings;
        this.sessions.set(sessionId, sd);
        this.locales.delete(sessionId);
        this.renderTokens.delete(sessionId);
        this.clearTransientTimers(sessionId);

        const isEs   = (settings.language || "en") === "es";
        const limits = this.getAlertLimits(settings);
        const unitIsMmol = String(settings.units || "").toLowerCase().includes("mmol");
        const limitsEcho = unitIsMmol
          ? `${mmString(limits.low)}-${mmString(limits.high)} mmol/L`
          : `${limits.low}-${limits.high} mg/dL`;

        const ecoTxt = [
          isEs ? "Ajustes guardados" : "Settings saved",
          `Units: ${settings.units} · HeadUp: ${settings.enable_head_up_display ? "ON" : "OFF"}`,
          `${isEs ? "Rango" : "Range"}: ${limitsEcho}`,
          `${isEs ? "Avanzado" : "Advanced"}: ${settings.enable_advanced_mode ? "ON" : "OFF"}`,
          `${isEs ? "Barras" : "Bars"}: ${settings.show_range_bar ? "RANGE" : (settings.show_tir_bar ? "TIR" : "OFF")}`,
        ].join("\n");

        if (this.canRender(sessionId, LAYERS.ECO)) {
          this.showTextForce(session, sessionId, ecoTxt);
          this.setDisplayTimeout(sessionId, 1500, async () => {
            try { await this.showGlucoseTemporarily(session, sessionId, settings.display_duration_ms || 4000, settings); } catch {}
          });
        } else {
          try { await this.showGlucoseTemporarily(session, sessionId, settings.display_duration_ms || 4000, settings); } catch {}
        }
        if (changedInterval) this.startNormalOperation(session, sessionId, userId, settings);
      } catch (_) {}
    };

    // Único evento de settings documentado en el SDK actual
    session?.events?.onSettingsUpdate?.(runSettingsHandler);

    // Desconexión
    session?.events?.onDisconnected?.(() => {
      this.cleanupSession(sessionId);
    });
  }

  // ─────────────────────────────── onSession ───────────────────────────────
  async onSession(session, sessionId, userId) {
    try {
      const settings = this.getUserSettings(session);

      if (!settings.nightscoutUrl) {
        const msg = {
          en: "Please configure\nNightscout URL in settings",
          es: "Configura la URL\nde Nightscout en ajustes",
        };
        this.showText(session, sessionId, msg[settings.language || "en"]);
        // No guardamos sesión — sin URL no hay nada que hacer
        return;
      }

      this.sessions.set(sessionId, {
        session, userId, settings,
        timers: { display: null, update: null, animation: null, settings: null },
      });
      this.setupEventHandlers(session, sessionId, userId);

      // Texto de bienvenida (el SDK actual no documenta métodos de imagen)
      const lang    = settings.language || "en";
      const welcome = lang === "es" ? "Cargando glucosa..." : "Loading glucose...";
      this.showText(session, sessionId, welcome);

      await this.showGlucoseTemporarily(session, sessionId, settings.display_duration_ms || 5000, settings);
      this.startNormalOperation(session, sessionId, userId, settings);
    } catch (_) {
      this.showText(session, sessionId, "Error: check settings");
      this.setDisplayTimeout(sessionId, 5000, () => this.clearDisplay(session, sessionId));
    }
  }
}

// ───────────────────────────────── Bootstrap ─────────────────────────────────
if (!API_KEY) {
  // Sin API key arrancamos solo el healthcheck para no romper deploys en CI/CD
  const express = require("express");
  const app     = express();
  app.get("/health", (_req, res) => res.json({
    status: "limited", reason: "NO_API_KEY", version: "v3",
    timestamp: new Date().toISOString(), activeSessions: 0,
    uptime: Math.round(process.uptime()),
  }));
  app.listen(PORT, () => console.log(`⚠️  Health-only on port ${PORT} (no API key)`));
} else {
  const server = new NightscoutMentraV3({ packageName: PKG, apiKey: API_KEY, port: PORT });

  server.app.get("/health", (_req, res) => res.json({
    status: "alive", version: "v3",
    timestamp: new Date().toISOString(),
    activeSessions: server.sessions.size,
    uptime: Math.round((Date.now() - server.startedAt) / 1000),
  }));

  const graceful = (signal) => {
    console.log(`🔄 Cleaning up... (${signal})`);
    try {
      for (const [sessionId, sd] of server.sessions) {
        try { server.clearDisplay(sd.session, sessionId); } catch {}
        server.cleanupSession(sessionId);
      }
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => graceful("SIGTERM"));
  process.on("SIGINT",  () => graceful("SIGINT"));
  process.on("uncaughtException",  (err)    => console.error("[uncaughtException]",  err?.stack || err));
  process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

  server.start()
    .then(() => console.log(`🚀 Nightscout MentraOS v3 — port ${PORT}`))
    .catch((err) => { console.error("⛔ Error starting:", err); process.exit(1); });
}
