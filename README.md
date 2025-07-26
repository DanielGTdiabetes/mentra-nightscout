# 🚀 Nightscout for MentraOS – v2.4.5 DUAL-UNITS Advanced

**Monitor de Glucosa en Tiempo Real para Even Realities G1 Smart Glasses**  
✨ Ahora con soporte completo de unidades duales (mg/dL ↔ mmol/L), alarmas configurables independientes y mejoras de timezone

---

## 🆕 Novedades en v2.4.5

### 🔧 Mejoras Críticas y Nuevas Funcionalidades

- ✅ Sistema de Unidades Dual – Configuración mg/dL ↔ mmol/L con cambio dinámico  
- ✅ Alarmas Independientes – Límites separados para mg/dL y mmol/L con sliders duales  
- ✅ Detección de Cambios en Tiempo Real – Actualización automática al cambiar configuración  
- ✅ Soporte Completo de Sliders – Todos los ajustes numéricos funcionan perfectamente  
- ✅ Gestión Mejorada de Timezone – Corrección de bugs de zona horaria  
- ✅ Internacionalización Completa – Español/Inglés con detección automática

---

## 📊 Nuevas Opciones de Configuración

### Sistema de Unidades Dual

| Configuración     | Tipo   | Rango / Opciones         | Por Defecto | Descripción                              |
|------------------|--------|--------------------------|-------------|------------------------------------------|
| `units`          | select | mg/dL, mmol/L            | mg/dL       | Unidades de glucosa preferidas           |
| `low_alert_mg`   | slider | 40–90 mg/dL              | 70          | Alerta crítica baja (mg/dL)              |
| `high_alert_mg`  | slider | 180–400 mg/dL            | 250         | Alerta crítica alta (mg/dL)              |
| `low_alert_mmol` | slider | 2–5 mmol/L               | 4           | Alerta crítica baja (mmol/L)             |
| `high_alert_mmol`| slider | 8–30 mmol/L              | 14          | Alerta crítica alta (mmol/L)             |

### Configuraciones Adicionales

| Setting           | Tipo    | Opciones                 | Por Defecto     | Descripción                       |
|------------------|---------|--------------------------|-----------------|-----------------------------------|
| `update_interval`| select  | 1, 5, 15 min             | 5 min           | Frecuencia de actualización       |
| `alerts_enabled` | toggle  | true / false             | true            | Activar/desactivar alertas        |
| `language`       | select  | en, es                   | en              | Idioma de la interfaz             |
| `timezone`       | select  | Varias zonas             | Europe/Madrid   | Zona horaria local                |

---

## 🌍 Soporte Internacional Mejorado

### 🇪🇸 Usuarios en España

- Comandos de Voz:  
  `"Hey Mira, obtener mi glucosa"`  
  `"mostrar glucosa actual"`

- Alertas:  
  🚨 ¡GLUCOSA BAJA! 3.8 mmol/L / 70 mg/dL

- Timezone: Europe/Madrid o Atlantic/Canary

### 🇺🇸 Usuarios en Estados Unidos

- Comandos de Voz:  
  `"Hey Mira, get my glucose"`  
  `"check blood sugar"`

- Alertas:  
  🚨 LOW GLUCOSE! 70 mg/dL / 3.8 mmol/L

---

## ⚙️ Configuración MentraOS (JSON)

```json
{
  "name": "Nightscout Glucose",
  "description": "Monitor de glucosa en tiempo real desde Nightscout",
  "publicUrl": "https://mentra-nightscout.onrender.com",
  "appType": "background",
  "permissions": [{"type": "ALL", "description": ""}],
  ...
}
```

(*se ha abreviado el JSON para brevedad, incluir completo en documentación final*)

---

## 🎮 Interacción por Voz Mejorada

### Español

- `"Hey Mira, obtener mi glucosa"` → muestra nivel actual con tendencia  
- `"Hey Mira, mostrar glucosa actual"` → muestra con hora local

### English

- `"Hey Mira, get my glucose"` → shows glucose with trend  
- `"Hey Mira, show current glucose"` → with local time

---

## 📈 Mejoras de Rendimiento

- ✅ onSettingsChange optimizado  
- ✅ Cache inteligente y limpieza automática  
- ✅ Validación robusta  
- ✅ Compatible con MentraOS SDK y gestión de errores

---

## 🛠️ Guía de Inicio Rápido

### Para Nuevos Usuarios

1. Deploy en Render o Railway (Node.js 18+)
2. Configura unidades, alertas, zona horaria
3. Introduce URL + Token de Nightscout

### Para Usuarios Existentes (v2.4.4)

- Migración sin perder configuración  
- Sliders duales disponibles inmediatamente  

---

## 🏆 Logros Técnicos

| Problema                                | Estado    | Solución v2.4.5                                |
|----------------------------------------|-----------|------------------------------------------------|
| ❌ Sin soporte mmol/L configurables     | ✅ RESUELTO | Sistema dual completo con sliders             |
| ❌ Alarmas con una sola unidad          | ✅ RESUELTO | Límites independientes mg/dL y mmol/L         |
| ❌ Cambios de config requieren reinicio | ✅ RESUELTO | Actualización en tiempo real                  |
| ❌ Timezone bugs                        | ✅ RESUELTO | Validación mejorada                           |

---

## 📄 Variables de Entorno

```bash
# .env
MENTRAOS_API_KEY=tu_api_key_mentraos
PORT=3000
RENDER_URL=https://tu-app.onrender.com
PACKAGE_NAME=com.tucompania.nightscout-glucose
```

---

## 🆕 Changelog v2.4.5

- Añadido: sistema de unidades dual, sliders separados, detección de cambios  
- Corregido: timezone bugs, validación de rangos, compatibilidad SDK  
- Mejorado: rendimiento, UX, logs, gestión de errores

---

## 📋 Checklist de Configuración

- [x] URL de Nightscout configurada  
- [x] Token válido  
- [x] Unidades y idioma configurados  
- [x] Timezone correcto  
- [x] Alertas habilitadas y funcionando

---

## 📄 Licencia

**MIT License**

> Descargo: Solo para fines informativos. Verifica siempre con dispositivos médicos.  
> Desarrollado con ❤️ para la comunidad global de diabetes.

**Versión:** 2.4.5  
**Fecha:** Julio 2025  
**Compatibilidad:** MentraOS SDK (última versión)
