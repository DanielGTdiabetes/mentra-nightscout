// demo.js - Muestra cada bitmap 5s y limpia al final
"use strict";
const { AppServer } = require("@mentra/sdk");
const { loadBitmaps } = require("./bitmaps");

(async () => {
  const server = new AppServer({ packageName: process.env.PACKAGE_NAME, port: process.env.PORT || 3000 });
  await server.start();
  const s = server.session;
  console.log("[demo] AppServer started");

  const icons = await loadBitmaps();

  // Secuencia de prueba
  await s.layouts.showBitmapView(icons.high,  { durationMs: 5000 });
  await s.layouts.showBitmapView(icons.low,   { durationMs: 5000 });
  await s.layouts.showBitmapView(icons.sun,   { durationMs: 3000 });
  await s.layouts.showBitmapView(icons.cloud, { durationMs: 3000 });
  await s.layouts.showBitmapView(icons.rain,  { durationMs: 3000 });

  setTimeout(() => s.layouts.clearView(), 13000);
})().catch(e => { console.error("[demo] error:", e); process.exit(1); });