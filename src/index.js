"use strict";
/**
 * Nightscout MentraOS — build retro (text-only alerts)
 * - ALERTAS: solo texto animado (sin bitmaps de alarma)
 * - Boot bitmap opcional (syringes_shield_526x100.bmp) se mantiene
 * - HUD con predicción breve + TIR + tratamientos
 * - Limpieza robusta del display para que no quede texto fijo
 * - Polyfill global para updateSettingsForTesting (evita error en Render)
 *
 * CHANGELOG 2025-08-21:
 * - Eliminado cualquier uso de `clearView()` para evitar el mensaje
 *   "Unknown layout type: clear_wiew" en las gafas.
 * - Sustituido por limpiezas con `showTextWall("")` y secuencias con \u200B.
 */

require("dotenv").config();
const { AppServer } = require("@mentra/sdk");
const axios = require("axios");
// --- parche directo al prototipo de AppSession ---
try {
  const { AppSession } = require("@mentra/sdk");
  if (AppSession && !AppSession.prototype.updateSettingsForTesting) {
    AppSession.prototype.updateSettingsForTesting = async function () {
      this.logger?.debug?.("Global shim(prototype): updateSettingsForTesting noop");
      return;
    };
  }
} catch (err) {
  console.warn("No se pudo aplicar shim global a AppSession", err);
}

const path = require("path");
const fs = require("fs");
// --- EMERGENCY HOTFIX: evita TypeError aunque el SDK cree otro tipo de "session"
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async function (_settings) {
      // No-op global para builds antiguas/internas del SDK
      try { this?.logger?.debug?.('global no-op updateSettingsForTesting'); } catch {}
      return;
    },
    enumerable: false,   // no ensucia for..in
    configurable: true,  // podrás quitarlo cuando el SDK lo arregle
    writable: true
  });
}
/* --- Global shim #2: ensure session.disconnect exists (no-op on some builds) --- */
try {
  const mentra = require("@mentra/sdk");
  const AppSession =
    (mentra && (mentra.AppSession || mentra.Session || (mentra.default && mentra.default.AppSession))) || null;

  if (AppSession && typeof AppSession.prototype.disconnect !== "function") {
    AppSession.prototype.disconnect = async function (code = 1000, reason = "noop") {
      this.logger?.debug?.("Global shim(prototype): session.disconnect noop", { code, reason });
      return;
    };
  }
} catch (e) {
  console.warn("Shim(AppSession.disconnect) not applied:", e?.message);
}
/* ---------- Bitmaps ---------- */
const BITMAPS_DIR = path.join(process.cwd(), "assets", "bitmaps");
const BMP_ALIAS_TO_FILE = {
  boot: "syringes_shield_526x100.bmp", // solo mantenemos el de arranque
};
function getBitmapLocationByAlias(alias) {
  const file = BMP_ALIAS_TO_FILE[alias];
  if (!file) return null;
  return path.join(BITMAPS_DIR, file);
}
function isLikelyBmp(location) {
  try {
    const fd = fs.openSync(location, "r");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x42 && buf[1] === 0x4d;
  } catch (e) { return false; }
}
async function showBitmapByLocation(session, location, { durationMs = 3000 } = {}) {
  if (!location) return false;
  try {
    if (!isLikelyBmp(location)) throw new Error("firma BM no encontrada");

    const b64 = fs.readFileSync(location).toString("base64");

    // En lugar de clearView(), limpiamos con showTextWall para evitar "clear_wiew"
    try {
      session?.layouts?.showTextWall?.("");    // blank
      session?.layouts?.showTextWall?.("\u200B"); // zero-width (fuerza refresco)
    } catch (e) {}

    if (session?.layouts?.showBitmapView) {
      session.layouts.showBitmapView(b64, { durationMs });
    } else if (session?.showBitmap) {
      session.showBitmap(b64, { durationMs });
    } else {
      session?.layouts?.showTextWall?.("[icon]");
    }
    return true;
  } catch (e) {
    try { session?.layouts?.showTextWall?.("(bitmap error)"); } catch (ee) {}
    return false;
  }
}

