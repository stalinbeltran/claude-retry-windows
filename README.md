# claude-retry

Equivalente Windows-nativo de `claude-auto-retry`. Es un **envoltorio** alrededor
de `claude`: reenvía todos los argumentos al CLI real y añade la lógica de
**detectar el límite de uso → esperar → reintentar** automáticamente.

Corre en Node nativo (no necesita `tmux` ni `bash`).

## Características

- **Streaming en vivo** — la salida de claude (incluidas las preguntas de
  aclaración) se ve en tiempo real, no al final.
- **Detección de límite en vivo** — reacciona a mitad del stream, sin esperar a
  que el proceso termine.
- **Reintento automático** — al detectar un rate limit, calcula cuánto falta para
  el reinicio, espera y vuelve a lanzar el comando.
- **Limpieza de procesos** — en Windows usa `taskkill /T /F` para no dejar
  procesos huérfanos al cortar la sesión.

## Requisitos

- [Node.js](https://nodejs.org/) (probado con v24).
- El CLI `claude` instalado y accesible en el `PATH`.
- (Opcional, para el modo interactivo con reintento) la dependencia `node-pty`:

  ```powershell
  npm install
  ```

  Sin `node-pty` el modo interactivo sigue funcionando, pero como passthrough
  transparente: **sin** detección de límite ni reintento en ese modo.

## Uso

Todo lo que pongas detrás se pasa tal cual a `claude`:

```powershell
node claude-retry.mjs <cualquier flag de claude>
```

Cuando se alcanza el límite verás un mensaje como:

```
[claude-retry] Limite de uso detectado. Esperando 18000s (reintento 1/5 ~ 14:30:00)...
```

### Opción 1 — Una tarea de un solo turno (lo más común)

El modo para el que está pensado. Claude ejecuta el prompt y termina.

```powershell
node claude-retry.mjs -p "Resume el archivo README.md en 5 viñetas"
```

### Opción 2 — Que cree o modifique archivos (necesita permisos)

En modo no interactivo, claude necesita permiso para escribir. Reenvía el flag:

```powershell
node claude-retry.mjs -p "Crea un script app.py con un servidor web minimo" --permission-mode acceptEdits
```

`acceptEdits` auto-aprueba las ediciones de archivos.

### Opción 3 — Canalizar datos por stdin

El wrapper respeta el piping. Útil para pasarle el contenido de un archivo:

```powershell
Get-Content .\app.py -Raw | node claude-retry.mjs -p "Revisa este codigo y dime si tiene bugs"
```

### Opción 4 — Modo interactivo (conversación)

Lánzalo **sin `-p`**. Si `node-pty` está instalado, claude corre dentro de un
pseudo-terminal (PTY) real, así que su interfaz interactiva funciona con
normalidad y a la vez seguimos detectando el límite y reintentando:

```powershell
node claude-retry.mjs
```

> **Cómo funciona:** el modo interactivo de claude es una aplicación de terminal
> (TUI) que necesita un TTY real para dibujarse. Un simple `pipe` se lo quita; por
> eso usamos `node-pty`, que le da un TTY y a la vez nos deja leer la salida para
> detectar el límite.
>
> **Nota:** si se alcanza el límite en mitad de una sesión interactiva, el wrapper
> reinicia claude tras la espera. Como es un proceso nuevo, **se pierde el contexto
> de la conversación** (puedes retomar con `claude --continue` manualmente).

## Configuración (variables de entorno)

Se fijan **antes** del comando, en la misma sesión de PowerShell, **o en un
archivo `.env`** en el directorio de trabajo (se carga automáticamente; las
variables ya presentes en el entorno tienen prioridad sobre el `.env`). Todas son
opcionales.

| Variable                 | Default | Qué controla                                      |
|--------------------------|---------|---------------------------------------------------|
| `CR_MAX_RETRIES`         | 5       | reintentos máximos tras detectar el límite        |
| `CR_MARGIN_SECONDS`      | 30      | margen extra tras la hora de reinicio detectada   |
| `CR_FALLBACK_HOURS`      | 5       | espera si no logra leer la hora de reinicio       |
| `CR_CLAUDE_BIN`          | auto    | ruta a un binario de claude alternativo           |
| `CR_AUTO_CONFIRM`        | on      | auto-responde los prompts de confirmación (modo interactivo); `=0` lo apaga |
| `CR_AUTO_CONFIRM_KEY`    | Enter   | tecla a enviar al auto-confirmar (`enter`, `1`, `y`...) |
| `CR_CONTINUE_ON_RETRY`   | off     | añade `--continue` al reintentar para retomar la conversación |
| `CR_DETECTION_PRECISION` | 70      | precisión requerida (0-100, o 0-1) para la detección **estadística** de variantes no catalogadas |
| `CR_DETECT_DEBUG`        | off     | imprime la puntuación y las señales que casaron en cada detección |
| `CR_VERIFY`              | on      | [interactivo] verifica con una sonda antes de asumir el límite (anti falso positivo); `=0` corta de inmediato |
| `CR_VERIFY_IDLE_MS`      | 1500    | ms que la salida debe estar quieta tras el patrón antes de sondear |
| `CR_VERIFY_WINDOW_MS`    | 8000    | ms de espera a la respuesta de la sonda antes de decidir |

### Detección de límite (dos capas)

El límite se detecta de dos formas complementarias:

1. **Patrones definitivos** — frases inequívocas del banner real (`usage limit
   reached`, `You've hit your session limit`, `5-hour limit reached`,
   `rate_limit_error`, `429 Too Many Requests`, etc.). Si una casa, dispara el
   reintento de inmediato. Cubren todas las variantes conocidas.
2. **Detección estadística** — para frases **nuevas/no catalogadas**, suma pesos de
   muchas señales parciales (`session limit`, `hit your … limit`, `resets <hora>`,
   `/upgrade`, `quota exceeded`, …) y obtiene una confianza `0..1`. Si alcanza el
   umbral `CR_DETECTION_PRECISION`, dispara el reintento.

`CR_DETECTION_PRECISION` es ese umbral: más alto = más estricto (menos falsos
positivos, puede perder variantes débiles); más bajo = más sensible. Acepta tanto
`85` como `0.85`. Usa `CR_DETECT_DEBUG=1` para ver la confianza y calibrarla:

```powershell
$env:CR_DETECTION_PRECISION = 85; $env:CR_DETECT_DEBUG = 1
node claude-retry.mjs ...
```

> El test `node tests/test-detection.mjs` valida la detección (incluido el caso real
> `"You've hit your session limit · resets 12:30pm (America/Panama)"`) y el parseo
> de la hora de reinicio con zona horaria.

### Verificación anti falso positivo (modo interactivo)

El patrón de límite se escanea sobre **toda** la salida de claude, incluido el
texto normal de la conversación. Eso provoca falsos positivos cuando claude solo
**menciona** el límite (p. ej. al revisar un proyecto sobre cuotas como este). Para
evitar cortar la sesión por error, en modo interactivo el wrapper **no mata claude
de inmediato** al ver el patrón:

1. **Compuerta de inactividad.** Mientras claude siga generando texto, no se hace
   nada (no se interrumpe una respuesta en curso). Solo cuando la salida lleva
   `CR_VERIFY_IDLE_MS` quieta tras el patrón se pasa a verificar.
2. **Sonda.** Se envía un mensaje real (`continue`) para forzar a claude a intentar
   responder, y se abre una ventana de `CR_VERIFY_WINDOW_MS`:
   - Si **reaparece el banner** de límite → es real → espera y reintenta.
   - Si claude **responde con normalidad** → falso positivo → la sesión continúa.
   - Si **no hay respuesta** a la sonda → se asume límite real (conservador).

Costo: la sonda añade un turno `continue` a la conversación. Desactívalo con
`CR_VERIFY=0` para volver al corte inmediato. Solo aplica al modo interactivo; en
`-p` (un solo disparo) se mantiene la detección directa.

> **Limitación conocida:** si una respuesta legítima *repite* el patrón justo
> mientras se sondea (o la TUI redibuja ese texto), puede confirmarse como límite
> real. Sube `CR_VERIFY_IDLE_MS`/`CR_VERIFY_WINDOW_MS` o usa `CR_VERIFY=0` si te
> afecta.

### Respuestas automáticas

**Auto-confirmar prompts de permiso (modo interactivo).** En una sesión
interactiva, claude pregunta *"Do you want to proceed?"* antes de ejecutar o
editar. **Está activado por defecto**: el wrapper detecta ese prompt y responde
solo (pulsa Enter, que elige la opción resaltada *"Yes"*). No tienes que
configurar nada:

```powershell
node claude-retry.mjs        # cada confirmación se acepta automáticamente
```

Para **apagarlo** (volver a confirmar tú a mano):

```powershell
$env:CR_AUTO_CONFIRM = "0"
node claude-retry.mjs
```

> ⚠️ Al estar activado por defecto, aprueba **cualquier** confirmación, incluidas
> operaciones destructivas. Apágalo con `CR_AUTO_CONFIRM=0` si quieres revisar cada
> acción. En modo `-p` no aplica: usa el flag nativo
> `--permission-mode acceptEdits` (ver Opción 2).

Para enviar otra tecla en vez de Enter (p. ej. seleccionar la opción 1
explícitamente): `$env:CR_AUTO_CONFIRM_KEY = "1"`.

**Continuar tras el límite.** Por defecto, al reintentar tras un límite el
wrapper relanza el comando desde cero (se pierde el contexto). Con
`CR_CONTINUE_ON_RETRY` activado, añade `--continue` en el reintento para que
claude **retome** la conversación anterior:

```powershell
$env:CR_CONTINUE_ON_RETRY = "1"
node claude-retry.mjs -p "tarea larga que podría tocar el límite"
```

Ejemplo — más reintentos y más margen:

```powershell
$env:CR_MAX_RETRIES = "10"
$env:CR_MARGIN_SECONDS = "60"
node claude-retry.mjs -p "tarea larga que podria tocar el limite"
```

Limpiar esos ajustes después:

```powershell
Remove-Item Env:CR_MAX_RETRIES, Env:CR_MARGIN_SECONDS
```

## Probar sin gastar cuota

Los tests y los "claude falsos" viven en la carpeta [`tests/`](tests). El
repositorio incluye un "claude falso" (`tests/fake-claude.cmd` /
`tests/fake-claude.mjs`) que simula un límite en la 1ª llamada y responde con
éxito en la 2ª, para experimentar con el ciclo de reintento:

```powershell
Remove-Item .\tests\.rl-counter -ErrorAction SilentlyContinue   # reinicia el contador
$env:CR_CLAUDE_BIN = (Resolve-Path .\tests\fake-claude.cmd).Path
$env:CR_FALLBACK_HOURS = "0.002"                          # espera ~7s en vez de horas
node claude-retry.mjs -p "tarea de prueba"
Remove-Item Env:CR_CLAUDE_BIN, Env:CR_FALLBACK_HOURS       # vuelve al claude real
```

Salida esperada:

```
[fake-claude] intento 1: Error 429 — usage limit reached. Please try again later.
[claude-retry] Limite de uso detectado. Esperando 7s (reintento 1/3 ~ 09:34:16)...
[fake-claude] intento 2: trabajo completado con exito. TODO OK.
```

### Tests automáticos (sin gastar cuota)

Todos los tests se ejecutan con `npm test` (o cada uno por separado):

```powershell
npm test                 # detección (unitario) + verificación (e2e por PTY)
npm run test:detection   # solo node tests/test-detection.mjs
npm run test:verify      # solo node tests/test-verify.mjs
```

`tests/test-detection.mjs` valida las dos capas de detección y el parseo de la hora
de reinicio (incluido el caso real que fallaba y casos negativos que **no** deben
disparar el reintento) → `RESULTADO: 20 ok, 0 fallos`.

`tests/test-verify.mjs` es un test **end-to-end**: lanza el wrapper real por PTY
contra `tests/fake-claude-interactive.cmd` (un claude falso que se mantiene vivo) y
comprueba los tres caminos de la verificación anti falso positivo: límite real
(reaparece el banner), falso positivo (responde normal) y `CR_VERIFY=0` (corte
inmediato) → `RESULTADO E2E: 3 ok, 0 fallos`.

### Probar todas las variantes end-to-end

`tests/fake-claude-variants.cmd` / `.mjs` emite distintos banners de límite (elige con
`FAKE_VARIANT`): `real` (el caso `You've hit your session limit · resets 12:30pm
(America/Panama)`), `usage`, `fivehour`, `weekly`, `notime` y `novel` (una frase
**no catalogada** que solo detecta la capa estadística). En la 1ª llamada simula el
límite; en la 2ª responde con éxito.

Bucle completo rápido (detección → espera → reintento → éxito):

```powershell
Remove-Item .\tests\.rl-counter-* -ErrorAction SilentlyContinue
$env:CR_CLAUDE_BIN = (Resolve-Path .\tests\fake-claude-variants.cmd).Path
$env:FAKE_VARIANT = "notime"
$env:CR_FALLBACK_HOURS = "0.0009"   # ~3s en vez de horas
node claude-retry.mjs -p "tarea de prueba"
Remove-Item Env:CR_CLAUDE_BIN, Env:FAKE_VARIANT, Env:CR_FALLBACK_HOURS
Remove-Item .\tests\.rl-counter-* -ErrorAction SilentlyContinue
```

Para ver **cómo** se detecta cada variante (patrón definitivo vs. confianza
estadística) sin esperar la cuenta atrás real, activa el modo debug y prueba la
variante que quieras (`real`, `novel`, …):

```powershell
$env:CR_CLAUDE_BIN = (Resolve-Path .\tests\fake-claude-variants.cmd).Path
$env:FAKE_VARIANT = "novel"; $env:CR_DETECT_DEBUG = "1"
node claude-retry.mjs -p "x"   # Ctrl+C tras ver la línea de detección
```

```
[claude-retry][detect] confianza=0.90 umbral=0.70 -> LIMITE | senales: resets-at-time(+0.5), out-of(+0.4)
[claude-retry] Limite de uso detectado. Esperando 81770s ...
```

## Atajo opcional (alias en PowerShell)

Si lo vas a usar seguido, añade una función a tu perfil:

```powershell
notepad $PROFILE   # abre tu perfil (créalo si no existe)
```

Pega dentro:

```powershell
function cr { node "C:\Desarrollo\claude-auto-retry\claude-retry.mjs" @args }
```

Tras reiniciar PowerShell:

```powershell
cr -p "tu prompt aqui"
```

## Desarrollo: modificar el wrapper usándolo a él mismo

Problema: si editas `claude-retry.mjs` y lo rompes, te quedas sin la herramienta
que usabas para trabajar. Solución: usa una **instalación global congelada** como
motor estable, e edita el repo aparte.

### 1. Instalar el comando global (una vez)

```powershell
npm install -g .
```

Esto **copia** el proyecto a la ubicación global de npm y crea el comando
`claude-retry`. Es independiente del repo: editar `claude-retry.mjs` aquí **no**
cambia el comando global hasta que lo promuevas.

### 2. Trabajar

- Para **hacer el trabajo** (incluido editar este proyecto), usa el comando global
  estable: `claude-retry -p "..."`.
- Edita libremente `claude-retry.mjs` en el repo. Aunque lo dejes a medias o roto,
  el comando global sigue intacto.

### 3. Probar la versión en edición del repo

Siempre ejecutándola con `node claude-retry.mjs` (la del repo), **no** con el
comando global. Tienes dos formas:

**a) Sin gastar cuota — con el claude falso** (para validar la lógica de reintento):

