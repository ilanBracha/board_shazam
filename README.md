# J-Link Web Interface

A local web application that provides a browser-based interface for SEGGER J-Link debug probes.
The Node.js backend spawns `JLink.exe` as a child process and streams I/O to the browser over WebSocket.

---

## Requirements

- **Node.js** (v16 or later) — https://nodejs.org
- **SEGGER J-Link Software** installed on the local PC
- **Windows** (tested on Windows 11)

---

## Installation & Setup

Open a terminal (PowerShell or CMD) in the project folder and run:

```powershell
cd C:\Users\a5133422\jlink-web
npm install
```

---

## Running the App

```powershell
npm start
```

Then open your browser and navigate to:

```
http://127.0.0.1:3000
```

The server runs locally only (`127.0.0.1`) and is not exposed to the network.

---

## J-Link Auto-Detection

The server searches for `JLink.exe` in the following locations (in order, first found wins):

1. `C:\Program Files\SEGGER\JLink_V938a\JLink.exe`
2. `C:\Program Files\SEGGER\JLink_V798c\JLink.exe`
3. `C:\Program Files\SEGGER\JLink\JLink.exe`
4. `C:\Program Files (x86)\SEGGER\JLink\JLink.exe`

The detected path is shown in the bottom-left of the UI and on server startup in the terminal.

---

## Supported Renesas Boards (Auto-Identify)

Click **Detect Your Target** and the tool identifies the connected board over
SWD/JTAG with no part number required. It then offers to browse that board's FSP
example projects and open them in e2 studio.

Identification combines three signals (most-specific first):

1. **J-Link OB firmware token** — the on-board debugger names the exact MCU group
   (e.g. `J-Link OB-RA6E1`), which resolves to a board even when the MCU itself is
   locked or unreachable.
2. **On-chip memory probing** — flash/SRAM size pins the MCU group within a core.
3. **ARM CPUID / DP IDCODE** — narrows the target to a core and RA series.

Coverage spans the full RA lineup across every board family — **EK** (Evaluation
Kits), **FPB** (Fast Prototyping Boards), **CK** (Cloud Kit), **MCK** (Motor
Control Kits) and **RSSK**:

| Series | Core | Example boards |
|---|---|---|
| RA0 | Cortex-M23 | FPB-RA0E1, FPB-RA0E2, FPB-RA0E3, FPB-RA0L1 |
| RA2 | Cortex-M23 | EK-RA2A1/A2, EK-RA2E1/E2, EK-RA2L1/L2, FPB-RA2E3, FPB-RA2T1 |
| RA4 (M4) | Cortex-M4 | EK-RA4M1, EK-RA4W1 |
| RA4 (M33) | Cortex-M33 | EK-RA4M2/M3, FPB-RA4E1, EK-RA4E2/FPB-RA4E2, EK-RA4C1, EK-RA4L1, FPB-RA4T1/MCK-RA4T1 |
| RA6 (M4) | Cortex-M4 | EK-RA6M1/M2/M3 (+RA6M3G), RSSK-RA6T1 |
| RA6 (M33) | Cortex-M33 | EK-RA6M4, EK-RA6M5/CK-RA6M5, FPB-RA6E1, EK-RA6E2/FPB-RA6E2, MCK-RA6T2, FPB-RA6T3/MCK-RA6T3 |
| RA8 | Cortex-M85 | EK-RA8M1/M2, EK-RA8D1/D2, EK-RA8E2, EK-RA8P1, FPB-RA8E1, MCK-RA8T1, EK-RA8T2/MCK-RA8T2 |

When several boards share the same MCU (e.g. EK-RA6M5 and CK-RA6M5), the result
panel shows all of them — click one to browse *its* FSP examples. The board
catalog lives in `RA_CATALOG` in `server.js`; add a row there to support a new
board.

## Features

### Interactive Terminal Session
- Connects to J-Link Commander (`JLink.exe`) via WebSocket
- Real-time stdout/stderr streaming to the browser terminal
- Send commands by typing in the input bar and pressing **Enter** or clicking **Send**
- Command history navigation with **↑ / ↓** arrow keys

### Connection Settings
| Field | Description |
|---|---|
| Target Device | Device name, e.g. `STM32F407VG`, `nRF52840` (leave blank for auto) |
| Interface | `SWD` (default), `JTAG`, `cJTAG`, `FINE`, `SPI` |
| Speed (kHz) | Debug speed, default `4000` kHz |

### Quick-Action Buttons
| Button | J-Link Command Sent |
|---|---|
| Connect to Target | `connect` |
| Reset Target | `r` |
| Halt Target | `halt` |
| Run (Go) | `go` |
| Erase Flash | `erase` |
| Show Registers | `regs` |
| Mem Dump @ 0x0 | `mem 0x00000000 64` |
| List J-Link Probes | `ShowEmuList` |

### Script Runner (Non-Interactive)
- Paste a multi-line J-Link script in the **Run Script** panel
- Click **Run Script (non-interactive)** to execute it via `-CommanderScript`
- Output is streamed into the terminal when complete
- `Exit` is appended automatically — no need to add it manually

Example script:
```
connect
r
h
loadfile C:\firmware\app.hex
r
go
```

---

## Project Structure

```
jlink-web/
├── package.json       # npm config and dependencies
├── server.js          # Node.js backend (Express + WebSocket + child_process)
├── README.md          # This file
└── public/
    └── index.html     # Web UI (single-page app)
```

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.18.2 | HTTP server, serves static files and REST API |
| `ws` | ^8.16.0 | WebSocket server for real-time terminal I/O |

---

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/jlink-path` | Returns detected `JLink.exe` path |
| `POST` | `/api/run-script` | Runs a J-Link script non-interactively |

### POST `/api/run-script` body

```json
{
  "script": "connect\nr\nh",
  "device": "STM32F407VG",
  "interface": "SWD",
  "speed": 4000
}
```

### Response

```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "..."
}
```

---

## Troubleshooting

**"J-Link NOT Found" badge in UI**
- Verify SEGGER J-Link software is installed
- Add your JLink install path to the `JLINK_SEARCH_DIRS` array in `server.js`

**Session starts but target won't connect**
- Check the USB cable and that the J-Link probe is recognized by Windows Device Manager
- Verify the correct **Device** name and **Interface** are selected
- Try lowering the **Speed** (e.g. `1000` kHz)

**Port 3000 already in use**
- Set a different port before starting: `$env:PORT=3001; npm start`
