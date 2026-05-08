#!/bin/bash
# Script temporal para ejecutar el bot con publicación forzada al inicio
# USO: ./run-once.sh

echo "Iniciando bot con publicación forzada..."
echo "Esto publicará:"
echo "  - Las 4 hidroeléctricas individuales"
echo "  - El reporte diario deayer (jueves)"
echo ""

# Preguntar si también quiere el reporte de anteayer (miércoles)
read -p "¿Publicar también el reporte del miércoles? (s/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Ss]$ ]]; then
    echo "Sí publicar también el reporte del miércoles..."
    FORCE_PUBLISH=true FORCE_PUBLISH_BACKUP=true node infocaudalesbot.js
else
    echo "Solo publicando reporte del jueves..."
    FORCE_PUBLISH=true node infocaudalesbot.js
fi