```powershell
Remove-Item .\tests\.rl-counter -ErrorAction SilentlyContinue
$env:CR_CLAUDE_BIN = (Resolve-Path .\tests\fake-claude.cmd).Path
$env:CR_FALLBACK_HOURS = "0.002"
node claude-retry.mjs -p "prueba"          # ejecuta la versión EN EDICIÓN del repo
Remove-Item Env:CR_CLAUDE_BIN, Env:CR_FALLBACK_HOURS
```

**b) Con el claude real** (cuando una prueba lo requiera). Basta con NO fijar
`CR_CLAUDE_BIN`; la versión en edición usará el `claude` real:

```powershell
node claude-retry.mjs -p "responde solo: OK"
```

> Mientras desarrollas, el comando global `claude-retry` sigue siendo tu motor
> estable, y `node claude-retry.mjs` es la versión en pruebas. Son independientes.

### 4. Promover la versión validada al comando global (manual)

Esto **lo decides tú**; no es automático. Cuando el cambio esté verificado y
quieras que el comando global lo incluya:

```powershell
npm run promote        # alias de: npm install -g .
```

Para **confirmar** que el global se actualizó, vuelve a probarlo:

```powershell
claude-retry -p "responde solo: OK"
```

Para **revertir** si algo sale mal:

- El archivo del repo: `git checkout claude-retry.mjs` (vuelve al último commit).
- El comando global: corrige el repo y vuelve a ejecutar `npm run promote`.

