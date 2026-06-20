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

Se fijan **antes** del comando, en la misma sesión de PowerShell. Todas son
opcionales.

| Variable               | Default | Qué controla                                      |
|------------------------|---------|---------------------------------------------------|
| `CR_MAX_RETRIES`       | 5       | reintentos máximos tras detectar el límite        |
| `CR_MARGIN_SECONDS`    | 30      | margen extra tras la hora de reinicio detectada   |
| `CR_FALLBACK_HOURS`    | 5       | espera si no logra leer la hora de reinicio       |
| `CR_CLAUDE_BIN`        | auto    | ruta a un binario de claude alternativo           |
| `CR_AUTO_CONFIRM`      | on      | auto-responde los prompts de confirmación (modo interactivo); `=0` lo apaga |
| `CR_AUTO_CONFIRM_KEY`  | Enter   | tecla a enviar al auto-confirmar (`enter`, `1`, `y`...) |
| `CR_CONTINUE_ON_RETRY` | off     | añade `--continue` al reintentar para retomar la conversación |

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

El repositorio incluye un "claude falso" (`fake-claude.cmd` / `fake-claude.mjs`)
que simula un límite en la 1ª llamada y responde con éxito en la 2ª, para
experimentar con el ciclo de reintento:

```powershell
Remove-Item .\.rl-counter -ErrorAction SilentlyContinue   # reinicia el contador
$env:CR_CLAUDE_BIN = (Resolve-Path .\fake-claude.cmd).Path
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
Remove-Item .\.rl-counter -ErrorAction SilentlyContinue
$env:CR_CLAUDE_BIN = (Resolve-Path .\fake-claude.cmd).Path
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

El wrapper escanea la salida combinada (stdout + stderr) contra patrones
**específicos del mensaje de error real** del CLI, como `usage limit reached`,
`5-hour limit reached`, `rate_limit_error` (el 429 de la API), etc. Los patrones
se mantienen estrictos a propósito: frases de uso común (`rate limit`, `try again
later`, un `429` suelto) provocarían falsos positivos cuando claude las menciona en
una respuesta normal. Si detecta uno:

1. Intenta leer la hora de reinicio del mensaje (formatos como *"reset in 2 hours"*,
   *"try again at 3pm"*, *"reset at 15:00"*).
2. Si la lee, espera hasta esa hora + `CR_MARGIN_SECONDS`.
3. Si no la lee, espera `CR_FALLBACK_HOURS`.
4. Reintenta hasta `CR_MAX_RETRIES` veces.

## Archivos del repositorio

| Archivo            | Descripción                                            |
|--------------------|--------------------------------------------------------|
| `claude-retry.mjs` | El wrapper.                                             |
| `package.json`     | Metadatos y dependencia opcional `node-pty`.           |
| `fake-claude.cmd`  | Lanzador del claude falso para pruebas.                |
| `fake-claude.mjs`  | Claude falso que simula un rate limit.                 |
| `app.py`           | Demo: servidor web mínimo con la librería estándar.    |
| `index.html`       | Demo: página servida por `app.py`.                     |