/* ---------- Config ---------- */
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;
if (!MENTRAOS_API_KEY) {
  console.error("⛔ MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}
const UNITS = { MGDL: "mg/dL", MMOL: "mmol/L" };
// Capas: ECO(0) < HUD(1) < BOOT(2) < ALERT(3)
const RENDER_LAYERS = { ECO: 0, HUD: 1, BOOT: 2, ALERT: 3 };

/* =================================================================== */

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    // Estados
    this.activeSessions = new Map();
    this.displayTimers = new Map();
    this.headUpLastShown = new Map();

    this.alertHistory = new Map();   // sessionId -> ts último alert
    this.alertLatch = new Map();     // 'low'|'high'|null

    this._http = new Map();          // axios por sesión
    this._sessionLocale = new Map();
    this._lastShownText = new Map();
    this._lastEcoAt = new Map();
    this._renderToken = new Map();   // animaciones

    this.lastGoodEntry = new Map();
    this.dailyTirState = new Map();  // {dayStr,total,inRange}

    this._settingsDebounce = new Map();

    // Control de capas / bloqueo temporal
    this._renderHoldUntil = new Map();
    this._renderLayer = new Map();
  }

  /* ---------- helpers base ---------- */
  __delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
  __clamp01(x){ return x<0?0:x>1?1:x; }
  __easeInOutCubic(t){ return t<0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
  __getEasingFunction(type){
    if (type === "smooth") return (t)=> t*t*(3-2*t);
    if (type === "linear") return (t)=> t;
    return (t)=> this.__easeInOutCubic(t);
  }
  __barFromRatio(r, slots){
    const n = Math.round(this.__clamp01(r)*slots);
    return `[${"¦".repeat(n)}${"·".repeat(Math.max(0,slots-n))}]`;
  }
  toBool(x){ return (x===true||x==="true"||x===1||x==="1"); }
  parseSlicerValue(val, fb){ const n=(typeof val==="object"&&val!==null)?parseFloat(val.value):parseFloat(val); return Number.isFinite(n)?n:fb; }
  validateSlicerValue(val,min,max,fb){ const v=this.parseSlicerValue(val,fb); return Number.isFinite(v)?Math.max(min,Math.min(max,v)):fb; }
  normalizeMmol(x){ const v=this.parseSlicerValue(x,null); return (v!==null&&Number.isFinite(v))?(v>=30? v/10 : v):null; }

  /* ---------- capas ---------- */
  _canRender(sessionId, layer){
    const hold=this._renderHoldUntil.get(sessionId)||0;
    if (Date.now()<hold) return false;
    const current=this._renderLayer.get(sessionId);
    if (current==null || current<=RENDER_LAYERS.HUD) return true;
    return layer>=current;
  }
  _beginOverlay(sessionId, layer, durationMs){
    const until=Date.now()+(durationMs||0);
    this._renderLayer.set(sessionId, layer);
    this._renderHoldUntil.set(sessionId, until+100);
  }
  _endOverlay(session, sessionId){
    try{ this.hideDisplay(session, sessionId); } catch(e){}
    this._renderLayer.set(sessionId, RENDER_LAYERS.HUD);
    this._renderHoldUntil.set(sessionId, 0);
  }

  /* ---------- limpieza vista ---------- */
  _safeClearView(session){
    // IMPORTANTE: NO usar clearView() para evitar "Unknown layout type: clear_wiew"
    try { session?.layouts?.showTextWall?.(""); } catch(e) {}
    try { session?.layouts?.showTextWall?.("\u200B"); } catch(e) {}
    try { session?.layouts?.showTextWall?.(""); } catch(e) {}
  }

  showOverlayText(session, sessionId, text){
    // Se usa en ALERT/BOOT para no bloquear por _canRender
    try{
      const out=String(text||"");
      this._lastShownText.set(sessionId, out);
      session?.layouts?.showTextWall?.(out);
    }catch(e){}
  }

  showClamped(session, sessionId, text, maxLines=5){
    try{
      if (!this._canRender(sessionId, RENDER_LAYERS.HUD)) return;
      const lines=String(text||"").replace(/\r/g,"").split("\n");
      while(lines.length && lines[0].trim()==="") lines.shift();
      while(lines.length && lines[lines.length-1].trim()==="") lines.pop();
      const out=lines.slice(0,maxLines).join("\n");
      const last=this._lastShownText.get(sessionId);
      if (last===out) return;
      this._lastShownText.set(sessionId, out);
      session?.layouts?.showTextWall?.(out);
    }catch(e){}
  }

  hideDisplay(session, sessionId){
    try{
      this._safeClearView(session);
      setTimeout(()=>{ try{ this._safeClearView(session); }catch(e){} },50);
      setTimeout(()=>{ try{ this._safeClearView(session); }catch(e){} },120);
      this._lastShownText.delete(sessionId);
      this._renderLayer.set(sessionId, RENDER_LAYERS.HUD);
      this._renderHoldUntil.set(sessionId, 0);
    }catch(e){}
  }
  _scheduleHide(sessionId, ms){
    try{
      if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
      const t=setTimeout(()=> this.hideDisplay(this.activeSessions.get(sessionId)?.session, sessionId), ms);
      this.displayTimers.set(sessionId, t);
    }catch(e){}
  }

  /* ---------- i18n/timezone ---------- */
  getLanguageSettings(settings){
    const map={ es:{locale:"es-ES", timezone:"Europe/Madrid"}, en:{locale:"en-US", timezone:"America/New_York"} };
    return map[settings.language]||map.en;
  }
  validateTimezone(tz){
    const valid=[
      "Europe/Madrid","Atlantic/Canary","Europe/London","Europe/Paris","Europe/Berlin","Europe/Rome",
      "America/New_York","America/Chicago","America/Los_Angeles","America/Mexico_City",
      "America/Argentina/Buenos_Aires","America/Sao_Paulo","Asia/Tokyo","Australia/Sydney","UTC"
    ];
    return valid.includes(tz)? tz : "UTC";
  }
  _getLocaleBundle(sessionId, settings){
    const cached=this._sessionLocale.get(sessionId);
    if (cached && cached.lang===settings.language && cached.tz===(settings.timezone||null)) return cached;
    const lang=this.getLanguageSettings(settings);
    const tz=settings.timezone? this.validateTimezone(settings.timezone) : lang.timezone;
    const b={ lang: settings.language||"en", locale: lang.locale, tz };
    this._sessionLocale.set(sessionId,b); return b;
  }

  /* ---------- settings ---------- */
  async getUserSettings(session){
    try{
      const keys=[
        "nightscout_url","nightscout_token","update_interval",
        "low_alert_mg","high_alert_mg","low_alert_mmol","high_alert_mmol",
        "alerts_enabled","language","timezone","units",
        "enable_head_up_display",
        "display_duration_s","alert_duration_s","alert_cooldown_min",
        "show_tir_bar","show_range_bar",
        "enable_advanced_mode","advanced_mode_enabled",
        "alert_present_mode",
        "alert_hysteresis_mg","alert_hysteresis_mmol",
        "tir_low_mg","tir_high_mg","tir_low_mmol","tir_high_mmol",
        "time_in_range_low_mg","time_in_range_high_mg","time_in_range_low_mmol","time_in_range_high_mmol",
        "prediction_horizon_min","prediction_horizon_mins",
        "debug_force_alert"
      ];
      const vals=await Promise.all(keys.map(k=>session.settings.get(k)));
      const kv=Object.fromEntries(keys.map((k,i)=>[k,vals[i]]));

      const uiMin=parseInt(kv.update_interval,10);
      const ui=Number.isFinite(uiMin)? uiMin : 5;

      const displayMs = Number.isFinite(this.parseSlicerValue(kv.display_duration_s, NaN))
        ? Math.min(15, Math.max(1, this.parseSlicerValue(kv.display_duration_s))) * 1000
        : 5000;

      const alertMs = Number.isFinite(this.parseSlicerValue(kv.alert_duration_s, NaN))
        ? Math.min(60, Math.max(2, this.parseSlicerValue(kv.alert_duration_s))) * 1000
        : 15000;

      const coolMs = Number.isFinite(this.parseSlicerValue(kv.alert_cooldown_min, NaN))
        ? Math.min(60, Math.max(1, this.parseSlicerValue(kv.alert_cooldown_min))) * 60 * 1000
        : 600000;

      const showTirBar = (kv.show_tir_bar==null && kv.show_range_bar==null) ? true
        : (this.toBool(kv.show_tir_bar) || this.toBool(kv.show_range_bar));

      return {
        nightscoutUrl: String(kv.nightscout_url||"").trim(),
        nightscoutToken: String(kv.nightscout_token||"").trim(),
        updateInterval: ui,
        low_alert_mg: this.validateSlicerValue(kv.low_alert_mg, 50, 120, 70),
        high_alert_mg: this.validateSlicerValue(kv.high_alert_mg, 180, 400, 250),
        low_alert_mmol: this.normalizeMmol(kv.low_alert_mmol) ?? 3.9,
        high_alert_mmol: this.normalizeMmol(kv.high_alert_mmol) ?? 13.9,
        alertsEnabled: this.toBool(kv.alerts_enabled),
        language: kv.language || "en",
        timezone: kv.timezone || null,
        units: kv.units || UNITS.MGDL,
        enable_head_up_display: this.toBool(kv.enable_head_up_display),
        display_duration_ms: displayMs,
        alert_duration_ms: alertMs,
        alert_cooldown_ms: coolMs,
        show_tir_bar: showTirBar,
        enable_advanced_mode: this.toBool(kv.enable_advanced_mode) || this.toBool(kv.advanced_mode_enabled),
        alert_present_mode: "text", // forzamos texto
        alert_hysteresis_mg: this.validateSlicerValue(kv.alert_hysteresis_mg, 0, 50, 5),
        alert_hysteresis_mmol: this.normalizeMmol(kv.alert_hysteresis_mmol) ?? 0.3,
        tir_low_mg: this.parseSlicerValue(kv.tir_low_mg, null),
        tir_high_mg: this.parseSlicerValue(kv.tir_high_mg, null),
        tir_low_mmol: this.normalizeMmol(kv.tir_low_mmol),
        tir_high_mmol: this.normalizeMmol(kv.tir_high_mmol),
        time_in_range_low_mg: this.parseSlicerValue(kv.time_in_range_low_mg, null),
        time_in_range_high_mg: this.parseSlicerValue(kv.time_in_range_high_mg, null),
        time_in_range_low_mmol: this.normalizeMmol(kv.time_in_range_low_mmol),
        time_in_range_high_mmol: this.normalizeMmol(kv.time_in_range_high_mmol),
        prediction_horizon_min: [15,30,60].includes(Number(kv.prediction_horizon_min||kv.prediction_horizon_mins))
          ? Number(kv.prediction_horizon_min||kv.prediction_horizon_mins) : 30,
        debug_force_alert: (typeof kv.debug_force_alert==="string" ? kv.debug_force_alert : null),
      };
    }catch(e){
      return {
        nightscoutUrl:"", nightscoutToken:"",
        updateInterval:5,
        low_alert_mg:70, high_alert_mg:250,
        low_alert_mmol:3.9, high_alert_mmol:13.9,
        alertsEnabled:true, language:"en", timezone:null, units:UNITS.MGDL,
        enable_head_up_display:false,
        display_duration_ms:5000, alert_duration_ms:15000, alert_cooldown_ms:600000,
        show_tir_bar:true,
        enable_advanced_mode:false,
        alert_present_mode:"text",
        alert_hysteresis_mg:5, alert_hysteresis_mmol:0.3,
        prediction_horizon_min:30,
        debug_force_alert:null
      };
    }
  }

  parseSettingsFromArray(arr){
    const o={}; (arr||[]).forEach(s=>o[s.key]=s.value);
    const uiMin=parseInt(o.update_interval,10);
    const ui=Number.isFinite(uiMin)? uiMin : 5;

    const displayMs = Number.isFinite(this.parseSlicerValue(o.display_duration_s, NaN))
      ? Math.min(15, Math.max(1, this.parseSlicerValue(o.display_duration_s))) * 1000
      : 5000;

    const alertMs = Number.isFinite(this.parseSlicerValue(o.alert_duration_s, NaN))
      ? Math.min(60, Math.max(2, this.parseSlicerValue(o.alert_duration_s))) * 1000
      : 15000;

    const coolMs = Number.isFinite(this.parseSlicerValue(o.alert_cooldown_min, NaN))
      ? Math.min(60, Math.max(1, this.parseSlicerValue(o.alert_cooldown_min))) * 60 * 1000
      : 600000;

    const showTirBar = (o.show_tir_bar==null && o.show_range_bar==null) ? true
      : (this.toBool(o.show_tir_bar) || this.toBool(o.show_range_bar));

    return {
      nightscoutUrl: String(o.nightscout_url||"").trim(),
      nightscoutToken: String(o.nightscout_token||"").trim(),
      updateInterval: ui,
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 50, 120, 70),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, 250),
      low_alert_mmol: this.normalizeMmol(o.low_alert_mmol) ?? 3.9,
      high_alert_mmol: this.normalizeMmol(o.high_alert_mmol) ?? 13.9,
      alertsEnabled: this.toBool(o.alerts_enabled),
      language: o.language || "en",
      timezone: o.timezone || null,
      units: o.units || UNITS.MGDL,
      enable_head_up_display: this.toBool(o.enable_head_up_display),
      display_duration_ms: displayMs,
      alert_duration_ms: alertMs,
      alert_cooldown_ms: coolMs,
      show_tir_bar: showTirBar,
      enable_advanced_mode: this.toBool(o.enable_advanced_mode) || this.toBool(o.advanced_mode_enabled),
      alert_present_mode: "text",
      alert_hysteresis_mg: this.validateSlicerValue(o.alert_hysteresis_mg, 0, 50, 5),
      alert_hysteresis_mmol: this.normalizeMmol(o.alert_hysteresis_mmol) ?? 0.3,
      tir_low_mg: this.parseSlicerValue(o.tir_low_mg, null),
      tir_high_mg: this.parseSlicerValue(o.tir_high_mg, null),
      tir_low_mmol: this.normalizeMmol(o.tir_low_mmol),
      tir_high_mmol: this.normalizeMmol(o.tir_high_mmol),
      time_in_range_low_mg: this.parseSlicerValue(o.time_in_range_low_mg, null),
      time_in_range_high_mg: this.parseSlicerValue(o.time_in_range_high_mg, null),
      time_in_range_low_mmol: this.normalizeMmol(o.time_in_range_low_mmol),
      time_in_range_high_mmol: this.normalizeMmol(o.time_in_range_high_mmol),
      prediction_horizon_min: [15,30,60].includes(Number(o.prediction_horizon_min||o.prediction_horizon_mins))
        ? Number(o.prediction_horizon_min||o.prediction_horizon_mins) : 30,
      debug_force_alert: (typeof o.debug_force_alert==="string" ? o.debug_force_alert : null)
    };
  }

  /* ---------- HTTP ---------- */
  _ensureHttp(sessionId, settings){
    let cli=this._http.get(sessionId);
    const baseRaw=(settings.nightscoutUrl||"").trim();
    if (!baseRaw) return null;
    const base=baseRaw.startsWith("http")? baseRaw : ("https://" + baseRaw);
    const baseURL=base.endsWith("/")? base.slice(0,-1) : base;
    const params=settings.nightscoutToken? { token: settings.nightscoutToken } : {};
    if (!cli || cli.defaults.baseURL!==baseURL || JSON.stringify(cli.defaults.params||{})!==JSON.stringify(params)){
      cli=axios.create({ baseURL, headers:{ "User-Agent":"MentraOS-Nightscout/retro" }, timeout:10000, params });
      this._http.set(sessionId, cli);
    }
    return cli;
  }

  /* ---------- límites & histéresis ---------- */
  getAlertLimits(settings){
    const units=String(settings.units||"").toLowerCase();
    const lowMg=this.parseSlicerValue(settings.low_alert_mg, NaN);
    const highMg=this.parseSlicerValue(settings.high_alert_mg, NaN);
    const lowM=this.normalizeMmol(settings.low_alert_mmol);
    const highM=this.normalizeMmol(settings.high_alert_mmol);
    const mgOK=Number.isFinite(lowMg)&&Number.isFinite(highMg);
    const mmOK=Number.isFinite(lowM)&&Number.isFinite(highM);
    if (units.includes("mmol")){
      if (mmOK) return { low:Math.round(lowM*18), high:Math.round(highM*18) };
      if (mgOK) return { low:Math.round(lowMg), high:Math.round(highMg) };
      return { low:Math.round(3.9*18), high:Math.round(13.9*18) };
    }else{
      if (mgOK) return { low:Math.round(lowMg), high:Math.round(highMg) };
      if (mmOK) return { low:Math.round(lowM*18), high:Math.round(highM*18) };
      return { low:70, high:250 };
    }
  }
  getHysteresisMg(settings){
    const mg=this.validateSlicerValue(settings.alert_hysteresis_mg, 0, 50, NaN);
    const raw=this.parseSlicerValue(settings.alert_hysteresis_mmol, NaN);
    let mmol=NaN;
    if (Number.isFinite(raw)){
      if (Number.isInteger(raw)){
        if (raw>=0 && raw<=10) mmol=raw/10;
        else if (raw>=30) mmol=raw/10;
        else mmol=raw;
      } else mmol=raw;
    }
    const mmolAsMg=Number.isFinite(mmol)? Math.round(mmol*18):NaN;
    const units=String(settings.units||"").toLowerCase();
    if (units.includes("mmol")){
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
      if (Number.isFinite(mg)) return mg;
      return 5;
    }else{
      if (Number.isFinite(mg)) return mg;
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
      return 5;
    }
  }

  /* ---------- display helpers ---------- */
  convertToDisplay(mgdlValue, unit){ return unit===UNITS.MMOL? (mgdlValue/18).toFixed(1) : Math.round(mgdlValue); }
  getTrendArrow(dir){
    const map={ DoubleUp:"↑↑", SingleUp:"↑", FortyFiveUp:"↗", Flat:"→", FortyFiveDown:"↘", SingleDown:"↓", DoubleDown:"↓↓", NONE:"-", "NOT COMPUTABLE":"?" };
    return map[dir]||"?";
  }
  async formatForG1(data, settings, sessionId){
    const display=this.convertToDisplay(data.sgv, settings.units||UNITS.MGDL);
    const trend=this.getTrendArrow(data.direction);
    const b=this._getLocaleBundle(sessionId||"default", settings);
    const t=new Date(data.date);
    const timeStr=t.toLocaleTimeString(b.locale, {timeZone:b.tz, hour:"2-digit", minute:"2-digit", hour12:false});
    const minutesAgo=Math.floor((Date.now()-data.date)/60000);
    const timeAgo= minutesAgo<=1 ? (b.lang==="es"?"ahora":"now") : (b.lang==="es"?`hace ${minutesAgo}m`:`${minutesAgo}m ago`);
    return `${display} ${settings.units||UNITS.MGDL} ${trend}\n${timeStr} (${timeAgo})`;
  }
  async formatForG1WithPrediction(data, settings, sessionId){
    try{
      const base=await this.formatForG1(data, settings, sessionId);
      const predShort = settings.enable_advanced_mode
        ? await this.buildPredictionShort(settings, sessionId, null, null)
        : await this.buildPredictionShort(settings, sessionId, 60, 180);
      if (!predShort) return base;
      const parts=base.split("\n");
      const l1=parts[0]||"", l2=(parts[1]||"");
      const rest=parts.slice(2);
      return `${l1}\n${l2} · ${predShort}${rest.length? `\n${rest.join("\n")}`:""}`;
    }catch(e){ return await this.formatForG1(data, settings, sessionId); }
  }

  /* ---------- predicción breve ---------- */
  _ensureHttpOrNull(sessionId,settings){ try{ return this._ensureHttp(sessionId,settings); }catch(e){ return null; } }
  async buildPredictionShort(settings, sessionId="default", lowOverrideMg=null, highOverrideMg=null){
    const lim=this.getAlertLimits(settings);
    const lowT=Number.isFinite(lowOverrideMg)? lowOverrideMg : lim.low;
    const highT=Number.isFinite(highOverrideMg)? highOverrideMg : lim.high;
    const horizon=Math.max(10, Number(settings.prediction_horizon_min||30));
    const maxSteps=Math.max(3, Math.min(12, Math.round(horizon/5)));
    const isMmol=String(settings.units||"").toLowerCase().includes("mmol");
    const toDisp=(mg)=> isMmol? (mg/18).toFixed(1) : String(Math.round(mg));
    const http=this._ensureHttpOrNull(sessionId, settings);
    if (!http) return null;

    // 1) devicestatus
    try{
      const {data}=await http.get(`/api/v1/devicestatus.json?count=1`);
      const ds=Array.isArray(data)? data[0]:data;
      const predBGs = ds && (ds.predBGs || ds?.openaps?.suggested?.predBGs || ds?.ar2?.predBGs);
      if (predBGs){
        let series = predBGs.IOB || predBGs.COB || predBGs.UAM || predBGs.ZT || (Array.isArray(predBGs)? predBGs : null);
        if (Array.isArray(series)&&series.length>1){
          series=series.slice(0,maxSteps+1);
          const current=Number(series[0]);
          if (Number.isFinite(current)){
            if (current>lowT){
              for (let i=1;i<series.length;i++){ if (Number(series[i])<=lowT) return `↓${toDisp(lowT)} @${i*5}m`; }
            }
            if (current<highT){
              for (let i=1;i<series.length;i++){ if (Number(series[i])>=highT) return `↑${toDisp(highT)} @${i*5}m`; }
            }
          }
        }
      }
    }catch(e){}

    // 2) fallback lineal
    try{
      const {data}=await http.get(`/api/v1/entries.json?count=2`);
      if (data && data.length>=2){
        const last=data[0], prev=data[1];
        const mgNow=Number(last.sgv ?? last.glucose);
        const tNow=new Date(last.date||last.dateString).getTime();
        const mgPrev=Number(prev.sgv ?? prev.glucose);
        const tPrev=new Date(prev.date||prev.dateString).getTime();
        if (Number.isFinite(mgNow)&&Number.isFinite(mgPrev)&&tNow>tPrev){
          const deltaMin=(tNow-tPrev)/60000; if (deltaMin>0){
            const rate=(mgNow-mgPrev)/deltaMin;
            if (rate<-0.4){ const tt=(lowT-mgNow)/rate; if (tt>0&&tt<=horizon) return `↓${toDisp(lowT)} @${Math.round(tt)}m`; }
            if (rate> 0.4){ const tt=(highT-mgNow)/rate; if (tt>0&&tt<=horizon) return `↑${toDisp(highT)} @${Math.round(tt)}m`; }
          }
        }
      }
    }catch(e){}
    return null;
  }

  /* ---------- TIR + tratamientos ---------- */
  getLocalDayStr(ts, settings, sessionId="default"){
    const b=this._getLocaleBundle(sessionId, settings);
    return new Date(ts).toLocaleDateString(b.locale, {timeZone:b.tz});
  }
  buildTirBar(tirPct){ if (tirPct==null || !Number.isFinite(tirPct)) return ""; const blocks=Math.max(0,Math.min(20, Math.floor(tirPct/5))); return "¦".repeat(blocks); }
  composeTirLines(settings, tirLine, bar, tLine){
    const labelBar = `${tirLine}${bar? " "+bar:""}`;
    try{
      let clean=(tLine||"")
        .replace(/^\s*CH\/Ins hoy:\s*/,"")
        .replace(/^\s*Carbs\/Ins today:\s*/,"")
        .replace(/\s*[·•]\s*(Last|Últ):[\s\S]*$/i,"")
        .replace(/\s*Last:[\s\S]*$/i,"")
        .replace(/\s*Últ:[\s\S]*$/i,"")
        .replace(/\s*\/\s*/g,"/")
        .replace(/\s+/g," ")
        .trim();
      return clean? `${labelBar}\n${clean}` : labelBar;
    }catch(e){ return labelBar; }
  }
  updateDailyTirState(sessionId, readingMgdl, readingTs, settings){
    const range=this.getAlertLimits(settings);
    const dayStr=this.getLocalDayStr(readingTs, settings, sessionId);
    let st=this.dailyTirState.get(sessionId);
    if (!st || st.dayStr!==dayStr) st={ dayStr, total:0, inRange:0 };
    if (Number.isFinite(readingMgdl)){
      st.total += 1;
      if (readingMgdl>=range.low && readingMgdl<=range.high) st.inRange += 1;
    }
    this.dailyTirState.set(sessionId, st);
    return { tirPct: st.total>0? Math.round((st.inRange/st.total)*100) : null, total: st.total };
  }
  async getRecentTreatments(settings, hours="day", sessionId="default"){
    try{
      const http=this._ensureHttp(sessionId, settings);
      if (!http) return null;
      const {data}=await http.get(`/api/v1/treatments.json?count=1000`);
      const arr=Array.isArray(data)? data : (data? [data] : []);
      const b=this._getLocaleBundle(sessionId, settings);
      const todayStr=new Date().toLocaleDateString(b.locale, {timeZone:b.tz});
      const events=arr.map(t=>{
        const dateStr=t.created_at||t.timestamp||t.dateString||t.date||null;
        let ts=null;
        if (typeof dateStr==="number") ts=dateStr;
        else if (typeof dateStr==="string") ts=Date.parse(dateStr);
        return { ts, carbs:Number(t.carbs), insulin:Number(t.insulin) };
      }).filter(e=> e.ts && (Number.isFinite(e.carbs)||Number.isFinite(e.insulin)));
      let windowed,label;
      if (hours==="day"){
        windowed=events.filter(e=> new Date(e.ts).toLocaleDateString(b.locale,{timeZone:b.tz})===todayStr);
        label=(settings.language||"en")==="es" ? "hoy" : "today";
      }else{
        const since=Date.now()-Math.max(1,hours)*60*60*1000;
        windowed=events.filter(e=> e.ts>=since);
        label = `${hours}h`;
      }
      if (!windowed.length) return { label, totalCarbs:0, totalInsulin:0, last:null };
      let totalCarbs=0,totalInsulin=0,last=null;
      for (const e of windowed){
        if (Number.isFinite(e.carbs)) totalCarbs+=e.carbs;
        if (Number.isFinite(e.insulin)) totalInsulin+=e.insulin;
        if (!last || e.ts>last.ts) last=e;
      }
      return { label, totalCarbs, totalInsulin, last };
    }catch(e){ return null; }
  }
  formatTreatmentsLine(summary, settings, sessionId="default"){
    if (!summary) return "";
    const {label,totalCarbs,totalInsulin,last}=summary;
    const lang=settings.language||"en";
    const r1=x=> Number.isFinite(x)? Math.round(x*10)/10 : 0;
    const c=r1(totalCarbs), i=r1(totalInsulin);
    let lastStr="";
    if (last && (Number.isFinite(last.carbs)||Number.isFinite(last.insulin))){
      const b=this._getLocaleBundle(sessionId, settings);
      const t=new Date(last.ts).toLocaleTimeString(b.locale, {timeZone:b.tz, hour:"2-digit", minute:"2-digit", hour12:false});
      const parts=[]; if (Number.isFinite(last.carbs)) parts.push(`${r1(last.carbs)}g`); if (Number.isFinite(last.insulin)) parts.push(`${r1(last.insulin)}U`);
      lastStr = parts.length ? (lang==="es"? ` · Últ: ${parts.join(", ")} ${t}` : ` · Last: ${parts.join(", ")} ${t}`) : "";
    }
    return lang==="es"
      ? (label==="hoy"? `CH/Ins hoy: ${c}g / ${i}U${lastStr}` : `CH/Ins ${label}: ${c}g / ${i}U${lastStr}`)
      : (label==="today"? `Carbs/Ins today: ${c}g / ${i}U${lastStr}` : `Carbs/Ins ${label}: ${c}g / ${i}U${lastStr}`);
  }

  /* ---------- datos Nightscout ---------- */
  async getTodayEntries(settings, sessionId="default"){
    const http=this._ensureHttp(sessionId, settings);
    if (!http) throw new Error("URL no configurada");
    const {data}=await http.get(`/api/v1/entries/sgv.json?count=400`);
    const arr=Array.isArray(data)? data : (data? [data]:[]);
    const b=this._getLocaleBundle(sessionId, settings);
    const todayStr=new Date().toLocaleDateString(b.locale,{timeZone:b.tz});
    const today=arr
      .map(r=>({ mgdl:Number(r.sgv ?? r.glucose), date: typeof r.date==="string"? new Date(r.date).getTime() : r.date }))
      .filter(r=> Number.isFinite(r.mgdl) && r.date)
      .filter(r=> new Date(r.date).toLocaleDateString(b.locale,{timeZone:b.tz})===todayStr)
      .sort((a,b)=> a.date-b.date);
    return today;
  }
  async getGlucoseData(settings, sessionId="default"){
    const http=this._ensureHttp(sessionId, settings);
    if (!http) throw new Error("URL no configurada");

    const endpoints=[ `/api/v1/entries/sgv.json?count=1`, `/api/v1/entries.json?count=1`, `/api/v1/entries/current.json` ];
    let lastError;
    for (const endpoint of endpoints){
      try{
        const {data}=await http.get(endpoint);
        const reading=Array.isArray(data)? data[0]:data;
        if (!reading) throw new Error("Empty response");
        const glucose=Number(reading.sgv ?? reading.glucose);
        if (!Number.isFinite(glucose)) throw new Error("No glucose data found");
        const dateValue=reading.date||reading.dateString||reading.sysTime;
        if (!dateValue) throw new Error("No date found");
        return { sgv:glucose, date: typeof dateValue==="string"? new Date(dateValue).getTime() : dateValue, direction: reading.direction||reading.trend||"NONE" };
      }catch(e){ lastError=e; continue; }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message||"unknown"}`);
  }

  /* ---------- ECO/ALERT ---------- */
  getAlarmEchoState(sessionId, mgdl, settings){
    const lim=this.getAlertLimits(settings);
    const latched=this.alertLatch.get(sessionId)||null;
    if (latched==="low"||latched==="high") return latched;
    if (!Number.isFinite(mgdl)) return "none";
    if (mgdl<=lim.low) return "low";
    if (mgdl>=lim.high) return "high";
    return "none";
  }

  async triggerTextAlert(session, sessionId, data, settings, type){
    // ALERTA SOLO TEXTO (retro): parpadeo
    const displayValue=this.convertToDisplay(data.sgv, settings.units||UNITS.MGDL);
    const unit=settings.units||UNITS.MGDL;
    const lang=settings.language||"en";
    const msgs={ en:{low:`LOW GLUCOSE!`,high:`HIGH GLUCOSE!`}, es:{low:`¡GLUCOSA BAJA!`, high:`¡GLUCOSA ALTA!`} };
    const baseText=`${msgs[lang][type]}\n${displayValue} ${unit}`;
    const alertDuration=settings.alert_duration_ms||15000;

    this._beginOverlay(sessionId, RENDER_LAYERS.ALERT, alertDuration);

    const blink=650, start=Date.now();
    const timer=setInterval(()=>{
      if (Date.now()-start>alertDuration){
        clearInterval(timer); this._endOverlay(session, sessionId); return;
      }
      const on=Math.floor((Date.now()-start)/blink)%2===0;
      this.showOverlayText(session, sessionId, `${on?"[!!]":"[  ]"} ${baseText}`);
    }, blink);
    this.displayTimers.set(sessionId, setTimeout(()=>{ try{clearInterval(timer);}catch(e){} this._endOverlay(session, sessionId); }, alertDuration+120));

    // al finalizar, enseñar HUD breve
    setTimeout(async ()=>{ try{ await this.showGlucoseTemporarily(session, sessionId, (settings.display_duration_ms||5000), settings); }catch(e){} }, alertDuration+180);
  }

  alertLimitsChanged(oldS, newS){
    if (!oldS) return false;
    return (
      oldS.low_alert_mg!==newS.low_alert_mg ||
      oldS.high_alert_mg!==newS.high_alert_mg ||
      oldS.low_alert_mmol!==newS.low_alert_mmol ||
      oldS.high_alert_mmol!==newS.high_alert_mmol ||
      oldS.units!==newS.units ||
      oldS.alert_hysteresis_mg!==newS.alert_hysteresis_mg ||
      oldS.alert_hysteresis_mmol!==newS.alert_hysteresis_mmol
    );
  }

  async checkAlerts(session, sessionId, data, settings){
    const limits=this.getAlertLimits(settings);
    const mgdl=data.sgv;
    const cooldown=settings.alert_cooldown_ms||600000;
    const lastAlertTs=this.alertHistory.get(sessionId);
    const latch=this.alertLatch.get(sessionId)||null;
    const h=this.getHysteresisMg(settings);

    // Rearme por histéresis
    if (latch==="low" && mgdl>=(limits.low+h)) this.alertLatch.set(sessionId,null);
    else if (latch==="high" && mgdl<=(limits.high-h)) this.alertLatch.set(sessionId,null);

    // Si sigue latcheado, no relanzar
    if (this.alertLatch.get(sessionId)) return;

    // Cooldown
    if (lastAlertTs && Date.now()-lastAlertTs<cooldown) return;

    const dbg=(settings.debug_force_alert||"").toLowerCase();
    let alertType=null;
    if (mgdl<=limits.low || dbg==="low") alertType="low";
    else if (mgdl>=limits.high || dbg==="high") alertType="high";

    if (alertType){
      this.alertHistory.set(sessionId, Date.now());
      this.alertLatch.set(sessionId, alertType);
      await this.triggerTextAlert(session, sessionId, data, settings, alertType);
      session?.logger?.warn?.("Alert sent",{type:alertType, value:mgdl});
    }
  }

  /* ---------- animación TIR ---------- */
  async animateTIRFill(session, sessionId, s, headerText, tirPct, tLine="", extraLine=""){
    try{
      const showBar=!!s.show_tir_bar;
      const anims=s.enable_animations!==false;

      if (!showBar || !anims || tirPct==null || !Number.isFinite(tirPct)){
        const bar= showBar && tirPct!=null ? " "+this.__barFromRatio(tirPct/100,20) : "";
        const tirLine = tirPct==null ? (s.language==="es"?"TIR hoy: n/d":"TIR: n/a") : (s.language==="es"?`TIR hoy: ${tirPct}%`:`TIR: ${tirPct}%`);
        const line2=`${tirLine}${bar}` + (tLine? `\n${tLine}`:"");
        const out= extraLine? `${headerText}\n${line2}\n${extraLine}` : `${headerText}\n${line2}`;
        this.showClamped(session, sessionId, out);
        return;
      }

      const token=(this._renderToken.get(sessionId)||0)+1;
      this._renderToken.set(sessionId, token);

      const slots=20, leadIn=220, totalMs=920;
      const target=Math.floor(this.__clamp01(tirPct/100)*slots);
      const tirLine=(s.language==="es"?`TIR hoy: ${tirPct}%`:`TIR: ${tirPct}%`);
      const base=(filled)=> `${headerText}\n${tirLine} ${this.__barFromRatio(filled/slots,slots)}${tLine?`\n${tLine}`:""}${extraLine?`\n${extraLine}`:""}`;

      this.showClamped(session, sessionId, base(0));
      if (leadIn>0){
        const t0=Date.now();
        while(Date.now()-t0<leadIn){
          if (this._renderToken.get(sessionId)!==token) return;
          await this.__delay(30);
        }
      }

      const ease=this.__getEasingFunction(String(s.animation_type||"cubic"));
      const tStart=Date.now(); let last=-1;
      while(true){
        if (this._renderToken.get(sessionId)!==token) return;
        const t=(Date.now()-tStart)/totalMs;
        const clamped=Math.max(0,Math.min(1,t));
        const filled=Math.min(target, Math.floor(ease(clamped)*target));
        if (filled!==last){ this.showClamped(session, sessionId, base(filled)); last=filled; }
        if (clamped>=1) break;
        await this.__delay(33);
      }
      this.showClamped(session, sessionId, base(target));
    }catch(e){
      try{
        const bar=this.__barFromRatio((tirPct||0)/100,20);
        const tirLine= tirPct==null ? (s.language==="es"?"TIR hoy: n/d":"TIR: n/a") : (s.language==="es"?`TIR hoy: ${tirPct}%`:`TIR: ${tirPct}%`);
        const line2=`${tirLine} ${bar}` + (tLine?`\n${tLine}`:"");
        const out= extraLine? `${headerText}\n${line2}\n${extraLine}` : `${headerText}\n${line2}`;
        this.showClamped(session, sessionId, out);
      }catch(ee){}
    }
  }

  /* ---------- HUD & ciclo de vida ---------- */
  async showInitialAndHide(session, sessionId, settings){
    try{
      const data=await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      const tirRes=this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      const formatted=await this.formatForG1WithPrediction(data, settings, sessionId);
      if (settings.enable_advanced_mode){
        const tirPct=tirRes.tirPct;
        const bar= !this.toBool(settings.show_tir_bar) || tirPct==null? "" : this.buildTirBar(tirPct);
        let tLine="";
        try{ const sum=await this.getRecentTreatments(settings, "day", sessionId); tLine=this.formatTreatmentsLine(sum, settings, sessionId); }catch(e){}
        await this.animateTIRFill(session, sessionId, settings, formatted, tirPct, tLine);
      }else{
        this.showClamped(session, sessionId, formatted);
      }
      this._scheduleHide(sessionId, settings.display_duration_ms||5000);
    }catch(error){
      try{
        const cached=this.lastGoodEntry.get(sessionId);
        if (cached){
          const fallback=await this.formatForG1WithPrediction(cached, settings, sessionId);
          this.showClamped(session, sessionId, fallback);
          this._scheduleHide(sessionId, settings.display_duration_ms||5000);
          return;
        }
      }catch(e){}
      const lang=(settings&&settings.language)||"en";
      const msg={ en:"Error loading glucose data\nCheck your settings", es:"Error cargando datos\nRevisa tu configuración" };
      this.showClamped(session, sessionId, msg[lang]); this._scheduleHide(sessionId, 5000);
    }
  }

  setupEventHandlers(session, sessionId, userId){
    try{
      session?.events?.onButtonPress?.(async ()=>{
        const sd=this.activeSessions.get(sessionId);
        const s=sd?.settings || await this.getUserSettings(session);
        await this.showGlucoseTemporarily(session, sessionId, s.display_duration_ms||4000, s);
      });

      const runSettingsHandler=async (settingsData)=>{
        try{
          const settings=this.parseSettingsFromArray(settingsData||[]);
          const sd=this.activeSessions.get(sessionId); if (!sd) return;
          const old=sd.settings||{};
          if (old.updateInterval!==settings.updateInterval){
            if (sd.updateInterval){ clearInterval(sd.updateInterval); sd.updateInterval=null; }
            await this.startNormalOperation(session, sessionId, userId, settings);
          }
          if (this.alertLimitsChanged(old, settings)){
            this.alertHistory.delete(sessionId);
            this.alertLatch.delete(sessionId);
          }
          sd.settings=settings; this.activeSessions.set(sessionId, sd);

          // ECO resumen
          try{
            let dNow=null;
            try{ dNow=await this.getGlucoseData(settings, sessionId); await this.checkAlerts(session, sessionId, dNow, settings); }catch(e){}
            const isEs=(settings.language||"en")==="es";
            const limits=this.getAlertLimits(settings);
            const hystMg=this.getHysteresisMg(settings);
            const hystMmol=(hystMg/18).toFixed(1);
            const alarmState=this.getAlarmEchoState(sessionId, dNow?.sgv, settings);
            const stateStr = isEs
              ? (alarmState==="low"?"Activa: BAJA":(alarmState==="high"?"Activa: ALTA":"Sin alarma"))
              : (alarmState==="low"?"Active: LOW":(alarmState==="high"?"Active: HIGH":"No alarm"));
            const unitIsMmol=String(settings.units||"").toLowerCase().includes("mmol");
            const limitsEcho= unitIsMmol ? `${(limits.low/18).toFixed(1)}-${(limits.high/18).toFixed(1)} mmol/L` : `${limits.low}-${limits.high} mg/dL`;
            const line1=isEs? "Ajustes guardados":"Settings saved";
            const line2=`Units: ${settings.units} · HeadUp: ${settings.enable_head_up_display?"ON":"OFF"}`;
            const line3=`${isEs?"Rango":"Range"}: ${limitsEcho}`;
            const line4=`${isEs?"Avanzado":"Advanced"}: ${settings.enable_advanced_mode?"ON":"OFF"}`;
            const line5=(isEs?"Alarmas":"Alerts")+`: ${settings.alertsEnabled?"ON":"OFF"} · Hyst: ±${hystMg} mg/dL (±${hystMmol} mmol/L) · ${stateStr}`;
            const ecoTxt=[line1,line2,line3,line4,line5].join("\n");

            if (this._canRender(sessionId, RENDER_LAYERS.ECO)){
              const lastEco=this._lastEcoAt.get(sessionId)||0;
              if (Date.now()-lastEco>2000){
                this._lastEcoAt.set(sessionId, Date.now());
                this.showClamped(session, sessionId, ecoTxt);
                setTimeout(()=> this.hideDisplay(session, sessionId), 2200);
              }
            }
          }catch(e){}
        }catch(error){ session?.logger?.error?.(error,"Failed to process settings update"); }
      };

      const settingsHandler=(settingsData)=>{
        try{
          if (this._settingsDebounce.has(sessionId)) clearTimeout(this._settingsDebounce.get(sessionId));
        }catch(e){}
        const t=setTimeout(()=> runSettingsHandler(settingsData), 120);
        this._settingsDebounce.set(sessionId, t);
      };

      session?.events?.onAppSettingsUpdate?.(settingsHandler);
      session?.events?.onSettingsUpdate?.(settingsHandler);
      session?.events?.onSettingsChange?.(settingsHandler);

      session?.events?.onHeadPosition?.(async (data)=>{
        try{
          if (data?.position!=="up") return;
          const sd=this.activeSessions.get(sessionId);
          const s=sd?.settings; if (!s || !s.enable_head_up_display) return;
          const now=Date.now(), last=this.headUpLastShown.get(sessionId)||0;
          if (now-last<10000) return; this.headUpLastShown.set(sessionId, now);
          const reading=await this.getGlucoseData(s, sessionId);
          const header=await this.formatForG1WithPrediction(reading, s, sessionId);
          if (!s.enable_advanced_mode){
            this.showClamped(session, sessionId, header); this._scheduleHide(sessionId, s.display_duration_ms||4000); return;
          }
          const {tirPct}=this.updateDailyTirState(sessionId, reading.sgv, reading.date, s);
          let minMaxLine="";
          try{
            const entries=await this.getTodayEntries(s, sessionId);
            const vals=entries.map(e=>e.mgdl).filter(Number.isFinite);
            if (vals.length){
              const min=Math.min(...vals), max=Math.max(...vals);
              const minDisp=this.convertToDisplay(min, s.units), maxDisp=this.convertToDisplay(max, s.units);
              minMaxLine = s.language==="es" ? `Min/Max hoy: ${minDisp} / ${maxDisp} ${s.units}` : `Min/Max today: ${minDisp} / ${maxDisp} ${s.units}`;
            }
          }catch(e){}
          let tLine=""; try{ const sum=await this.getRecentTreatments(s,"day",sessionId); tLine=this.formatTreatmentsLine(sum,s,sessionId); }catch(e){}
          await this.animateTIRFill(session, sessionId, s, header, tirPct, tLine, minMaxLine);
          this._scheduleHide(sessionId, s.display_duration_ms||4000);
        }catch(e){
          try{ this.showClamped(session, sessionId, (this._getLocaleBundle(sessionId,{language:"es"}).lang==="es"?"Error al mostrar":"Display error")); this._scheduleHide(sessionId,2000); }catch(ee){}
        }
      });

      session?.events?.onDisconnected?.(()=>{
        try{
          const t=this.displayTimers.get(sessionId); if (t) clearTimeout(t); this.displayTimers.delete(sessionId);
          const sd=this.activeSessions.get(sessionId); if (sd?.updateInterval) clearInterval(sd.updateInterval);
          this._http.delete(sessionId); this._sessionLocale.delete(sessionId);
          this.activeSessions.delete(sessionId); this.alertHistory.delete(sessionId);
          this.alertLatch.delete(sessionId); this.headUpLastShown.delete(sessionId);
          this.dailyTirState.delete(sessionId); this.lastGoodEntry.delete(sessionId);
          session?.logger?.info?.("Session disconnected");
        }catch(e){}
      });
    }catch(error){
      console.error("⚠️ Error setting up event handlers:", error);
      session?.logger?.error?.(error, "Failed to setup event handlers");
    }
  }

  async showGlucoseTemporarily(session, sessionId, ms, providedSettings){
    try{
      const sd=this.activeSessions.get(sessionId); if (!sd) return;
      const settings=providedSettings || sd.settings || await this.getUserSettings(sd.session);
      const data=await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      const {tirPct}=this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      if (settings.enable_advanced_mode){
        const header=await this.formatForG1WithPrediction(data, settings, sessionId);
        let tLine=""; try{ const sum=await this.getRecentTreatments(settings,"day",sessionId); tLine=this.formatTreatmentsLine(sum, settings, sessionId); }catch(e){}
        await this.animateTIRFill(session, sessionId, settings, header, tirPct, tLine);
      }else{
        this.showClamped(session, sessionId, await this.formatForG1WithPrediction(data, settings, sessionId));
      }
      this._scheduleHide(sessionId, ms);
    }catch(error){
      try{
        const cached=this.lastGoodEntry.get(sessionId);
        if (cached){
          const s=this.activeSessions.get(sessionId)?.settings||{};
          const txt=await this.formatForG1WithPrediction(cached, s, sessionId);
          this.showClamped(session, sessionId, txt);
          this._scheduleHide(sessionId, ms);
          return;
        }
      }catch(e){}
      session?.logger?.error?.(error,"Failed to show glucose temporarily");
    }
  }

  async startNormalOperation(session, sessionId, userId, initialSettings){
    const mins=Math.max(1, Number(initialSettings.updateInterval||5)); const ms=mins*60*1000;
    const iv=setInterval(async ()=>{
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try{
        const sd=this.activeSessions.get(sessionId);
        const s=(sd&&sd.settings)? sd.settings : await this.getUserSettings(session);
        const d=await this.getGlucoseData(s, sessionId);
        this.lastGoodEntry.set(sessionId, d);
        this.updateDailyTirState(sessionId, d.sgv, d.date, s);
        if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
      }catch(error){
        session?.logger?.debug?.("Normal operation cycle failed",{error:error.message});
      }
    }, ms);
    const sd=this.activeSessions.get(sessionId);
    if (sd){ if (sd.updateInterval) clearInterval(sd.updateInterval); sd.updateInterval=iv; this.activeSessions.set(sessionId, sd); }
  }

  async onSession(session, sessionId, userId){
    try{
      if (typeof session.updateSettingsForTesting!=="function"){
        session.updateSettingsForTesting=async ()=>{ try{ session?.logger?.debug?.("Compat shim: updateSettingsForTesting noop"); }catch(e){} };
      }
      let settings=await this.getUserSettings(session);
      if (!settings.nightscoutUrl){
        const msg={ en:"Please configure Nightscout\nURL and token in settings", es:"Configura URL y token\nde Nightscout en ajustes" };
        this.showClamped(session, sessionId, msg[settings.language||"en"]); return;
      }

      this.activeSessions.set(sessionId, { session, userId, settings, updateInterval:null });
      this.setupEventHandlers(session, sessionId, userId);

      // Mostrar bitmap de arranque (opcional)
      try{
        const loc=getBitmapLocationByAlias("boot");
        if (loc){
          this._beginOverlay(sessionId, RENDER_LAYERS.BOOT, 3000);
          await showBitmapByLocation(session, loc, {durationMs:3000});
          setTimeout(()=> this._endOverlay(session, sessionId), 3120);
        }
      }catch(e){}

      await this.showInitialAndHide(session, sessionId, settings);
      await this.startNormalOperation(session, sessionId, userId, settings);
    }catch(e){
      try{
        const lang=(typeof settings?.language==="string")? settings.language : "en";
        this.showClamped(session, sessionId, lang==="es"?"Error: revisa configuración":"Error: check settings");
      }catch(ee){}
    }
  }

  /* ---------- MIRA tool (opcional) ---------- */
  async onToolCall(data){
    const toolId=data.toolId||data.toolName;
    const userId=data.userId;
    const activeSession=data.activeSession;
    const isSpanish=["obtener_glucosa","revisar_glucosa","nivel_glucosa","mi_glucosa"].includes(toolId);
    const lang=isSpanish?"es":"en";

    let settings=null;
    try{
      if (activeSession?.settings?.settings) settings=this.parseSettingsFromArray(activeSession.settings.settings);
      else {
        for (const [,sData] of this.activeSessions){
          if (sData.userId===userId){ settings=sData.settings || await this.getUserSettings(sData.session); break; }
        }
      }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) throw new Error(lang==="es"?"Nightscout no configurado":"Nightscout not configured");
      const reading=await this.getGlucoseData(settings);
      const display=this.convertToDisplay(reading.sgv, settings.units||UNITS.MGDL);
      const trend=this.getTrendArrow(reading.direction);
      const status=this.getGlucoseStatusText(reading.sgv, settings, lang);
      const {tirPct}=this.updateDailyTirState(activeSession?.sessionId||"tool", reading.sgv, reading.date, settings);
      let extra=""; if (settings.enable_advanced_mode && Number.isFinite(tirPct)) extra = lang==="es"? ` TIR hoy: ${tirPct}%` : ` TIR: ${tirPct}%`;
      const msg= lang==="es" ? `Tu glucosa está en ${display} ${settings.units||UNITS.MGDL} ${trend}. Estado: ${status}.${extra}`
                             : `Your glucose is ${display} ${settings.units||UNITS.MGDL} ${trend}. Status: ${status}.${extra}`;
      return { success:true, data:{ glucose:display, unit:settings.units||UNITS.MGDL, trend, status, tirPct:Number.isFinite(tirPct)?tirPct:null }, message:msg };
    }catch(e){
      return { success:false, error: lang==="es"? `Error: ${e.message}`:`Error: ${e.message}` };
    }
  }
  getGlucoseStatusText(value, settings, lang){
    const limits=this.getAlertLimits(settings);
    if (value<70) return lang==="es"?"Crítico Bajo":"Critical Low";
    if (value<=limits.low) return lang==="es"?"Bajo":"Low";
    if (value>250) return lang==="es"?"Crítico Alto":"Critical High";
    if (value>=limits.high) return lang==="es"?"Alto":"High";
    return lang==="es"?"Normal":"Normal";
  }
}

/* ---------- init ---------- */
const server=new NightscoutMentraApp({ packageName:PACKAGE_NAME, apiKey:MENTRAOS_API_KEY, port:PORT });
server.start().catch(err=>{ console.error("⛔ Error iniciando servidor:", err); process.exit(1); });

// Lifecycle logs for clarity
server.on?.('stop', (info) => { console.log('[LIFECYCLE] STOP', info); });
server.on?.('start', (info) => { console.log('[LIFECYCLE] START', info); });
server.on?.('sessionClosed', (info) => { console.log('[LIFECYCLE] sessionClosed', info); });
console.log("🚀 Nightscout MentraOS — build retro (text-only alerts)");
server.app.use((req, res, next) => {
  try {
    const sess = req?.mentra?.session;
    if (sess && typeof sess.updateSettingsForTesting !== 'function') {
      sess.updateSettingsForTesting = async () => { /* no-op */ };
    }
  } catch {}
  next();
});
/* ====== Re-check periódico para sesiones activas ====== */
setInterval(() => {
  try {
    for (const [, sd] of server.activeSessions) {
      const sess = sd?.session;
      if (sess && typeof sess.updateSettingsForTesting !== "function") {
        sess.updateSettingsForTesting = async () => { /* no-op */ };
      }
    }
  } catch (e) {
    // ignorar
  }
}, 2000);

// Healthcheck + keepalive opcional
server.app.get("/health", (_,res)=> res.json({ status:"alive", timestamp:new Date().toISOString(), version:"retro", activeSessions:server.activeSessions.size }));

// Robustez global
process.on("uncaughtException",(err)=>{ try{ console.error("[uncaughtException]", err?.stack||err); }catch(e){} });
process.on("unhandledRejection",(reason)=>{ try{ console.error("[unhandledRejection]", reason); }catch(e){} });
