# 🚀 Nightscout for MentraOS – v2.5.1 HEAD-UP Display + DUAL-UNITS Advanced

**Monitor de Glucosa en Tiempo Real para Even Realities G1 Smart Glasses**  
✨ Ahora con soporte completo de unidades duales (mg/dL ↔ mmol/L), alarmas configurables, mejoras de timezone y nueva función **Head-Up Display** para mostrar la glucosa al mirar hacia arriba.

---

## 🆕 Novedades en v2.5.1

### 🔧 Mejoras Críticas y Nuevas Funcionalidades

- ✅ **Head-Up Display** – Muestra glucosa y estado al inclinar la cabeza hacia arriba (posición ‘up’)  
- ✅ **Control desde consola de Mentra** – Variable `enable_head_up_display` para activar/desactivar la función sin redeploy  
- ✅ Sistema de Unidades Dual – Configuración mg/dL ↔ mmol/L con cambio dinámico  
- ✅ Alarmas Independientes – Límites separados para mg/dL y mmol/L con sliders duales  
- ✅ Detección de Cambios en Tiempo Real – Actualización automática al cambiar configuración  
- ✅ Gestión Mejorada de Timezone – Corrección de bugs de zona horaria  
- ✅ Internacionalización Completa – Español/Inglés con detección automática

---

## 📊 Nuevas Opciones de Configuración

### Head-Up Display

| Configuración              | Tipo   | Opciones     | Por Defecto | Descripción                                                       |
|----------------------------|--------|--------------|-------------|-------------------------------------------------------------------|
| `enable_head_up_display`   | toggle | true / false | true        | Si está activo, muestra glucosa al mover la cabeza hacia arriba   |

### Sistema de Unidades Dual

| Configuración     | Tipo   | Rango / Opciones         | Por Defecto | Descripción                              |
|------------------|--------|--------------------------|-------------|------------------------------------------|
| `units`          | select | mg/dL, mmol/L            | mg/dL       | Unidades de glucosa preferidas           |
| `low_alert_mg`   | slider | 40–90 mg/dL              | 70          | Alerta crítica baja (mg/dL)              |
| `high_alert_mg`  | slider | 180–400 mg/dL            | 250         | Alerta crítica alta (mg/dL)              |
| `low_alert_mmol` | slider | 2–5 mmol/L               | 4           | Alerta crítica baja (mmol/L)             |
| `high_alert_mmol`| slider | 8–30 mmol/L              | 14          | Alerta crítica alta (mmol/L)             |

---

## 🌍 Soporte Internacional Mejorado

### 🇪🇸 Español

- `"Hey Mira, obtener mi glucosa"`  
- `"mostrar glucosa actual"`  
- También ahora se puede **mirar hacia arriba** para verla instantáneamente si está activa la opción.

### 🇺🇸 English

- `"Hey Mira, get my glucose"`  
- `"show current glucose"`  
- Look up to see glucose if `enable_head_up_display` is enabled.

---

## ⚙️ Configuración MentraOS (JSON)

```json
{
  "name": "Nightscout Glucose",
  "description": "Monitor de glucosa en tiempo real desde Nightscout con Head-Up Display",
  "publicUrl": "https://mentra-nightscout.onrender.com",
  "appType": "background",
  "permissions": [{"type": "ALL", "description": ""}],
  "settings": [
    {"id": "enable_head_up_display", "type": "toggle", "default": true, "label": "Enable Head-Up Display"}
  ]
}
```

---

## 📈 Mejoras de Rendimiento

- ✅ Manejo de eventos `onHeadPosition` integrado con sistema de configuración  
- ✅ Compatibilidad con el panel nativo de fecha/hora de MentraOS (sin solapamiento)  
- ✅ Cache inteligente y limpieza automática  
- ✅ Gestión robusta de errores y validación

---

## 🛠️ Guía de Inicio Rápido

1. Deploy en Render o Railway (Node.js 18+)  
2. Configura unidades, alertas, zona horaria y `enable_head_up_display` en consola Mentra  
3. Introduce URL + Token de Nightscout  
4. Si `enable_head_up_display` está activo, mirar hacia arriba mostrará la glucosa

---

## 📋 Checklist de Configuración

- [x] URL de Nightscout configurada  
- [x] Token válido  
- [x] Unidades e idioma configurados  
- [x] Timezone correcto  
- [x] Alertas habilitadas y funcionando  
- [x] Head-Up Display activado si se desea

---

## 📄 Licencia

**MIT License**  
> Descargo: Solo para fines informativos. Verifica siempre con dispositivos médicos.

**Versión:** 2.5.1  
**Fecha:** Agosto 2025  
**Compatibilidad:** MentraOS SDK (última versión)
