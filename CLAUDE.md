# CLAUDE.md

Guidance for working in this repository.

## What this is

**board_shazam** is a local, browser-based companion for SEGGER J-Link debug
probes, focused on **Renesas RA microcontrollers**. Its headline feature is
*Shazam-style auto-identification*: plug in a board, click **Detect Your Target**,
and it figures out the MCU/board over SWD/JTAG with no part number required, then
offers to browse that board's FSP example projects and open them in e2 studio.

It also provides an interactive J-Link Commander terminal, quick-action buttons,
and a non-interactive script runner.

The Node backend spawns `JLink.exe` (and `e2studio.exe`) as child processes and
streams I/O to the browser over WebSocket + REST.

> Note: `package.json` `name` is `renesas365patch` for historical reasons — the
> project is "board_shazam".

## Run it

```bash
npm install
npm start            # serves on http://127.0.0.1:3000
```

- Node v16+ (developed on v26). Windows-only in practice (hardcoded `C:\...`
  search paths, `.exe` binaries). Shell here is Git Bash.
- `PORT` / `HOST` env vars override the listen address.
- A live scan needs **SEGGER J-Link software installed** and a board connected.
  Without J-Link, the server still boots; J-Link-dependent endpoints return 503.
- Useful overrides: `JLINK_PATH`, `E2STUDIO_PATH` (point at the `.exe` or its
  folder), `GITHUB_TOKEN` (raises the GitHub API rate limit for example listing).

There is no build step, no tests, and no linter. Validate changes with:
```bash
node --check server.js          # syntax
PORT=3999 node server.js        # boot + curl the endpoints
```
For UI work, preview via `.claude/launch.json` (the `board-shazam` config).

## Layout

- `server.js` — the entire backend: tool discovery, the RA board catalog +
  detection logic, REST endpoints, and the WebSocket J-Link session. ~1000 lines,
  single file.
- `public/index.html` — the entire frontend: a single-page app with inline CSS
  and JS (no framework, no bundler). State lives in a `state` object; DOM is
  built with template strings.
- `public/assets/` — fonts + Renesas logos.
- `public/index.predesign.bak.html` and `J-Link Web Interface (standalone).html`
  — **artifacts, not used at runtime.** Ignore them; don't edit them to change
  behavior. Only `public/index.html` is served.

## Detection pipeline (the core of the app)

`POST /api/auto-identify` in `server.js` runs phases, each shelling out to
`JLink.exe`. Identification combines three signals, most-specific first:

1. **J-Link OB firmware token** — the on-board debugger banner names the exact
   MCU group (e.g. `J-Link OB-RA6E1`). Parsed by `parseOBToken`, resolved via
   `hintFromGroup`. Works even when the MCU is locked/unreachable. `coreCompatible`
   guards against trusting it when an external target is wired to the OB header.
2. **On-chip memory probing** — `identifyRenesasRA` (M33, SRAM write-back test)
   and `identifyRenesasRACM4` (M4, flash-boundary probe) pin the group by size.
3. **ARM CPUID / DP IDCODE** — `decodeCPUID` + `CPUID_VENDOR_HINTS` narrow the
   target to a core and broad RA series (the coarsest fallback).

Phases inside `/api/auto-identify`:
- **1a** JTAG scan, **1b** SWD scan (only if JTAG found no IDCODE) — a blank
  `Device>` entry makes J-Link print the DP IDCODE even on a failed connect.
- **2** connect with the resolved device name (or `SWD_GENERIC_FALLBACK` names at
  decreasing speeds), read CPUID.
- **3** refine to a specific board (OB token → memory probe).

J-Link is driven by piping all commands to stdin at once then closing it
(`runJLinkStdin`) — this avoids the `-CommanderScript` prompt-reading bug. Output
is free-text, parsed with regexes in `parseJLinkOutput`. When touching detection,
test against the **raw J-Link output** (the result panel has a "Show raw output"
expander; mock outputs can be fed to the parser directly).

## RA_CATALOG — the board source of truth

`RA_CATALOG` in `server.js` is the single authoritative list: one entry per MCU
group with `core`, `flashKB`, `ramKB`, `part`, and a `boards` array. The **first**
board in `boards` is the primary; alternates (e.g. `EK-RA6M5` + `CK-RA6M5`) are
shown as switchable chips in the UI.

**Invariants — keep these true:**
- The primary board's example-folder slug **must exist** in
  `github.com/renesas/ra-fsp-examples/tree/master/example_projects`. The slug is
  `board.toLowerCase().replace(/-/g, '_')` (e.g. `FPB-RA6E1` → `fpb_ra6e1`).
  If no example folder exists for a board, FSP browsing 404s for it.
- Use `null` for flash/RAM/part you can't verify — the UI omits unknown fields
  rather than show a guess. **Don't invent hardware identifiers.**

To add a board: add/extend a row in `RA_CATALOG`. Everything downstream
(OB-token resolution, CPUID hints, FSP examples, the variant chips) derives from
it via `catalogGroup` / `hintFromGroup` / `applyHint`. No other table to update.

## API surface

REST (all under `/api`):
- `GET /jlink-path`, `GET /e2studio-path` — detected tool paths.
- `GET /scan-probes` — `ShowEmuList`, parsed into probe entries.
- `POST /auto-identify` — the detection pipeline above; returns `{ results: [...] }`.
- `POST /run-script` — non-interactive J-Link script (`-CommanderScript`).
- `GET /examples?board=<EK-RAxxxx>` — lists FSP example projects from GitHub
  (30-min in-memory cache, serves stale on rate-limit).
- `GET /board-info?board=<EK-RAxxxx>` — board photo + info links. Scrapes the
  official board image from `renesas.com/.../boards-kits/<slug>` (24h cache) and
  derives links; returns `imageUrl: null` gracefully when the page is missing.
- `POST /open-e2studio` — sparse-git-clones one example, headless-imports it into
  an Eclipse workspace, launches e2 studio.
- `POST /set-github-token`, `GET /github-status`.

WebSocket (`/`) — interactive J-Link Commander session. Client → server messages:
`{type:'start', device, interface, speed}`, `{type:'input', data}`, `{type:'stop'}`.
Server → client: `{type:'stdout'|'stderr'|'info'|'error'|'exit', data}`.

## Conventions & gotchas

- Tool discovery (`findJLink`, `findE2Studio`, `findEclipsec`) checks an env
  override, then known fixed paths, then scans SEGGER/Renesas roots picking the
  newest version. Mirror this pattern when adding a tool dependency.
- Frontend has no framework: extend the inline JS in `public/index.html`, build
  DOM with template strings, and **always `escHtml()` interpolated values**.
- Keep the backend dependency-light (currently only `express` + `ws`).
- Detection involves spawning real processes and has no automated tests — verify
  by booting the server and exercising endpoints with `curl`, and (for parser
  changes) by feeding captured raw J-Link text through the parse functions.
