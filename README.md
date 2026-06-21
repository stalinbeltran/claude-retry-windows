# claude-retry

Equivalente Windows-nativo de `claude-auto-retry`. Es un **envoltorio** alrededor
de `claude` en su **modo no interactivo** (`-p` / `--print`): reenvía todos los
argumentos al CLI real y añade la lógica de **detectar el límite de uso → esperar →
reintentar** automáticamente.

Corre en Node nativo (no necesita `tmux`, `bash` ni dependencias externas).

## Características

- **Modo no interactivo** — pensado para `claude -p "..."`: una tarea, claude la
  ejecuta y termina. Sin TUI ni pseudo-terminal.
- **Salida en vivo (passthrough a tu terminal)** — lo que claude escribe en su
  stdout/stderr se reenvía a tu consola en cuanto llega, no al final. No es
  streaming de red: es un *passthrough* del proceso hijo a `process.stdout`/`stderr`.
- **Detección de límite en dos capas** — patrones definitivos + detección
  estadística de variantes no catalogadas (ver abajo).
- **Detección en vivo** — escanea la salida a medida que llega y reacciona a mitad,
  sin esperar a que el proceso termine.
- **Reintento automático** — al detectar un rate limit, calcula cuánto falta para
  el reinicio (con conversión de zona horaria), espera y vuelve a lanzar el comando.
- **Respuestas automáticas** — reenvío automático del modo de permisos
  (`CR_PERMISSION_MODE`) y opción de retomar la conversación al reintentar
  (`CR_CONTINUE_ON_RETRY`).
