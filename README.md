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

| Variable            | Default | Qué controla                                      |
|---------------------|---------|---------------------------------------------------|
| `CR_MAX_RETRIES`    | 5       | reintentos máximos tras detectar el límite        |
| `CR_MARGIN_SECONDS` | 30      | margen extra tras la hora de reinicio detectada   |
| `CR_FALLBACK_HOURS` | 5       | espera si no logra leer la hora de reinicio       |
| `CR_CLAUDE_BIN`     | auto    | ruta a un binario de claude alternativo           |

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

## Cómo detecta el límite

El wrapper escanea la salida combinada (stdout + stderr) contra patrones como
`usage limit reached`, `rate limit`, `too many requests`, `429`,
`try again later/at/in`, etc. Si detecta uno:

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
