// src/bitmaps.js
// Carga perezosa (lazy) de BMPs y entrega hex para showBitmapView()
// No requiere dependencias externas: usa BitmapUtils del SDK.

"use strict";

const path = require('path');
const { BitmapUtils } = require('@mentra/sdk');

const BITMAP_FILES = {
  'alert-low-526x100':  path.join(__dirname, '../assets/alert-low-526x100.bmp'),
  'alert-high-526x100': path.join(__dirname, '../assets/alert-high-526x100.bmp'),
  // Opcionales (si los añades):
  'weather-sun-526x100':   path.join(__dirname, '../assets/weather-sun-526x100.bmp'),
  'weather-cloud-526x100': path.join(__dirname, '../assets/weather-cloud-526x100.bmp'),
  'weather-rain-526x100':  path.join(__dirname, '../assets/weather-rain-526x100.bmp'),
};

const _cache = new Map();

async function loadOne(key) {
  const file = BITMAP_FILES[key];
  if (!file) return null;
  try {
    const hex = await BitmapUtils.loadBmpAsHex(file);
    if (typeof hex === 'string' && hex.length > 0) {
      _cache.set(key, hex);
      return hex;
    }
    return null;
  } catch (e) {
    // No hacemos throw para no romper la app; devolvemos null y el caller decide fallback
    return null;
  }
}

/** Carga todos los bitmaps definidos (útil en arranque). */
async function loadBitmaps() {
  const keys = Object.keys(BITMAP_FILES);
  const out = {};
  for (const k of keys) {
    out[k] = await loadOne(k);
  }
  return out;
}

/** Devuelve el hex del bitmap solicitado; lo carga en caché si hace falta. */
async function getBitmapHex(key) {
  if (_cache.has(key)) return _cache.get(key);
  return await loadOne(key);
}

/** Lista de claves disponibles. */
const AVAILABLE_KEYS = Object.freeze(Object.keys(BITMAP_FILES));

module.exports = {
  AVAILABLE_KEYS,
  loadBitmaps,
  getBitmapHex,
};
