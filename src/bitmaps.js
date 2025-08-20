"use strict";

const fs = require("fs");
const path = require("path");
const bmp = require("bmp-js");

/**
 * Carga un archivo BMP y lo decodifica a objeto con:
 *  - width
 *  - height
 *  - data (RGBA buffer)
 */
function loadBitmap(filename) {
  const filePath = path.join(__dirname, "assets", "bitmaps", filename);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ No se encontró el bitmap: ${filePath}`);
    return null;
  }
  const bmpBuffer = fs.readFileSync(filePath);
  return bmp.decode(bmpBuffer);
}

const BITMAPS = {
  LOW: loadBitmap("alert-low-526x100.bmp"),
  HIGH: loadBitmap("alert-high-526x100.bmp"),
};

module.exports = BITMAPS;
