# Arcade FFB Helper

Un programa pequeño que da force feedback al volante mientras juegas a Daytona USA, Daytona USA 2 o Scud Race **en tu propio navegador** (Chrome o Edge).

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

## Actualizaciones (desde 0.2)

El helper se actualiza solo. Se desactiva en Ajustes → Avanzado → **Actualizar automáticamente**.
- Al arrancar (y una vez al día si sigue abierto) pregunta a GitHub por la última release de este repositorio. Solo manda la petición con `User-Agent: ArcadeFFBHelper/<versión>`, nada sobre el jugador.
- Si hay una versión más nueva, descarga el archivo de su plataforma de esa release, y de ninguna otra dirección. Lo compara con el SHA-256 que GitHub publica para ese archivo; si no coincide, lo descarta.
- Lo instala cuando no hay una carrera en marcha (ni una comprobación de sentido o una prueba). Aparta el archivo en uso (`ArcadeFFBHelper.exe.old`, o la app en la carpeta de ajustes en Mac), pone el nuevo en su lugar y lo arranca. La versión nueva borra la anterior al iniciar. Las páginas de los juegos se reconectan solas.
- Sin scripts, PowerShell, procesos ocultos ni entradas en el registro o en el inicio de Windows: así no se parece a lo que buscan los antivirus (el launcher anterior sí lo hacía). En Windows usa WinHTTP; en Mac, `curl` y `ditto` del sistema.
- Tiene que poder escribir en su carpeta. En Mac la app debe estar en Aplicaciones (u otra carpeta propia), no abierta directamente desde Descargas con la cuarentena de macOS.
- Si una release llevara por error una versión más vieja que su etiqueta, no se reinstala en bucle.
- Quien tenga la 0.1.x debe descargar la 0.2 a mano una vez.

## Cómo funciona

```
Página del juego (Chrome)                    Arcade FFB Helper (bandeja del sistema)
window.arcadeForceFeedback.read()  ──ws──▶  127.0.0.1:47823/ws/game
  cada 8 ms: f <live> <par> <muelle>         aplica los ajustes y manda los efectos
             <amort.> <fricción> <vibración>  por SDL3 (DirectInput / HIDAPI lg4ff en Mac)
             [<zona muerta> <pendiente>]
                                     ◀──── hi <versión> <volante 0|1> <dispositivo>

Página de ajustes  http://127.0.0.1:47823/  ──ws──▶  /ws/ui (estado a 20 Hz, cambios)
```

- La página del juego solo reenvía sus fuerzas. El helper las ajusta: fuerza, par mínimo, suavizado, muelle base, ganancias e invertir.
- **Muelle con forma (desde 0.2).** Un juego puede añadir al final de la línea `f` la zona muerta del muelle (0..0,5 del recorrido de un lado) y su pendiente (fuerza por giro completo). El muelle es entonces el de la placa: sin fuerza en la zona muerta y, pasada ésta, sube hasta su nivel (la saturación).
  - Daytona USA lo usa: su placa tiene una zona muerta del 2 % (6 % con los comandos `0x38–0x3F`) y llega a su nivel en un 8 % más de giro.
  - Un efecto de condición no puede subir más rápido que la fuerza completa a fondo de giro, así que la pendiente se limita a 1. Aun así la curva queda mucho más cerca de la recreativa que el muelle lineal.
  - La fuerza y la ganancia del muelle escalan juntas la saturación y la pendiente. El muelle base sigue siendo lineal y solo manda cuando es el más fuerte.
  - Sin esos dos campos (Daytona USA 2, Scud Race) el muelle es lineal, igual que en 0.1: pendiente = nivel, sin saturación ni zona muerta. Un helper 0.1 ignora los campos que sobran.
  - Algunos drivers ignoran la saturación o la zona muerta; en ellos el muelle queda como el lineal.
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
   - Opcional (helper 0.2): `springDeadZone` y `springSlope` para un muelle con la forma de la placa. El cliente solo los envía si los dos son números.

| Juego | `arcadeForceFeedback` | Opción FFB Helper |
|---|---|---|
| Daytona USA 2 | desde 0.10.2 | desde 0.10.3 (Ajustes → Experimental) |
| Scud Race Plus | desde 0.11 | pendiente |
| Daytona USA | desde 53.8.62 (muelle con forma) | desde 53.8.62 (Ajustes → Experimental) |

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

`tools/protocol-test.cjs` comprueba el protocolo contra el helper en marcha, sin volante, y mira su `/report`. Cubre el muelle lineal de Daytona USA 2 y Scud, el muelle con forma de Daytona USA y las entradas fuera de rango. Necesita Playwright y una página HTML servida desde un origen permitido (`TEST_PAGE`).

Para probar la actualización sin publicar nada, arranca una copia en una carpeta aparte con `--background --pretend-version 0.1.0`: se comporta como esa versión, descarga la última release, se reemplaza y arranca la nueva.

Para publicar una versión: sube `VERSION` en `project()` de `CMakeLists.txt`, haz commit y empuja una etiqueta `vX.Y.Z`. GitHub Actions compila y adjunta el exe y la app a la Release.

## Estado

Probado en Windows 11 sin volante conectado:
- conexión con Daytona USA 2 en Chrome (par ±0,65 en carrera, 0 en pausa);
- ajustes, pruebas, informe;
- rechazo de orígenes y hosts ajenos;
- actualización automática (0.2.0 haciéndose pasar por 0.1.0: descarga la 0.1.1, comprueba el SHA-256, se reemplaza y arranca en unos 6 s; protección contra bucles; borrado del `.old`).

Falta probar:
- un volante real (G29, G923, Thrustmaster, Fanatec, Moza…);
- macOS, incluida la actualización automática de la app;
- Safari y Firefox.

## Historial

Este repositorio fue antes **Arcade Launcher**, un launcher en Electron para los mismos juegos. Se retiró el 2026-11-21 en favor de este helper; su código sigue en el historial de git (hasta el commit `9c2cf4a`).