> **Instrucción lista para darle a claude:**
> *"Edita `claude-retry.mjs` y verifícalo con `node claude-retry.mjs` (con el claude
> falso vía `CR_CLAUDE_BIN`, o con el claude real cuando la prueba lo requiera). NO
> ejecutes `npm run promote` por tu cuenta: la promoción al comando global la haré
> yo manualmente solo cuando lo ordene."*

## Cómo detecta el límite

El wrapper escanea la salida combinada (stdout + stderr) en **dos capas**
(detalladas en [Detección de límite](#detección-de-límite-dos-capas)):

1. **Patrones definitivos** — frases inequívocas del banner real (`usage limit
   reached`, `You've hit your session limit`, `5-hour limit reached`,
   `rate_limit_error`, `429 Too Many Requests`…). Cualquier coincidencia dispara el
   reintento al instante.
2. **Detección estadística** — para variantes no catalogadas, suma pesos de muchas
   señales parciales y dispara si la confianza alcanza `CR_DETECTION_PRECISION`. Así
   se evita depender de una única frase exacta, sin caer en falsos positivos cuando
   claude menciona "rate limit" o "429" en una respuesta normal.

Cuando detecta el límite:

1. Intenta leer la hora de reinicio del mensaje (formatos como *"reset in 2 hours"*,
   *"try again at 3pm"*, *"reset at 15:00"*, *"resets 12:30pm (America/Panama)"* —
   con conversión de zona horaria).
2. Si la lee, espera hasta esa hora + `CR_MARGIN_SECONDS`.
3. Si no la lee, espera `CR_FALLBACK_HOURS`.
4. Reintenta hasta `CR_MAX_RETRIES` veces.

## Archivos del repositorio

| Archivo            | Descripción                                            |
|--------------------|--------------------------------------------------------|
| `claude-retry.mjs` | El wrapper.                                             |
| `package.json`     | Metadatos, scripts de test y dependencia `node-pty`.   |
| `tests/`           | Tests y "claude falsos" (ver abajo).                   |
| `app.py`           | Demo: servidor web mínimo con la librería estándar.    |
| `index.html`       | Demo: página servida por `app.py`.                     |

Dentro de `tests/`:

| Archivo                          | Descripción                                            |
|----------------------------------|--------------------------------------------------------|
| `test-detection.mjs`             | Test unitario de la detección de límite y parseo de hora. |
| `test-verify.mjs`                | Test e2e (por PTY) de la verificación anti falso positivo. |
| `fake-claude.cmd` / `.mjs`       | Claude falso (un disparo) que simula un rate limit.    |
| `fake-claude-variants.cmd` / `.mjs` | Claude falso con variantes de banner (`FAKE_VARIANT`). |
| `fake-claude-interactive.cmd` / `.mjs` | Claude falso interactivo que responde a la sonda (`FAKE_SCENARIO`). |
| `drive-ac.mjs`                   | Driver manual del auto-confirm (requiere claude real). |
