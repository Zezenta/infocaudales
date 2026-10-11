# Research & Development (R&D) Scripts

Este directorio contiene herramientas y scripts de investigación, calibración y diagnóstico utilizados durante el desarrollo de la detección de tormentas y calibración satelital.

> **Nota:** Ninguno de estos scripts se ejecuta en producción ni forma parte de los demonios automáticos del bot.

## Contenido

* **`analyze-all-storms-oct7.ts`**: Auditoría puntual de tormentas del 1 al 7 de octubre de 2026.
* **`analyze-storm-detection.ts`**: Análisis inicial de muestras de píxeles infrarrojos GOES-16.
* **`backfill-accurate-events.ts`**: Backfill y migración de eventos históricos con la lógica calibrada.
* **`generate-bbox-comparison-image.ts`**: Generación de comparativa visual de bounding boxes de cuencas.
* **`render-alert-demonstration-video.ts`**: Prueba de compilación de video con badges de alerta y overlays.
* **`render-both-timelapses.ts`**: Generador puntual de timelapses para Paute y Coca.
* **`simulate-thresholds.ts`**: Simulación de umbrales térmicos (-50 °C vs -60 °C) en fotogramas GOES-16.
* **`sync-all-storms.ts`**: Sincronización de eventos históricos en base de datos SQLite.
* **`sync-and-check-gap.ts`**: Detección y descarga puntual de fotogramas faltantes en el archivo histórico.
* **`test-bbox-calibration.ts`**: Verificación de alineación de coordenadas de cuencas hidrográficas.
