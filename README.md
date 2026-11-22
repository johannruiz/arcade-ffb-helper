# Arcade FFB Helper

Un programa pequeño que da force feedback al volante mientras juegas a Daytona USA 2 o Scud Race **en tu propio navegador** (Chrome o Edge).

**Descarga:** [última versión](https://github.com/johannruiz/arcade-ffb-helper/releases/latest).
- **Windows:** `ArcadeFFBHelper.exe`, un solo archivo de unos 2,5 MB. No hay que instalar nada.
- **macOS (Apple Silicon):** `Arcade-FFB-Helper-mac-arm64.zip`, que contiene la app.

Hace solo esto:
- dice si hay un juego conectado y si está en carrera;
- muestra las fuerzas que envía el juego y las que llegan al volante;
- reúne todos los ajustes del volante y de sus fuerzas: dispositivo, sentido de la fuerza, fuerza, ganancias, muelle de centrado, fuerza mínima, suavizado, invertir por juego y pruebas.

La asignación de controles (qué eje es el volante, pedales, botones) se queda en la interfaz de cada juego, que ya lee el volante con la Gamepad API del navegador.

## Uso

1. Abre `ArcadeFFBHelper.exe` (en Mac, la app). Queda un icono en la bandeja del sistema (en la barra de menús en Mac) y se abre su página de ajustes en `http://127.0.0.1:47823/`.
2. Con el volante conectado y **suelto**, pulsa **Comprobar sentido** en la tarjeta «Volante». Basta una vez por volante.
3. Abre el juego, por ejemplo [Daytona USA 2](https://johannruiz.github.io/daytona-usa-2-web/). En Ajustes → Experimental, activa **Force feedback with FFB Helper**.
4. La primera vez, Chrome pregunta si el sitio puede acceder a apps de este dispositivo (acceso a la red local). Hay que permitirlo. Si se deniega, se reactiva en el icono a la izquierda de la dirección → Configuración del sitio.

## Cómo funciona

```
Página del juego (Chrome)                    Arcade FFB Helper (bandeja del sistema)
window.arcadeForceFeedback.read()  ──ws──▶  127.0.0.1:47823/ws/game
  cada 8 ms: f <live> <par> <muelle>         aplica los ajustes y manda los efectos
             <amort.> <fricción> <vibración>  por SDL3 (DirectInput / HIDAPI lg4ff en Mac)
                                     ◀──── hi <versión> <volante 0|1> <dispositivo>

Página de ajustes  http://127.0.0.1:47823/  ──ws──▶  /ws/ui (estado a 20 Hz, cambios)
```

- La página del juego solo reenvía sus fuerzas. El helper las ajusta: fuerza, par mínimo, suavizado, muelle base, ganancias e invertir.
- Si la página deja de enviar durante 300 ms (pestaña congelada o en segundo plano, suspensión), el helper pone todas las fuerzas a 0 por su cuenta.
- A un mando sin efectos de volante no se le envía nada: conserva la vibración propia del juego.
- **Sentido de la fuerza, medido en cada volante.** El signo de una fuerza constante no es el mismo en todos los volantes ni drivers. La convención de SDL (la dirección es de dónde viene la fuerza) hace que un nivel positivo empuje a la izquierda, y así se ha medido en un Moza y un G923 por DirectInput; en un G29 se ha visto el contrario.
  - «Comprobar sentido» da, con el volante suelto, un empujón corto de cada lado y lee el eje de la dirección.
  - Guarda el resultado por nombre de volante (`direction=` en `settings.ini`); «Invertir» lo corrige a mano.
  - Mientras no se haya comprobado, se usa el sentido de SDL.
  - El convenio del juego (+ = derecha) está comprobado en Daytona USA 2: al girar a la derecha, el par medio es −0,40, es decir, centra el volante.
- Los ajustes se guardan en `%APPDATA%\Arcade FFB Helper\settings.ini`, con los registros (`helper.log`, `helper-previous.log`) en la misma carpeta. En macOS están en `~/Library/Application Support/Arcade FFB Helper/`.
- El icono de la bandeja tiene «Force feedback settings» y «Quit». Si el helper se abre por segunda vez, muestra la página de ajustes del que ya está en marcha.
- `--background` arranca sin abrir la página (para el inicio automático).

## Reportar problemas

La página de ajustes tiene la sección **¿Algo no funciona?**:
- **Descargar informe** / **Copiar informe:** genera `arcade-ffb-helper-report-<fecha>.txt` (`GET /report`). Incluye:
  - las versiones del helper, de SDL y del sistema;
  - el volante en uso, con sus IDs USB, sus efectos y los errores al actualizarlos;
  - el sentido de la fuerza, medido o no;
  - todos los dispositivos que ve SDL;
  - los juegos conectados con sus fuerzas actuales;
  - los ajustes;
  - el registro de esta sesión (últimas 600 líneas) y de la anterior.
- **Reportar en GitHub:** abre un issue en este repositorio con un resumen y la indicación de adjuntar el archivo.

El helper no envía nada por sí mismo, y las rutas de la carpeta del usuario aparecen como `~` o `<settings>/`.

El registro anota:
- el arranque y el sistema;
- los dispositivos que aparecen (nombre, `vid:pid`, efectos);
- el volante abierto y los efectos creados;
- los fallos al actualizar efectos;
- las pruebas y la comprobación del sentido;
- los juegos que se conectan;
- cada 10 s de carrera, un resumen: par máximo del juego y del volante, signo usado, muelle y vibración.

## Seguridad

- Solo escucha en `127.0.0.1`.
- `/ws/game` solo acepta los orígenes `https://johannruiz.github.io`, `http://localhost:*` y `http://127.0.0.1:*`, más los que se añadan en Ajustes → Avanzado. Cualquier otra web recibe 403 y no puede mover el volante.
- La página de ajustes, `/report` y `/ws/ui` solo responden a su propio origen y a `Host: 127.0.0.1:47823` o `localhost:47823`, lo que protege contra el DNS rebinding.

## Integración en las páginas de los juegos

1. Incluir `client/arcade-ffb-helper.js` en la página, tal cual, con un `<script>` o un `import`. No hace nada hasta que el jugador lo activa.
2. Añadir en los ajustes del juego un interruptor que llame a `arcadeFfbHelper.enable()` o `disable()`. Su estado se muestra con `arcadeFfbHelper.onChange((status, info) => …)`:
   - `connected`: muestra el nombre del volante (`info.device`) o «sin force feedback» si `info.wheel` es false;
   - `waiting`: «Abre Arcade FFB Helper»;
   - abrir el juego con `?ffb=helper` también lo activa.
3. La página tiene que exponer `window.arcadeForceFeedback` v1 (`read()` → `{constant, spring, damper, friction, rumble, live}`, constant −1..1 con + = derecha, `live` a false en menús, pausa o pestaña oculta).

| Juego | `arcadeForceFeedback` | Opción FFB Helper |
|---|---|---|
| Daytona USA 2 | desde 0.10.2 | desde 0.10.3 (Ajustes → Experimental) |
| Scud Race Plus | desde 0.11 | pendiente |
| Daytona USA | pendiente | pendiente |

## Compilar

```powershell
cmake -S . -B build
cmake --build build --config Release
```

El resultado queda en `out/`: `ArcadeFFBHelper.exe` en Windows y `Arcade FFB Helper.app` en macOS.
- SDL3 3.4.20 se descarga y se compila dentro del ejecutable.
- En Windows el runtime de C también va dentro, así que no hace falta el Visual C++ Redistributable.
- La página de ajustes (`ui/index.html`) se incrusta al compilar.
- `assets/icon.ico` se genera con `node tools/make-ico.cjs`.

Para probar sin juego, `client/test.html` simula un juego (par senoidal, muelle, pulsos de vibración). Sírvelo en `http://localhost:<puerto>/`.

Para publicar una versión: sube `VERSION` en `project()` de `CMakeLists.txt`, haz commit y empuja una etiqueta `vX.Y.Z`. GitHub Actions compila y adjunta el exe y la app a la Release.

## Estado

Probado en Windows 11 sin volante conectado:
- conexión con Daytona USA 2 en Chrome (par ±0,65 en carrera, 0 en pausa);
- ajustes, pruebas, informe;
- rechazo de orígenes y hosts ajenos.

Falta probar:
- un volante real (G29, G923, Thrustmaster, Fanatec, Moza…);
- macOS;
- Safari y Firefox.

## Historial

Este repositorio fue antes **Arcade Launcher**, un launcher en Electron para los mismos juegos. Se retiró el 2026-11-21 en favor de este helper; su código sigue en el historial de git (hasta el commit `9c2cf4a`).
