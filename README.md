# Arcade Launcher

Launcher Electron para **Daytona USA**, **Daytona USA 2** y **Scud Race** (versiones publicadas en GitHub Pages) que:

1. **Fuerza la GPU dedicada**
   - Pasa `force_high_performance_gpu` a Chromium.
   - Registra la preferencia de Windows "Alto rendimiento" para el ejecutable (`HKCU\Software\Microsoft\DirectX\UserGpuPreferences`).
   - Fuerza `powerPreference: 'high-performance'` en WebGPU y WebGL.
2. **Da force feedback real al volante mediante SDL3.** Lee la "drive board" emulada de cada juego (el motor del volante de la cabina arcade) y la envía a `ffb_bridge.exe`. Ese ejecutable abre el volante con `SDL_Haptic` y aplica fuerza constante, resorte, amortiguador, fricción y vibración.

## Usar (portable)

```
release\Arcade Launcher\Arcade Launcher.exe
```

La carpeta `release\Arcade Launcher` es autocontenida: puedes copiarla o moverla a otro disco o a una USB.

- **Dónde guarda todo:** en `data\`, junto al `.exe`: ajustes, perfil de Chromium, caché HTTP y de shaders, y el IndexedDB donde los juegos guardan ROMs y partidas.
- **Primera ejecución:** copia lo que hubiera en `%APPDATA%\Arcade Launcher`, sin las cachés. El original no se borra.
- **Carpeta de solo lectura** (p. ej. `Program Files`): vuelve a usar `%APPDATA%`. El pie del launcher indica dónde están los datos.
- **Lo único fuera de la carpeta:** la preferencia de GPU de Windows (registro `HKCU\...\UserGpuPreferences`, por ruta del `.exe`). Si mueves la carpeta, se registra de nuevo en el primer arranque.
- **En desarrollo** (`npm start`), los datos van a `portable-data\`.

1. Conecta el volante. Se detecta en caliente; en el panel **Volante** puedes elegirlo y probar empujar, resorte y vibración.
2. Pulsa **JUGAR**. La primera vez, carga la ROM desde el menú del juego; el juego la guarda.
3. Asigna el volante en el menú de controles del juego, como siempre. Si Chromium no lo lee bien, activa "Exponer el volante SDL3 como mando extra": aparece como `SDL3 <nombre> (Arcade Launcher)`.
4. Ajusta la fuerza con los deslizadores. Si el volante empuja al revés, marca **Invertir dirección de la fuerza** en esa tarjeta.

Atajos dentro del juego: **F11** pantalla completa, **Ctrl+F5** recargar sin caché, **Ctrl+F12** DevTools.

## macOS

GitHub Actions compila la versión de Mac en cada push (workflow `Build`). Se descarga desde la pestaña **Actions** → artefacto `arcade-launcher-mac`. Si subes una etiqueta `v*`, los archivos se adjuntan también a la *Release*.

- Hay `.dmg` y `.zip` para **Apple Silicon (arm64)** e **Intel (x64)**. El puente SDL3 (`ffb_bridge`) es universal y va enlazado estáticamente: no lleva dylibs.
- **Firma:** la app tiene firma *ad-hoc*, no está firmada por Apple. La primera vez macOS dirá que no puede verificar al desarrollador. Abre la app con clic derecho → **Abrir**. Si dice que está "dañada", ejecuta:
  ```
  xattr -cr "/ruta/a/Arcade Launcher.app"
  ```
- **Datos:**
  - Si dejas la app en su propia carpeta, guarda todo en una carpeta **Arcade Launcher Data** junto al `.app`, en modo portable.
  - Si la mueves a `/Aplicaciones`, usa `~/Library/Application Support/Arcade Launcher`.
- **GPU:** en Mac con dos GPU se pide la de alto rendimiento. WebGPU va sobre Metal, y el selector de ANGLE ofrece Metal y OpenGL.
- **Force feedback en Mac:** depende de que el volante tenga driver de force feedback para macOS (IOKit ForceFeedback). Algunos modelos de Logitech y Thrustmaster lo tienen y otros no. Usa los botones de prueba del panel **Wheel**.

Compilar en un Mac a mano: `npm ci && npm run build:native && npm run dist:mac`.

## Jugar sin Internet

**Cómo se guarda la copia:**
- Cada vez que abres un juego con conexión, el launcher guarda en segundo plano una copia en `data\offline\<juego>\` (D1 ~10 MB, D2 ~36 MB, Scud ~24 MB). También puedes guardarla con **Save now** en la tarjeta.
- La lista de archivos sale del árbol del repo en GitHub. Cada archivo se verifica contra su SHA de git.
- Si el repo no cambió, actualizarla cuesta una sola llamada a la API de GitHub.

**Cómo se usa:**
- Sin conexión, la copia se sirve en la misma dirección (`johannruiz.github.io/...`). Así el juego encuentra la ROM y las partidas que guardó en su IndexedDB.
- La tarjeta indica "Offline ready · versión · tamaño · fecha", y el juego en marcha muestra **PLAYING · OFFLINE**.
- El multijugador (PeerJS/Firebase) necesita conexión; el modo de un jugador funciona sin ella.

## Fuentes de force feedback por juego

| Juego | URL | Señal |
|---|---|---|
| Daytona USA | johannruiz.github.io/Daytona-USA-Web-multiplayer-test | `_daytona_wheel_force()` (con signo) → constante; `_daytona_wheel_resistance()` → amortiguador; rumble → vibración |
| Daytona USA 2 | johannruiz.github.io/daytona-usa-2-web | bloque de control palabra 14 (`wheelForce`) → constante; palabras 12-13 → vibración |
| Scud Race | johannruiz.github.io/scudrace-plus-web | palabras 14-17: centrado → resorte, fricción → fricción, vibración → seno, roll → constante; velocidad del coche (RAM 0x1045A0 + 52) → resorte base |

La fuerza solo se envía con la ventana del juego enfocada. Además hay un watchdog: si el juego deja de enviar durante 300 ms, la fuerza vuelve a 0.

## Cómo funciona

- `src/main.cjs`: proceso principal. Configura la GPU, gestiona las ventanas, el IPC y el watchdog.
- `src/remote.cjs`: añade COOP/COEP a D2 y Scud, que necesitan `SharedArrayBuffer`; GitHub Pages no puede enviar cabeceras. Así no hace falta `coi-sw.js` ni recargar la página.
- `src/game/preload.cjs` + `src/game/adapter.js`: el adaptador se ejecuta en la página antes que cualquier script del juego (`contextBridge.executeInMainWorld`). Captura el módulo WASM, lee la drive board a 125 Hz, da forma a las fuerzas y expone el volante SDL3 como mando.
- `src/sdl-bridge.cjs` ↔ `bin/ffb_bridge.exe` (`native/ffb_bridge.c`, SDL 3.4.20): protocolo de texto por stdin/stdout. Ver la cabecera de `ffb_bridge.c`.

## Compilar

```
npm install
npm run build:native   # CMake + Visual Studio 2022 → bin/ffb_bridge.exe + SDL3.dll
npm run dist           # → dist/win-unpacked y luego release/Arcade Launcher (actualiza el programa sin tocar data\)
```

Prueba automática: define la variable `ARCADE_SELFTEST=<carpeta>` y ejecuta la app. Abre los tres juegos y guarda `report.json` y capturas en esa carpeta.
