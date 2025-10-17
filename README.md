# FrontBoardAppLauncher
Reference usage of FrontBoard &amp; UIKit private API to display external app scene.

This app implements multitasking.

## Supported iOS versions
Requires TrollStore.

iOS 15.0+ are supported.

iOS 14.x is not yet supported. There is an issue in FrontBoard.

## Known issues
- Apps stay running even after closing
- In-app keyboard offset may be off
- Keyboard doesn't work when windowed on top of SpringBoard yet
- Re-opening an app after closing may crash
- Single-scene apps may not work yet. You may see empty window in such cases.

## Voice Masker IA (Web)
A lightweight web experience lives in `Resources/voice-masker/` that can be served as a standalone Safari web app or called from Atajos. It offers:

- Cambio de voz en tiempo real con un pitch shifter basado en AudioWorklet.
- Tres perfiles graves preconfigurados (`Warden`, `Leviathan`, `Shadow`).
- Ajustes manuales para pitch, distorsión y filtro paso bajo.
- Text-to-speech integrado que reutiliza las configuraciones activas.
- Recomendaciones dinámicas de una IA ligera que analiza tu señal de entrada.

Para desplegarlo basta con alojar el contenido de la carpeta en un servidor estático o integrarlo en un flujo de Atajos que abra la URL local.
