"use strict";
/**
 * Nightscout MentraOS v2.13
 * - Sparkline ASCII en la misma vista (sin BMP)
 * - Predicción horizon-aware 15/30/60 robusta (devicestatus → fallback lineal)
 * - Animación TIR refinada y garantizada hasta objetivo
 * - Histeresis de alertas, menos ruido
 * - Cliente HTTP por sesión + menos latencia
 * - Debounce de ajustes + gestos
 *
 * No exige cambios en consola.
 * Claves opcionales soportadas si existen:
 *  - enable_ascii_sparkline (toggle)
 *  - sparkline_minutes (number, 30 por defecto)
 *  - animation_type (select: 'linear'|'smooth'|'cubic')
 *  - enable_animations (toggle)
 *  - alert_hysteresis_mg (number, 5 por defecto)
 */

require('dotenv').config();
const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

/* ---------- SHIM: compatibilidad SDK ---------- */
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async () => {},
    writable: true, configurable: true, enumerable: false
  });
}

/* ---------- CONFIG ---------- */
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error('⛔ MENTRAOS_API_KEY is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

/* ---------- App ---------- */
class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.active = new Map();           // sessionId -> { session, userId, settings, iv }
    this.lastGoodEntry = new Map();    // sessionId -> {sgv,date,direction}
    this.dailyTir = new Map();         // sessionId -> { dayStr, total, inRange }
    this.alertState = new Map();       // sessionId -> { lastAt, lastType }
    this._http = new Map();            // sessionId -> axios instance
    this._renderToken = new Map();
    this._lastShown = new Map();
    this._hideTimers = new Map();
    this._debounce = new Map();
    this._locale = new Map();
    this._lastHeadUpAt = new Map();
  }

  /* ===== Utils ===== */
  _delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
  _clamp01(x){ return x<0?0:x>1?1:x; }
  _ease(type='cubic'){
    if (type==='linear') return t=>t;
    if (type==='smooth') return t=> t*t*(3-2*t);
    return t=> t<0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
  }
  _bar(ratio, slots=20){
    const n = Math.round(this._clamp01(ratio)*slots);
    return `[${'¦'.repeat(n)}${'·'.repeat(slots-n)}]`;
  }
  _scheduleHide(sessionId, ms, session){
    if (this._hideTimers.has(sessionId)) clearTimeout(this._hideTimers.get(sessionId));
    const t = setTimeout(()=> this.hideDisplay(session, sessionId), ms);
    this._hideTimers.set(sessionId, t);
  }
  _toBool(x){ return x===true || x==='true' || x===1 || x==='1'; }
  _parseVal(val, fb){
    const n = (typeof val==='object'&&val!==null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n)? n: fb;
  }
  _parseInt(val, fb){
    const n = (typeof val==='object'&&val!==null) ? parseInt(val.value,10) : parseInt(val,10);
    return Number.isFinite(n)? n: fb;
  }
  _normMmol(x){
    const v = this._parseVal(x, null);
    return (v!==null && Number.isFinite(v)) ? (v>=30 ? v/10 : v) : null; // UI mmol x10
  }

  /* ===== HTTP por sesión ===== */
  _httpFor(sessionId, settings){
    const raw = (settings.nightscoutUrl||'').trim();
    if (!raw) return null;
    const base = raw.startsWith('http') ? raw : ('https://'+raw);
    const baseURL = base.replace(/\/$/, '');
    let cli = this._http.get(sessionId);
    if (!cli || cli.defaults.baseURL!==baseURL || (cli.defaults.params?.token||'') !== (settings.nightscoutToken||'')){
      cli = axios.create({
        baseURL, timeout: 10000,
        headers:{'User-Agent':'MentraOS-Nightscout/2.13'},
        params: settings.nightscoutToken ? { token: settings.nightscoutToken } : {}
      });
      this._http.set(sessionId, cli);
    }
    return cli;
  }

  /* ===== Settings ===== */
  async getUserSettings(session){
    const keys = [
      'nightscout_url','nightscout_token','update_interval',
      'units','language','timezone',
      'alerts_enabled','low_alert_mg','high_alert_mg','low_alert_mmol','high_alert_mmol',
      'enable_head_up_display','display_duration_s',
      'alert_duration_s','alert_cooldown_min',
      'show_tir_bar','show_range_bar',
      // nuevas opcionales (si no están, default)
      'enable_ascii_sparkline','sparkline_minutes','animation_type','enable_animations','alert_hysteresis_mg',
      // legacy tolerados / compat
      'display_duration_ms','alert_duration_ms','alert_cooldown_ms',
      'enable_advanced_mode','advanced_mode_enabled',
      'prediction_horizon_min','prediction_horizon_mins'
    ];
    const vals = await Promise.all(keys.map(k=>session.settings.get(k)));
    const kv = Object.fromEntries(keys.map((k,i)=>[k,vals[i]]));

    const msFromS = (keyS, defS, minS, maxS, legacyKey, legacyMin, legacyMax, legacyDef) => {
      const vS = this._parseVal(kv[keyS], NaN);
      if (Number.isFinite(vS)) return Math.max(minS, Math.min(maxS, vS))*1000;
      return Math.max(legacyMin, Math.min(legacyMax, this._parseVal(kv[legacyKey], legacyDef)));
    };

    const ui = this._parseInt(kv.update_interval, 5);
    const displayMs = msFromS('display_duration_s', 5, 1, 15, 'display_duration_ms', 1000, 15000, 5000);
    const alertMs   = msFromS('alert_duration_s', 15, 2, 60, 'alert_duration_ms', 2000, 60000, 15000);
    const coolMs = (()=> {
      const vMin = this._parseVal(kv.alert_cooldown_min, NaN);
      if (Number.isFinite(vMin)) return Math.max(1, Math.min(60, vMin))*60*1000;
      return Math.max(60000, Math.min(3600000, this._parseVal(kv.alert_cooldown_ms, 600000)));
    })();

    const showTir = (kv.show_tir_bar==null && kv.show_range_bar==null)
      ? true : (this._toBool(kv.show_tir_bar) || this._toBool(kv.show_range_bar));

    return {
      nightscoutUrl: String(kv.nightscout_url||'').trim(),
      nightscoutToken: String(kv.nightscout_token||'').trim(),
      updateInterval: ui,
      units: kv.units || UNITS.MGDL,
      language: kv.language || 'en',
      timezone: kv.timezone || null,
      alertsEnabled: this._toBool(kv.alerts_enabled),
      low_alert_mg:  Math.max(50, Math.min(120, this._parseVal(kv.low_alert_mg, 70))),
      high_alert_mg: Math.max(180, Math.min(400, this._parseVal(kv.high_alert_mg, 250))),
      low_alert_mmol:  this._normMmol(kv.low_alert_mmol)  ?? 3.9,
      high_alert_mmol: this._normMmol(kv.high_alert_mmol) ?? 13.9,
      enable_head_up_display: this._toBool(kv.enable_head_up_display),
      display_duration_ms: displayMs,
      alert_duration_ms: alertMs,
      alert_cooldown_ms: coolMs,
      show_tir_bar: showTir,
      enable_advanced_mode: this._toBool(kv.enable_advanced_mode) || this._toBool(kv.advanced_mode_enabled),
      // nuevas (opcionales)
      enable_ascii_sparkline: this._toBool(kv.enable_ascii_sparkline),
      sparkline_minutes: this._parseInt(kv.sparkline_minutes, 30),
      animation_type: (kv.animation_type || 'cubic'),
      enable_animations: (kv.enable_animations == null) ? true : this._toBool(kv.enable_animations),
      alert_hysteresis_mg: this._parseVal(kv.alert_hysteresis_mg, 5),
      prediction_horizon_min: [15,30,60].includes(Number(kv.prediction_horizon_min||kv.prediction_horizon_mins))
        ? Number(kv.prediction_horizon_min||kv.prediction_horizon_mins) : 30
    };
  }

  parseSettingsFromArray(arr){
    const o = {};
    (arr||[]).forEach(s=> o[s.key]=s.value);
    const getS = (k,fb)=> (o[k]==null?fb:o[k]);
    const _toB = v => (v===true||v==='true'||v===1||v==='1');

    const msFromS = (keyS, defS, minS, maxS, legacyKey, legacyMin, legacyMax, legacyDef) => {
      const vS = this._parseVal(getS(keyS, NaN), NaN);
      if (Number.isFinite(vS)) return Math.max(minS, Math.min(maxS, vS))*1000;
      return Math.max(legacyMin, Math.min(legacyMax, this._parseVal(getS(legacyKey, legacyDef), legacyDef)));
    };

    const ui = this._parseInt(getS('update_interval', 5), 5);
    const displayMs = msFromS('display_duration_s', 5, 1, 15, 'display_duration_ms', 1000, 15000, 5000);
    const alertMs   = msFromS('alert_duration_s', 15, 2, 60, 'alert_duration_ms', 2000, 60000, 15000);
    const coolMs = (()=> {
      const vMin = this._parseVal(getS('alert_cooldown_min', NaN), NaN);
      if (Number.isFinite(vMin)) return Math.max(1, Math.min(60, vMin))*60*1000;
      return Math.max(60000, Math.min(3600000, this._parseVal(getS('alert_cooldown_ms', 600000), 600000)));
    })();

    const showTir = (getS('show_tir_bar', null)==null && getS('show_range_bar', null)==null)
      ? true : (_toB(getS('show_tir_bar', false)) || _toB(getS('show_range_bar', false)));

    return {
      nightscoutUrl: String(getS('nightscout_url','')).trim(),
      nightscoutToken: String(getS('nightscout_token','')).trim(),
      updateInterval: ui,
      units: getS('units', UNITS.MGDL),
      language: getS('language','en'),
      timezone: getS('timezone', null),
      alertsEnabled: _toB(getS('alerts_enabled', true)),
      low_alert_mg:  Math.max(50, Math.min(120, this._parseVal(getS('low_alert_mg',70), 70))),
      high_alert_mg: Math.max(180, Math.min(400, this._parseVal(getS('high_alert_mg',250), 250))),
      low_alert_mmol:  this._normMmol(getS('low_alert_mmol', 3.9)) ?? 3.9,
      high_alert_mmol: this._normMmol(getS('high_alert_mmol',13.9)) ?? 13.9,
      enable_head_up_display: _toB(getS('enable_head_up_display', true)),
      display_duration_ms: displayMs,
      alert_duration_ms: alertMs,
      alert_cooldown_ms: coolMs,
      show_tir_bar: showTir,
      enable_advanced_mode: _toB(getS('enable_advanced_mode', false)) || _toB(getS('advanced_mode_enabled', false)),
      // nuevas (opcionales)
      enable_ascii_sparkline: _toB(getS('enable_ascii_sparkline', false)),
      sparkline_minutes: this._parseInt(getS('sparkline_minutes', 30), 30),
      animation_type: (getS('animation_type', 'cubic')),
      enable_animations: (getS('enable_animations', null)==null) ? true : _toB(getS('enable_animations', true)),
      alert_hysteresis_mg: this._parseVal(getS('alert_hysteresis_mg', 5), 5),
      prediction_horizon_min: [15,30,60].includes(Number(getS('prediction_horizon_min', getS('prediction_horizon_mins', 30))))
        ? Number(getS('prediction_horizon_min', getS('prediction_horizon_mins', 30))) : 30
    };
  }

  /* ===== Límites (unidad-aware) ===== */
  getAlertLimits(settings){
    if ((settings.units||UNITS.MGDL) === UNITS.MGDL) {
      return { low: Math.round(settings.low_alert_mg), high: Math.round(settings.high_alert_mg) };
    }
    // mmol → mg/dL
    const low = Math.round((settings.low_alert_mmol ?? 3.9) * 18);
    const high = Math.round((settings.high_alert_mmol ?? 13.9) * 18);
    return { low, high };
  }

  /* ===== Locale/TZ ===== */
  _langBundle(settings){
    const prev = this._locale.get('k');
    const lang = settings.language || 'en';
    const table = { es:{locale:'es-ES', tz:'Europe/Madrid'}, en:{locale:'en-US', tz:'America/New_York'} };
    const base = table[lang] || table.en;
    const tz = settings.timezone || base.tz;
    const pack = { lang, locale: base.locale, tz };
    if (!prev || prev.lang!==lang || prev.tz!==tz) this._locale.set('k', pack);
    return pack;
  }

  /* ===== Formatos UI ===== */
  toDisplay(mgdl, unit){
    if ((unit||UNITS.MGDL)===UNITS.MMOL) return (mgdl/18).toFixed(1);
    return String(Math.round(mgdl));
  }
  trendArrow(dir){
    const m = { DoubleUp:'↑↑', SingleUp:'↑', FortyFiveUp:'↗', Flat:'→', FortyFiveDown:'↘', SingleDown:'↓', DoubleDown:'↓↓', NONE:'-', 'NOT COMPUTABLE':'?' };
    return m[dir] || '?';
  }

  async formatHeader(entry, settings){
    const { locale, tz, lang } = this._langBundle(settings);
    const val = this.toDisplay(entry.sgv, settings.units);
    const arr = this.trendArrow(entry.direction);
    const t = new Date(entry.date);
    const hhmm = t.toLocaleTimeString(locale, { timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false });
    const agoM = Math.floor((Date.now()-entry.date)/60000);
    const ago = agoM<=1 ? (lang==='es'?'ahora':'now') : (lang==='es'?`hace ${agoM}m`:`${agoM}m ago`);
    return `${val} ${settings.units} ${arr}\n${hhmm} (${ago})`;
  }

  /* ===== Sparkline ASCII (opcional, sin BMP) ===== */
  buildAsciiSparkline(pointsMgdl, units){
    if (!pointsMgdl || pointsMgdl.length<3) return '';
    const blocks = ['▁','▂','▃','▄','▅','▆','▇','█'];
    const n = Math.min(24, Math.max(6, pointsMgdl.length));
    const arr = pointsMgdl.slice(-n);
    const min = Math.min(...arr), max = Math.max(...arr);
    if (!(Number.isFinite(min)&&Number.isFinite(max)) || max<=min) return '';
    const map = x => {
      const q = (x - min) / (max - min);
      return blocks[Math.max(0, Math.min(blocks.length-1, Math.round(q*(blocks.length-1))))];
    };
    // añade primera y última lectura en texto pequeño
    const first = this.toDisplay(arr[0], units);
    const last  = this.toDisplay(arr[arr.length-1], units);
    return `${first} ${units} ${arr.map(map).join('')} ${last} ${units}`;
  }

  /* ===== Datos Nightscout ===== */
  _httpGet(sessionId, settings, path){ const http = this._httpFor(sessionId, settings); if (!http) throw new Error('URL no configurada'); return http.get(path); }

  async getLatestEntry(settings, sessionId){
    const endpoints = [
      `/api/v1/entries/sgv.json?count=1`,
      `/api/v1/entries.json?count=1`,
      `/api/v1/entries/current.json`
    ];
    let lastErr;
    for (const ep of endpoints){
      try {
        const { data } = await this._httpGet(sessionId, settings, ep);
        const r = Array.isArray(data)? data[0] : data;
        if (!r) throw new Error('Empty');
        const sgv = Number(r.sgv ?? r.glucose);
        const date = r.date || r.dateString || r.sysTime;
        if (!Number.isFinite(sgv) || !date) throw new Error('Bad');
        return { sgv, date: (typeof date==='string')? new Date(date).getTime(): date, direction: r.direction || r.trend || 'NONE' };
      } catch(e){ lastErr = e; }
    }
    throw new Error(`entries failed: ${lastErr?.message||'unknown'}`);
  }

  async getEntriesWindow(settings, minutes, sessionId){
    // Pedimos 48 puntos máx (~4h si 5min). Luego filtramos por ventana local.
    const { data } = await this._httpGet(sessionId, settings, `/api/v1/entries/sgv.json?count=48`);
    const arr = (Array.isArray(data)? data: (data?[data]:[]))
      .map(r=>({ mgdl:Number(r.sgv??r.glucose), ts:(typeof r.date==='string')? new Date(r.date).getTime(): r.date }))
      .filter(r=> Number.isFinite(r.mgdl) && r.ts );
    const since = Date.now() - Math.max(5, minutes)*60*1000;
    return arr.filter(r=> r.ts>=since).sort((a,b)=> a.ts-b.ts);
  }

  async getTodayEntries(settings, sessionId){
    const { locale, tz } = this._langBundle(settings);
    const todayStr = new Date().toLocaleDateString(locale, { timeZone: tz });
    const { data } = await this._httpGet(sessionId, settings, `/api/v1/entries/sgv.json?count=400`);
    return (Array.isArray(data)? data: (data?[data]:[]))
      .map(r=>({ mgdl:Number(r.sgv??r.glucose), ts:(typeof r.date==='string')? new Date(r.date).getTime(): r.date }))
      .filter(r=> Number.isFinite(r.mgdl) && r.ts )
      .filter(r=> new Date(r.ts).toLocaleDateString(locale, { timeZone: tz })===todayStr)
      .sort((a,b)=> a.ts-b.ts);
  }

  /* ===== Predicción ===== */
  async buildPredictionShort(settings, sessionId){
    const limits = this.getAlertLimits(settings);
    const horizon = Number(settings.prediction_horizon_min||30);
    const steps = Math.max(3, Math.min(12, Math.round(horizon/5)));
    const isMmol = (settings.units||UNITS.MGDL)===UNITS.MMOL;
    const toD = mgdl => isMmol ? (mgdl/18).toFixed(1) : String(Math.round(mgdl));

    // 1) Devicestatus con predBGs (si hay)
    try {
      const { data } = await this._httpGet(sessionId, settings, `/api/v1/devicestatus.json?count=1`);
      const ds = Array.isArray(data)? data[0] : data;
      const predBGs = ds && (ds.predBGs || ds?.openaps?.suggested?.predBGs || ds?.ar2?.predBGs);
      if (predBGs){
        let series = predBGs.IOB || predBGs.COB || predBGs.UAM || predBGs.ZT || (Array.isArray(predBGs)? predBGs : null);
        if (Array.isArray(series) && series.length>1){
          series = series.slice(0, steps+1);
          const now = Number(series[0]);
          if (Number.isFinite(now)){
            if (now>limits.low){
              for (let i=1;i<series.length;i++){ if (Number(series[i])<=limits.low) return `↓${toD(limits.low)} @${i*5}m`; }
            }
            if (now<limits.high){
              for (let i=1;i<series.length;i++){ if (Number(series[i])>=limits.high) return `↑${toD(limits.high)} @${i*5}m`; }
            }
          }
        }
      }
    } catch(_){}

    // 2) Fallback lineal con slope filtrado (evita falsas alarmas por ruidos)
    try {
      const { data } = await this._httpGet(sessionId, settings, `/api/v1/entries.json?count=3`);
      const arr = Array.isArray(data)? data: [data];
      if (arr.length>=2){
        const a = arr[0], b = arr[1];
        const mgA = Number(a.sgv??a.glucose), mgB = Number(b.sgv??b.glucose);
        const tA = new Date(a.date||a.dateString).getTime();
        const tB = new Date(b.date||b.dateString).getTime();
        if (Number.isFinite(mgA)&&Number.isFinite(mgB)&&tA>tB){
          const dM = (tA-tB)/60000;
          const slope = (mgA-mgB)/Math.max(1,dM);       // mg/dL por minuto
          const slopeClamped = Math.max(-3, Math.min(3, slope)); // recorte
          if (slopeClamped < -0.4){
            const ttLow = (limits.low - mgA)/slopeClamped;
            if (ttLow>0 && ttLow<=horizon) return `↓${toD(limits.low)} @${Math.round(ttLow)}m`;
          }
          if (slopeClamped > 0.4){
            const ttHigh = (limits.high - mgA)/slopeClamped;
            if (ttHigh>0 && ttHigh<=horizon) return `↑${toD(limits.high)} @${Math.round(ttHigh)}m`;
          }
        }
      }
    } catch(_){}
    return null;
  }

  /* ===== TIR & tratamientos ===== */
  _dayKey(ts, settings){
    const { locale, tz } = this._langBundle(settings);
    return new Date(ts).toLocaleDateString(locale, { timeZone: tz });
    }
  updateTir(sessionId, mgdl, ts, settings){
    const key = this._dayKey(ts, settings);
    let st = this.dailyTir.get(sessionId);
    if (!st || st.dayStr!==key) st = { dayStr:key, total:0, inRange:0 };
    const lim = this.getAlertLimits(settings);
    if (Number.isFinite(mgdl)){
      st.total += 1;
      if (mgdl>=lim.low && mgdl<=lim.high) st.inRange += 1;
    }
    this.dailyTir.set(sessionId, st);
    return st.total>0 ? Math.round(st.inRange*100/st.total) : null;
  }

  async getTreatmentsToday(settings, sessionId){
    try {
      const { data } = await this._httpGet(sessionId, settings, `/api/v1/treatments.json?count=1000`);
      const arr = Array.isArray(data)? data : (data? [data]:[]);
      const { locale, tz } = this._langBundle(settings);
      const today = new Date().toLocaleDateString(locale, { timeZone: tz });
      const ev = arr.map(t=>{
        const d = t.created_at || t.timestamp || t.dateString || t.date || null;
        const ts = (typeof d==='number')? d : (typeof d==='string'? Date.parse(d): null);
        return { ts, carbs: Number(t.carbs), insulin: Number(t.insulin) };
      }).filter(e=> e.ts && (Number.isFinite(e.carbs)||Number.isFinite(e.insulin)));
      const sameDay = ev.filter(e=> new Date(e.ts).toLocaleDateString(locale,{timeZone:tz})===today);
      let C=0,I=0, last=null;
      for (const e of sameDay){ if (Number.isFinite(e.carbs)) C+=e.carbs; if (Number.isFinite(e.insulin)) I+=e.insulin; if (!last||e.ts>last.ts) last=e; }
      return { carbs:+(Math.round(C*10)/10), insulin:+(Math.round(I*10)/10), last };
    } catch(_){ return null; }
  }

  lineTreatments(sum, settings){
    if (!sum) return '';
    const lang = settings.language || 'en';
    const { carbs, insulin, last } = sum;
    let lastStr='';
    if (last && (Number.isFinite(last.carbs)||Number.isFinite(last.insulin))){
      const { locale, tz } = this._langBundle(settings);
      const hhmm = new Date(last.ts).toLocaleTimeString(locale, {timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false});
      const parts=[];
      if (Number.isFinite(last.carbs)) parts.push(`${carbs?last.carbs:0}g`);
      if (Number.isFinite(last.insulin)) parts.push(`${insulin?last.insulin:0}U`);
      if (parts.length) lastStr = (lang==='es'?` · Últ: ${parts.join(', ')} ${hhmm}`:` · Last: ${parts.join(', ')} ${hhmm}`);
    }
    return (lang==='es') ? `CH/Ins hoy: ${carbs}g / ${insulin}U${lastStr}` : `Carbs/Ins today: ${carbs}g / ${insulin}U${lastStr}`;
  }

  /* ===== UI ===== */
  show(session, sessionId, text, maxLines=5){
    const lines = String(text||'').replace(/\r/g,'').split('\n').filter(l=>l.trim()!=='');
    const out = lines.slice(0, maxLines).join('\n');
    if (this._lastShown.get(sessionId)===out) return;
    this._lastShown.set(sessionId, out);
    session.layouts.showTextWall(out);
  }
  hideDisplay(session, sessionId){ try{ session.layouts.showTextWall(''); this._lastShown.delete(sessionId);}catch{} }

  async animateTIR(session, sessionId, settings, header, tirPct, extraLines){
    const showBar = !!settings.show_tir_bar;
    const animOn = settings.enable_animations!==false;
    const lang = settings.language||'en';

    const tag = (lang==='es'?'TIR hoy:':'TIR:') + (tirPct==null? ' n/d': ` ${tirPct}%`);
    const baseOut = () => `${header}\n${tag}${showBar && tirPct!=null ? ' '+this._bar(tirPct/100,20):''}${extraLines?('\n'+extraLines):''}`;

    if (!showBar || !animOn || tirPct==null || !Number.isFinite(tirPct)){
      this.show(session, sessionId, baseOut());
      return;
    }

    const token = (this._renderToken.get(sessionId)||0)+1;
    this._renderToken.set(sessionId, token);

    const slots=20, target=Math.floor(this._clamp01(tirPct/100)*slots);
    const leadIn=180, totalMs=900;
    const ease = this._ease(settings.animation_type||'cubic');

    this.show(session, sessionId, `${header}\n${tag} ${this._bar(0,20)}${extraLines?('\n'+extraLines):''}`);
    const t0=Date.now();
    while (Date.now()-t0<leadIn){ if (this._renderToken.get(sessionId)!==token) return; await this._delay(30); }

    const ts=Date.now(); let last=-1;
    while (true){
      if (this._renderToken.get(sessionId)!==token) return;
      const p = Math.min(1,(Date.now()-ts)/totalMs);
      const filled = Math.min(target, Math.floor(ease(p)*target));
      if (filled!==last){
        this.show(session, sessionId, `${header}\n${tag} ${this._bar(filled/slots,20)}${extraLines?('\n'+extraLines):''}`);
        last=filled;
      }
      if (p>=1) break;
      await this._delay(32);
    }
    this.show(session, sessionId, baseOut());
  }

  /* ===== Ciclo de vida ===== */
  async onSession(session, sessionId, userId){
    session.updateSettingsForTesting ??= async ()=>{};
    let settings;
    try {
      settings = await this.getUserSettings(session);
      if (!settings.nightscoutUrl){
        this.show(session, sessionId, (settings.language==='es'?'Configura URL y token':'Set URL and token'));
        return;
      }
      this.active.set(sessionId, { session, userId, settings, iv:null });

      // Semilla TIR del día
      try{
        const today = await this.getTodayEntries(settings, sessionId);
        const key = this._dayKey(Date.now(), settings);
        const lim = this.getAlertLimits(settings);
        let total=0,inRange=0;
        for (const e of today){ if (Number.isFinite(e.mgdl)){ total++; if (e.mgdl>=lim.low && e.mgdl<=lim.high) inRange++; } }
        this.dailyTir.set(sessionId, { dayStr:key, total, inRange });
      }catch{}

      // Mostrar primera vez
      await this._showOnce(session, sessionId, settings);
      // Arrancar ciclo normal
      await this._startLoop(session, sessionId, userId, settings);

      // Handlers
      this._wireEvents(session, sessionId, userId);
    } catch(e){
      console.error('onSession error:', e);
      const lang=(settings&&settings.language)||'en';
      this.show(session, sessionId, lang==='es'?'Error: revisa ajustes':'Error: check settings');
    }
  }

  async _showOnce(session, sessionId, s){
    try {
      const entry = await this.getLatestEntry(s, sessionId);
      this.lastGoodEntry.set(sessionId, entry);

      const tir = this.updateTir(sessionId, entry.sgv, entry.date, s);
      const header = await this.formatHeader(entry, s);

      // Sparkline opcional
      let extra = '';
      if (s.enable_ascii_sparkline){
        try {
          const win = await this.getEntriesWindow(s, s.sparkline_minutes||30, sessionId);
          const mg = win.map(w=>w.mgdl);
          const spark = this.buildAsciiSparkline(mg, s.units);
          if (spark) extra = spark;
        } catch(_){}
      }

      // Tratamientos
      let tLine = '';
      try { const sum = await this.getTreatmentsToday(s, sessionId); tLine = this.lineTreatments(sum, s); } catch {}

      const extraLines = [extra, tLine].filter(Boolean).join('\n');

      if (s.enable_advanced_mode){
        await this.animateTIR(session, sessionId, s, header, tir, extraLines);
      } else {
        // Añade predicción corta en la 2ª línea si existe
        let out = header;
        try {
          const pred = await this.buildPredictionShort(s, sessionId);
          if (pred) out = out + ' · ' + pred;
        } catch(_){}
        if (extraLines) out += `\n${extraLines}`;
        this.show(session, sessionId, out);
      }
      this._scheduleHide(sessionId, s.display_duration_ms||5000, session);
    } catch(e){
      // Fallback a último bueno
      const cached = this.lastGoodEntry.get(sessionId);
      if (cached){
        const header = await this.formatHeader(cached, s);
        this.show(session, sessionId, header);
        this._scheduleHide(sessionId, s.display_duration_ms||5000, session);
      } else {
        const lang=s.language||'en';
        this.show(session, sessionId, lang==='es'?'Error al cargar':'Load error');
        this._scheduleHide(sessionId, 4000, session);
      }
    }
  }

  async _startLoop(session, sessionId, userId, s0){
    const period = Math.max(1, s0.updateInterval||5)*60*1000;
    const iv = setInterval(async()=>{
      if (!this.active.has(sessionId)) return clearInterval(iv);
      try{
        const sd = this.active.get(sessionId);
        const s = sd?.settings || s0;
        const e = await this.getLatestEntry(s, sessionId);
        this.lastGoodEntry.set(sessionId, e);
        // actualizar TIR y lanzar alertas si toca
        this.updateTir(sessionId, e.sgv, e.date, s);
        if (s.alertsEnabled) await this._checkAlerts(session, sessionId, e, s);
      }catch(err){
        session.logger?.debug('loop tick error', { msg: err.message });
      }
    }, period);
    const sd = this.active.get(sessionId) || {};
    if (sd.iv) clearInterval(sd.iv);
    sd.iv = iv;
    this.active.set(sessionId, sd);
  }

  _wireEvents(session, sessionId, userId){
    // Botón → mostrar temporal
    session.events?.onButtonPress?.(async ()=>{
      const sd = this.active.get(sessionId);
      const s = sd?.settings || await this.getUserSettings(session);
      await this._showOnce(session, sessionId, s);
    });

    // Settings (debounce, algunas builds spamean)
    const trigger = (payload)=>{
      if (this._debounce.has(sessionId)) clearTimeout(this._debounce.get(sessionId));
      const t = setTimeout(async()=>{
        try{
          const s = this.parseSettingsFromArray(payload||[]);
          const sd = this.active.get(sessionId) || { session, userId, settings: s, iv:null };
          const old = sd.settings || {};
          sd.settings = s; this.active.set(sessionId, sd);
          // reinicia loop si cambia frecuencia
          if ((old.updateInterval||5)!== (s.updateInterval||5)) await this._startLoop(session, sessionId, userId, s);
          // feedback rápido
          const lim = this.getAlertLimits(s);
          const lines = [
            (s.language==='es'?'Ajustes guardados':'Settings saved'),
            `Units: ${s.units}`,
            `TIR: ${lim.low}-${lim.high} mg/dL`,
            `HeadUp: ${s.enable_head_up_display?'ON':'OFF'}`,
            `Advanced: ${s.enable_advanced_mode?'ON':'OFF'}`
          ];
          this.show(session, sessionId, lines.join('\n'));
          setTimeout(()=> this.hideDisplay(session, sessionId), 2200);
        }catch(e){ session.logger?.error(e, 'settings apply'); }
      }, 120);
      this._debounce.set(sessionId, t);
    };
    session.events?.onAppSettingsUpdate?.(trigger);
    session.events?.onSettingsUpdate?.(trigger);
    session.events?.onSettingsChange?.(trigger);

    // Gestos cabeza (debounce 10s)
    session.events?.onHeadPosition?.(async data=>{
      try{
        if (data?.position!=='up') return;
        const now = Date.now();
        const last = this._lastHeadUpAt.get(sessionId)||0;
        if (now-last < 10000) return; // anti-spam
        this._lastHeadUpAt.set(sessionId, now);
        const sd = this.active.get(sessionId);
        const s = sd?.settings || await this.getUserSettings(session);
        if (!s.enable_head_up_display) return;
        await this._showOnce(session, sessionId, s);
      }catch(_){}
    });

    // Limpieza
    session.events?.onDisconnected?.(()=>{
      const t = this._hideTimers.get(sessionId); if (t) clearTimeout(t);
      const sd = this.active.get(sessionId); if (sd?.iv) clearInterval(sd.iv);
      this._hideTimers.delete(sessionId);
      this._http.delete(sessionId);
      this.active.delete(sessionId);
      this.dailyTir.delete(sessionId);
      this._lastShown.delete(sessionId);
      this._renderToken.delete(sessionId);
    });
  }

  /* ===== Alertas con histeresis ===== */
  async _checkAlerts(session, sessionId, entry, settings){
    const lim = this.getAlertLimits(settings);
    const hys = Math.max(0, settings.alert_hysteresis_mg || 5); // mg/dL
    const last = this.alertState.get(sessionId) || { lastAt:0, lastType:null };
    const cooldown = settings.alert_cooldown_ms || 600000;

    if (Date.now() - last.lastAt < cooldown) return;

    let type=null;
    // disparo cuando cruza por margen, no justo el límite
    if (entry.sgv <= (lim.low - hys)) type='low';
    else if (entry.sgv >= (lim.high + hys)) type='high';

    if (type && type===last.lastType){
      // ya avisamos mismo tipo recientemente; reforzar cooldown
      last.lastAt = Date.now(); this.alertState.set(sessionId,last); return;
    }

    if (type){
      last.lastAt = Date.now(); last.lastType=type; this.alertState.set(sessionId,last);
      await this._blinkAlert(session, sessionId, entry, settings, type);
    }
  }

  async _blinkAlert(session, sessionId, entry, settings, type){
    const unit = settings.units||UNITS.MGDL;
    const val = this.toDisplay(entry.sgv, unit);
    const lang = settings.language||'en';
    const title = (lang==='es' ? (type==='low'?'¡GLUCOSA BAJA!':'¡GLUCOSA ALTA!') : (type==='low'?'LOW GLUCOSE!':'HIGH GLUCOSE!'));
    const base = `${title}\n${val} ${unit}`;
    const dur = settings.alert_duration_ms||15000;
    const blink = 600;

    if (this._hideTimers.has(sessionId)) clearTimeout(this._hideTimers.get(sessionId));
    const t0=Date.now(); let vis=true;
    const it = setInterval(()=>{
      if (Date.now()-t0>dur){ clearInterval(it); this.hideDisplay(session, sessionId); return; }
      this.show(session, sessionId, `${vis?'[!]':'[ ]'} ${base}`);
      vis=!vis;
    }, blink);
    this._hideTimers.set(sessionId, setTimeout(()=>{ clearInterval(it); this.hideDisplay(session, sessionId); }, dur+120));
  }

  /* ===== Tool (Mira) ===== */
  async onToolCall(data){
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const isEs = ['obtener_glucosa','revisar_glucosa','nivel_glucosa','mi_glucosa'].includes(toolId);
    const lang = isEs?'es':'en';
    try{
      let settings=null;
      if (data.activeSession?.settings?.settings) {
        settings = this.parseSettingsFromArray(data.activeSession.settings.settings);
      } else {
        for (const [, sData] of this.active){ if (sData.userId===userId){ settings = sData.settings; break; } }
      }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) throw new Error(lang==='es'?'Nightscout no configurado':'Nightscout not configured');

      const e = await this.getLatestEntry(settings, 'tool');
      const disp = this.toDisplay(e.sgv, settings.units);
      const arr = this.trendArrow(e.direction);
      const limits = this.getAlertLimits(settings);
      const tir = this.updateTir('tool', e.sgv, e.date, settings);
      const status = (()=>{
        if (e.sgv<70) return lang==='es'?'Crítico Bajo':'Critical Low';
        if (e.sgv<=limits.low) return lang==='es'?'Bajo':'Low';
        if (e.sgv>250) return lang==='es'?'Crítico Alto':'Critical High';
        if (e.sgv>=limits.high) return lang==='es'?'Alto':'High';
        return lang==='es'?'Normal':'Normal';
      })();
      const extra = (settings.enable_advanced_mode&&Number.isFinite(tir)) ? (isEs?` TIR hoy: ${tir}%`:` TIR: ${tir}%`) : '';
      const msg = isEs
        ? `Tu glucosa está en ${disp} ${settings.units} ${arr}. Estado: ${status}.${extra}`
        : `Your glucose is ${disp} ${settings.units} ${arr}. Status: ${status}.${extra}`;
      return { success:true, data:{glucose:disp,unit:settings.units,trend:arr,status,tirPct:Number.isFinite(tir)?tir:null}, message:msg };
    }catch(e){ return { success:false, error: e.message }; }
  }
}

/* ===== init ===== */
const server = new NightscoutMentraApp({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
server.start().catch(err=>{ console.error('⛔ start error:', err); process.exit(1); });
console.log('🚀 MentraOS Nightscout v2.13 ready');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_,res)=> res.json({ status:'alive', ts:new Date().toISOString(), ver:'2.13' }));
setInterval(()=> axios.get(`${KEEP_ALIVE_URL}/health`).catch(()=>{}), 3*60*1000);
