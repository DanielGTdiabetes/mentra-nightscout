// src/bitmaps.js
"use strict";

const fs = require("fs");
const path = require("path");
const bmp = require("bmp-js");

// Ruta: src/assets/bitmaps/*.bmp
function fullPath(filename) {
  return path.join(__dirname, "assets", "bitmaps", filename);
}

function safeLoadBmp(filename) {
  const p = fullPath(filename);
  if (!fs.existsSync(p)) return null;
  try {
    const buf = fs.readFileSync(p);
    const decoded = bmp.decode(buf); // {data, width, height}
    return {
      dataRGBA: decoded.data,
      width: decoded.width,
      height: decoded.height
    };
  } catch {
    return null;
  }
}

// Cache simple (lazy)
const CACHE = new Map();
const FILES = {
  "alert-low-526x100":  "alert-low-526x100.bmp",
  "alert-high-526x100": "alert-high-526x100.bmp",
};

function loadAllBitmaps() {
  for (const [key, file] of Object.entries(FILES)) {
    if (!CACHE.has(key)) {
      const bmp = safeLoadBmp(file);
      if (bmp) CACHE.set(key, bmp);
    }
  }
}

function hasBitmap(key) {
  if (!CACHE.has(key)) loadAllBitmaps();
  return CACHE.has(key);
}

function getBitmap(key) {
  if (!CACHE.has(key)) loadAllBitmaps();
  return CACHE.get(key) || null;
}

module.exports = {
  loadAllBitmaps,
  hasBitmap,
  getBitmap,
};
