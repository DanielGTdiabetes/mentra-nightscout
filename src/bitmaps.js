// bitmaps.js - Carga y validación de bitmaps para MentraOS BitmapView (CommonJS)
const path = require("path");
const { BitmapUtils } = require("@mentra/sdk");

async function loadBitmaps() {
  const base = path.resolve(__dirname, "assets", "bitmaps");
  async function load(name) {
    const hex = await BitmapUtils.loadBmpAsHex(path.join(base, name));
    const res = BitmapUtils.validateBmpHex(hex);
    if (!res.isValid) {
      throw new Error(`Bitmap inválido ${name}: ${res.errors?.join(", ")}`);
    }
    return hex;
  }
  return {
    high: await load("alert-high-526x100.bmp"),
    low: await load("alert-low-526x100.bmp"),
    sun: await load("weather-sun-526x100.bmp"),
    cloud: await load("weather-cloud-526x100.bmp"),
    rain: await load("weather-rain-526x100.bmp"),
  };
}

module.exports = { loadBitmaps };