- **Multi-turno con `-a`** — si claude termina haciéndote una pregunta, respondes
  con `-a "tu respuesta"` y la conversación continúa (con `--continue` por debajo),
  sin TUI. Ver [Responder a una pregunta](#opción-4--responder-a-una-pregunta-multi-turno).
- **Limpieza de procesos** — en Windows usa `taskkill /T /F` para no dejar
  procesos huérfanos al cortar la sesión.

## Requisitos

- [Node.js](https://nodejs.org/) (probado con v24).
- El CLI `claude` instalado y accesible en el `PATH`.

No hay dependencias de npm: el wrapper es un único archivo Node.

## Uso

Todo lo que pongas detrás se pasa tal cual a `claude`. Úsalo siempre con `-p`
(o `--print`):

```powershell
node claude-retry.mjs -p "<tu prompt>" <cualquier otro flag de claude>
```

Cuando se alcanza el límite verás un mensaje como:

```
[claude-retry] Limite de uso detectado. Esperando 18000s (reintento 1/5 ~ 14:30:00)...
```

### Opción 1 — Una tarea de un solo turno (lo más común)

Claude ejecuta el prompt y termina.

```powershell
node claude-retry.mjs -p "Resume el archivo README.md en 5 viñetas"
```

### Opción 2 — Que cree o modifique archivos (necesita permisos)

En modo no interactivo, claude necesita permiso para escribir. Reenvía el flag
nativo:

```powershell
node claude-retry.mjs -p "Crea un script app.py con un servidor web minimo" --permission-mode acceptEdits
```

`acceptEdits` auto-aprueba las ediciones de archivos. También puedes fijarlo de
forma permanente con `CR_PERMISSION_MODE` (ver [Respuestas automáticas](#respuestas-automáticas)).

### Opción 3 — Canalizar datos por stdin

El wrapper respeta el piping. Útil para pasarle el contenido de un archivo:

```powershell
Get-Content .\app.py -Raw | node claude-retry.mjs -p "Revisa este codigo y dime si tiene bugs"
```

### Opción 4 — Responder a una pregunta (multi-turno)

El modo `-p` es de un solo turno: claude ejecuta y termina. Si termina haciéndote una
**pregunta** (p. ej. "¿uso JWT o cookies?"), no se queda esperando. Para no perder el
hilo, **tras cada ejecución** el wrapper **guarda la sesión** (los flags usados) y te
dice cómo continuar. Respondes con `-a` y la conversación sigue:

```powershell
node claude-retry.mjs -p "refactoriza el login" --permission-mode acceptEdits
# ...claude responde y pregunta: ¿Uso JWT o cookies?
# [claude-retry] Parece que claude te hizo una pregunta.
# [claude-retry] Sesion guardada. Para responder y continuar (desde este mismo directorio):
#     node claude-retry.mjs -a "tu respuesta"

node claude-retry.mjs -a "usa JWT"
# ...claude retoma TODO el contexto y continúa. Si vuelve a preguntar, repites el ciclo.
```

Detalles:

- **Mismo directorio.** Lanza el `-a` desde el mismo `cwd` que el `-p`: tanto el estado
  guardado como `claude --continue` están ligados al directorio de trabajo.
- **Reusa tus flags.** La respuesta reaprovecha los flags del turno anterior
  (`--permission-mode`, `--model`, …); no hace falta repetirlos. Puedes añadir flags
  extra en el `-a` si quieres (`node claude-retry.mjs -a "usa JWT" --model opus`).
- **El contexto lo guarda claude**, no el wrapper: `-a` añade `--continue` por debajo,
  que retoma la última conversación del directorio. El wrapper solo persiste *cómo*
  relanzar el comando.
- **Reintento por límite incluido.** Si el turno de respuesta topa con el límite de
  uso, se aplica el mismo ciclo de esperar y reintentar.
- **Texto que empieza por `-`.** Usa la forma con `=`: `-a="-y, usa esa opción"`.
- Para desactivar el guardado y el aviso, pon `CR_SESSION=off`.

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
| `CR_PERMISSION_MODE`     | off     | si tiene valor, reenvía `--permission-mode <valor>` cuando el comando no trae uno (`acceptEdits`, `plan`, `bypassPermissions`) |
| `CR_CONTINUE_ON_RETRY`   | off     | añade `--continue` al reintentar para retomar la conversación |
| `CR_DETECTION_PRECISION` | 70      | precisión requerida (0-100, o 0-1) para la detección **estadística** de variantes no catalogadas |
| `CR_DETECT_DEBUG`        | off     | imprime la puntuación y las señales que casaron en cada detección |
| `CR_TRANSCRIPT`          | off     | ruta de archivo donde volcar TODA la salida (stdout+stderr en bruto, incluidos los reintentos) |
| `CR_SESSION`             | on      | guarda la sesión tras cada ejecución para poder responder con `-a` (ver [Opción 4](#opción-4--responder-a-una-pregunta-multi-turno)). `off` lo desactiva |
| `CR_STATE_DIR`           | auto    | carpeta del estado de sesión (def `~/.claude-retry/sessions`); se indexa por directorio de trabajo |
| `CR_INVOCATION`          | auto    | cómo se muestra el comando en el aviso de "responde con `-a` …" (p. ej. `cr` si usas ese alias) |

### Detección de límite (dos capas)

El límite se detecta de dos formas complementarias, escaneando la salida combinada
(stdout + stderr):

1. **Patrones definitivos** — frases inequívocas del banner real (`usage limit
   reached`, `You've hit your session limit`, `5-hour limit reached`,
   `rate_limit_error`, `429 Too Many Requests`, etc.). Si una casa, dispara el
   reintento de inmediato. Cubren todas las variantes conocidas.
2. **Detección estadística** — para frases **nuevas/no catalogadas**, suma pesos de
   muchas señales parciales (`session limit`, `hit your … limit`, `resets <hora>`,
   `/upgrade`, `quota exceeded`, …) y obtiene una confianza `0..1`. Si alcanza el
   umbral `CR_DETECTION_PRECISION`, dispara el reintento. Así se evita depender de una
   única frase exacta, sin caer en falsos positivos cuando claude menciona "rate
   limit" o "429" en una respuesta normal.

`CR_DETECTION_PRECISION` es ese umbral: más alto = más estricto (menos falsos
positivos, puede perder variantes débiles); más bajo = más sensible. Acepta tanto
`85` como `0.85`. Usa `CR_DETECT_DEBUG=1` para ver la confianza y calibrarla:

```powershell
$env:CR_DETECTION_PRECISION = 85; $env:CR_DETECT_DEBUG = 1
node claude-retry.mjs -p "..."
```

> El test `node tests/test-detection.mjs` valida la detección (incluido el caso real
> `"You've hit your session limit · resets 12:30pm (America/Panama)"`) y el parseo
> de la hora de reinicio con zona horaria.

### Respuestas automáticas

**Auto-permisos.** En modo `-p`, claude necesita permiso para editar o ejecutar. En
vez de pasar el flag a mano cada vez, fija `CR_PERMISSION_MODE`: si tiene valor, el
wrapper añade `--permission-mode <valor>` cuando el comando no trae ya uno (ni
`--dangerously-skip-permissions`):

```powershell
$env:CR_PERMISSION_MODE = "acceptEdits"
node claude-retry.mjs -p "Crea un script app.py con un servidor web minimo"
```

> ⚠️ `acceptEdits` (o `bypassPermissions`) aprueba **cualquier** edición/ejecución
> sin preguntar, incluidas operaciones destructivas. Úsalo solo cuando confíes en la
> tarea. Déjalo vacío para que claude aplique su política por defecto.

**Continuar tras el límite.** Por defecto, al reintentar tras un límite el wrapper
relanza el comando desde cero (se pierde el contexto). Con `CR_CONTINUE_ON_RETRY`
activado, añade `--continue` en el reintento para que claude **retome** la
conversación anterior:

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
[claude-retry] Limite de uso detectado. Esperando 7s (reintento 1/5 ~ 09:34:16)...
[fake-claude] intento 2: trabajo completado con exito. TODO OK.
```

### Tests automáticos (sin gastar cuota)

Todos los tests se ejecutan con `npm test` (o cada uno por separado):

```powershell
npm test                 # detección (unitario) + reintento (e2e por tuberías)
npm run test:detection   # solo node tests/test-detection.mjs
npm run test:retry       # solo node tests/test-retry.mjs
```

`tests/test-detection.mjs` valida las dos capas de detección y el parseo de la hora
de reinicio (incluido el caso real que fallaba y casos negativos que **no** deben
disparar el reintento) → `RESULTADO: 20 ok, 0 fallos`.

`tests/test-retry.mjs` es un test **end-to-end**: lanza el wrapper real en modo `-p`
contra `tests/fake-claude.cmd` (un claude falso de un disparo) y comprueba que detecta
el límite, espera y reintenta hasta completar con éxito → `RESULTADO E2E: 2 ok, 0 fallos`.

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
motor estable, y edita el repo aparte.

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
(detalladas en [Detección de límite](#detección-de-límite-dos-capas)). Cuando
detecta el límite:

1. Intenta leer la hora de reinicio del mensaje (formatos como *"reset in 2 hours"*,
   *"try again at 3pm"*, *"reset at 15:00"*, *"resets 12:30pm (America/Panama)"* —
   con conversión de zona horaria).
2. Si la lee, espera hasta esa hora + `CR_MARGIN_SECONDS`.
3. Si no la lee, espera `CR_FALLBACK_HOURS`.
4. Reintenta hasta `CR_MAX_RETRIES` veces.

## Archivos del repositorio

| Archivo            | Descripción                                            |
|--------------------|--------------------------------------------------------|
| `claude-retry.mjs` | El wrapper (modo no interactivo / `-p`).               |
| `package.json`     | Metadatos y scripts de test (sin dependencias).        |
| `tests/`           | Tests y "claude falsos" (ver abajo).                   |
| `index.html`       | Demo de página estática (no usada por el wrapper).     |

Dentro de `tests/`:

| Archivo                          | Descripción                                            |
|----------------------------------|--------------------------------------------------------|
| `test-detection.mjs`             | Test unitario de la detección de límite y parseo de hora. |
| `test-multiturn.mjs`             | Test unitario de los helpers del modo `-a` (multi-turno). |
| `test-retry.mjs`                 | Test e2e del bucle de reintento en modo `-p`.          |
| `fake-claude.cmd` / `.mjs`       | Claude falso (un disparo) que simula un rate limit.    |
| `fake-claude-variants.cmd` / `.mjs` | Claude falso con variantes de banner (`FAKE_VARIANT`). |
