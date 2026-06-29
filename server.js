const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Detect installed J-Link — prefer newest version
const JLINK_SEARCH_DIRS = [
  'C:\\Program Files\\SEGGER\\JLink_V938a',
  'C:\\Program Files\\SEGGER\\JLink_V798c',
  'C:\\Program Files\\SEGGER\\JLink',
  'C:\\Program Files (x86)\\SEGGER\\JLink',
];

// Normalize an env-provided path: strip surrounding quotes and whitespace.
function cleanPath(v) {
  return v ? String(v).trim().replace(/^"+|"+$/g, '').trim() : '';
}

function findJLink() {
  // 0. Explicit override — set JLINK_PATH to your JLink.exe (or its folder)
  const jlinkOverride = cleanPath(process.env.JLINK_PATH);
  if (jlinkOverride) {
    if (fs.existsSync(jlinkOverride) && fs.statSync(jlinkOverride).isFile()) return jlinkOverride;
    const exe = path.join(jlinkOverride, 'JLink.exe');
    if (fs.existsSync(exe)) return exe;
  }

  // 1. Known fixed locations
  for (const dir of JLINK_SEARCH_DIRS) {
    const exe = path.join(dir, 'JLink.exe');
    if (fs.existsSync(exe)) return exe;
  }

  // 2. Scan the SEGGER roots for ANY JLink* install (e.g. JLink_V812a),
  //    newest version folder first.
  const roots = ['C:\\Program Files\\SEGGER', 'C:\\Program Files (x86)\\SEGGER'];
  const candidates = [];
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries) {
      if (!/^JLink/i.test(name)) continue;
      const exe = path.join(root, name, 'JLink.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }
  if (candidates.length) {
    // Sort by folder name descending (numeric-aware) so the newest wins.
    candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return candidates[0];
  }

  return null;
}

const JLINK_EXE = findJLink();

// Detect e2studio installation
const E2STUDIO_SEARCH_PATHS = [
  'C:\\Renesas\\e2_studio\\eclipse\\e2studio.exe',
  'C:\\Renesas\\e2_studio\\e2studio.exe',
  'C:\\Program Files\\Renesas\\e2_studio\\eclipse\\e2studio.exe',
  'C:\\Program Files\\Renesas\\e2_studio\\e2studio.exe',
  'C:\\Program Files (x86)\\Renesas\\e2_studio\\eclipse\\e2studio.exe',
  'C:\\Program Files (x86)\\Renesas\\e2_studio\\e2studio.exe',
  // Per-user (AppData) install — Renesas installer's default for non-admin installs
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Renesas', 'e2_studio', 'eclipse', 'e2studio.exe'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Renesas', 'e2_studio', 'e2studio.exe'),
];

function findE2Studio() {
  // 0. Explicit override — set E2STUDIO_PATH to e2studio.exe (or its folder)
  const override = cleanPath(process.env.E2STUDIO_PATH);
  if (override) {
    if (fs.existsSync(override) && fs.statSync(override).isFile()) return override;
    for (const sub of ['e2studio.exe', 'eclipse\\e2studio.exe']) {
      const exe = path.join(override, sub);
      if (fs.existsSync(exe)) return exe;
    }
  }

  // 1. Known fixed locations
  for (const p of E2STUDIO_SEARCH_PATHS) {
    if (fs.existsSync(p)) return p;
  }

  // 2. Scan the Renesas roots (incl. the per-user AppData install) for e2_studio*
  const roots = [
    'C:\\Renesas',
    'C:\\Program Files\\Renesas',
    'C:\\Program Files (x86)\\Renesas',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Renesas'),
    path.join(os.homedir(), 'AppData', 'Local', 'Renesas'),
  ];
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries) {
      if (!/e2_studio/i.test(name)) continue;
      for (const sub of ['eclipse\\e2studio.exe', 'e2studio.exe']) {
        const exe = path.join(root, name, sub);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }

  return null;
}

const E2STUDIO_EXE = findE2Studio();

// The headless Eclipse CLI (eclipsec.exe / e2studioc.exe) lives next to e2studio.exe
function findEclipsec() {
  if (!E2STUDIO_EXE) return null;
  const dir = path.dirname(E2STUDIO_EXE);
  for (const name of ['eclipsec.exe', 'e2studioc.exe']) {
    const exe = path.join(dir, name);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Identification helpers ─────────────────────────────────────────────────

function runJLinkScript(scriptContent, extraArgs, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!JLINK_EXE) return reject(new Error('JLink.exe not found'));

    const tmpScript = path.join(os.tmpdir(), `jlink_${Date.now()}_${Math.random().toString(36).slice(2)}.jlink`);
    fs.writeFileSync(tmpScript, scriptContent + '\r\nExit\r\n');

    const args = ['-NoGui', '1', ...extraArgs, '-CommanderScript', tmpScript];
    const proc = spawn(JLINK_EXE, args);
    let stdout = '', stderr = '';

    const timer = setTimeout(() => { proc.kill(); }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      clearTimeout(timer);
      fs.unlink(tmpScript, () => {});
      resolve({ stdout, stderr, exitCode: code });
    });
    proc.on('error', err => { clearTimeout(timer); fs.unlink(tmpScript, () => {}); reject(err); });
  });
}

// Known JTAG-DP / SW-DP IDCODEs → devices to try in Phase 2 (first = preferred)
// 0x6BA00477 is DPv3 shared by Cortex-M33, M55, and M85 — the CPUID register
// is the authoritative source; we try all plausible generic device names.
const DP_IDCODES = {
  '0x0BB11477': { dpCore: 'Cortex-M0',        devices: ['Cortex-M0']                              },
  '0x0BC11477': { dpCore: 'Cortex-M0+',       devices: ['Cortex-M0+']                             },
  '0x2BA01477': { dpCore: 'Cortex-M3',        devices: ['Cortex-M3']                              },
  '0x1BA01477': { dpCore: 'Cortex-M4',        devices: ['Cortex-M4']                              },
  '0x4BA00477': { dpCore: 'Cortex-M3/M4',     devices: ['Cortex-M4', 'Cortex-M3']                },
  '0x3BA00477': { dpCore: 'Cortex-M7',        devices: ['Cortex-M7']                              },
  '0x5BA00477': { dpCore: 'Cortex-M7',        devices: ['Cortex-M7']                              },
  '0x5BA02477': { dpCore: 'Cortex-M4',        devices: ['Cortex-M4']                              },
  // 0x0BE12477 is used by both Cortex-M23 (RA2 series) and Cortex-M33 (RA4M2/RA6M4).
  // Try M33 first — CPUID will correct it if wrong.
  '0x0BE12477': { dpCore: 'Cortex-M23 / Cortex-M33', devices: ['Cortex-M33', 'Cortex-M23']       },
  // DPv3 — used by M33, M55, and M85 (RA8M1). Try M85 first for EK-RA8M1.
  '0x6BA00477': { dpCore: 'Cortex-M33/M55/M85 (DPv3)', devices: ['Cortex-M85', 'Cortex-M33', 'Cortex-M55'] },
  '0x6BA02477': { dpCore: 'Cortex-M33/M55/M85 (DPv3)', devices: ['Cortex-M85', 'Cortex-M33', 'Cortex-M55'] },
  '0x0BD22477': { dpCore: 'Cortex-M55',       devices: ['Cortex-M55']                             },
};

// CPUID PartNo → Renesas vendor / family-GROUP hint shown in the UI.
// CPUID alone only narrows the device to a core (hence a group of RA series); it
// cannot pick the exact MCU group or board. Later phases (J-Link OB firmware
// token, on-chip memory probing) refine this to a specific group/board via
// RA_CATALOG. Non-Renesas cores show the core name only.
const CPUID_VENDOR_HINTS = {
  // Arm Cortex-M85 (ARMv8.1-M) — RA8 series
  0xD23: { vendor: 'Renesas', family: 'RA8 series (Cortex-M85)',
           board: null, partNumber: null },
  // Arm Cortex-M55 (ARMv8.1-M)
  0xD22: { vendor: 'Renesas', family: 'RA series (Cortex-M55)',
           board: null, partNumber: null },
  // Arm Cortex-M33 (ARMv8-M.Main) — RA4 / RA6 / RA-T (motor) groups
  0xD21: { vendor: 'Renesas', family: 'RA4 · RA6 · RA-T series (Cortex-M33)',
           board: null, partNumber: null },
  // Arm Cortex-M23 (ARMv8-M.Baseline) — RA0 / RA2 groups
  0xD20: { vendor: 'Renesas', family: 'RA0 · RA2 series (Cortex-M23)',
           board: null, partNumber: null },
  // Arm Cortex-M4 (ARMv7E-M) — original RA4 / RA6 groups
  0xC24: { vendor: 'Renesas', family: 'RA4 · RA6 series (Cortex-M4)',
           board: null, partNumber: null },
};

// Decode ARM CPUID register (0xE000ED00)
function decodeCPUID(val) {
  const CORES = {
    0xC20: 'Cortex-M0',  0xC21: 'Cortex-M1',  0xC23: 'Cortex-M3',
    0xC24: 'Cortex-M4',  0xC27: 'Cortex-M7',  0xC60: 'Cortex-M0+',
    0xD20: 'Cortex-M23', 0xD21: 'Cortex-M33', 0xD22: 'Cortex-M55',
    0xD23: 'Cortex-M85', 0xB11: 'Cortex-R11',
  };
  // Architecture derived from PartNo — more reliable than the arch field bits,
  // which are 0xF for both ARMv7-M (M3/M4/M7) and ARMv8-M (M33/M85) cores.
  const CORE_ARCH = {
    0xC20: 'ARMv6-M',          0xC21: 'ARMv6-M',
    0xC23: 'ARMv7-M',          0xC24: 'ARMv7E-M',
    0xC27: 'ARMv7E-M',         0xC60: 'ARMv6-M',
    0xD20: 'ARMv8-M.Baseline', 0xD21: 'ARMv8-M.Main',
    0xD22: 'ARMv8.1-M',        0xD23: 'ARMv8.1-M',
  };
  const implementer = (val >>> 24) & 0xFF;
  const variant     = (val >>> 20) & 0xF;
  const partno      = (val >>> 4)  & 0xFFF;
  const revision    =  val         & 0xF;
  const hint        = CPUID_VENDOR_HINTS[partno] || null;
  return {
    core:         CORES[partno] || null,
    partno:       `0x${partno.toString(16).toUpperCase().padStart(3,'0')}`,
    revision:     `r${variant}p${revision}`,
    implementer:  implementer === 0x41 ? 'ARM Ltd.' : `0x${implementer.toString(16).toUpperCase()}`,
    architecture: CORE_ARCH[partno] || 'Unknown',
    raw:          `0x${val.toString(16).toUpperCase().padStart(8,'0')}`,
    vendorHint:   hint,
  };
}

// Parse free-text J-Link Commander output into structured fields
function parseJLinkOutput(output) {
  const info = {};

  // ── SW-DP IDCODE ──────────────────────────────────────────────────────────
  let m = output.match(/Found SW-DP with ID\s+(0x[0-9A-Fa-f]+)/i)
       || output.match(/DPIDR:\s*(0x[0-9A-Fa-f]+)/i)
       || output.match(/IDCODE\s*[=:]\s*(0x[0-9A-Fa-f]+)/i);
  if (m) {
    info.idcode = m[1].toUpperCase().replace('0X','0x');
    const dp = DP_IDCODES[info.idcode];
    if (dp) {
      if (!info.core)         info.core         = dp.dpCore;
      if (!info.devicesToTry) info.devicesToTry = dp.devices;
    }
  }

  // ── CPUID register — J-Link V9 format: "CPUID register: 0x410FD232. ..." ─
  // Older format had "=> core name" after the value; V9.38a uses ". Implementer"
  m = output.match(/CPUID register:\s*(0x[0-9A-Fa-f]+)/i);
  if (m) {
    const val    = parseInt(m[1], 16);
    const decoded = decodeCPUID(val);
    Object.assign(info, decoded);        // sets core, revision, architecture, vendorHint …
    info.cpuidRaw = decoded.raw;
  }

  // ── mem32 result — V9.38a format: "E000ED00 = 410FD232" (no 0x prefix) ──
  if (!info.cpuidRaw) {
    m = output.match(/(?:0x)?E000ED00\s*[=:]+\s*(?:0x)?([0-9A-Fa-f]{8})\b/i);
    if (m) {
      const val     = parseInt(m[1], 16);
      const decoded = decodeCPUID(val);
      Object.assign(info, decoded);
      info.cpuidRaw = decoded.raw;
    }
  }

  // ── Core name from "Found Cortex-Mxx r0p2" / "Cortex-Mxx identified" ────
  // Only use as fallback if CPUID decode didn't give us a core name
  m = output.match(/Found (Cortex-[A-Za-z0-9+]+)/i)
   || output.match(/(Cortex-[A-Za-z0-9+]+) identified/i);
  if (m && !info.core) info.core = m[1];

  // Revision from "r0p2" in the "Found …" line (if CPUID not available)
  if (!info.revision) {
    m = output.match(/\b(r\d+p\d+)\b/i);
    if (m) info.revision = m[1];
  }

  // ── CoreSight / DPv ───────────────────────────────────────────────────────
  m = output.match(/DPv(\d)/i);
  if (m) info.dpVersion = `DPv${m[1]}`;

  // ── Endianness ────────────────────────────────────────────────────────────
  m = output.match(/(Little|Big) endian/i);
  if (m) info.endian = m[1] + ' endian';

  // ── Security / extensions (Cortex-M33/M85 TrustZone) ─────────────────────
  if (/Security extension:\s*implemented/i.test(output)) info.security = 'TrustZone implemented';
  if (/Secure debug:\s*enabled/i.test(output))           info.secureDebug = 'Secure debug enabled';
  if (/PACBTI extension:\s*implemented/i.test(output))   info.pacbti = 'PACBTI implemented';

  // ── Cache (Cortex-M55/M85) ────────────────────────────────────────────────
  m = output.match(/I-Cache\s+L1:\s*(\d+)\s*KB/i);
  if (m) info.icacheKB = parseInt(m[1]);
  m = output.match(/D-Cache\s+L1:\s*(\d+)\s*KB/i);
  if (m) info.dcacheKB = parseInt(m[1]);

  // ── FPU ───────────────────────────────────────────────────────────────────
  m = output.match(/FPUnit:\s*(\d+)\s*code.*?slots/i);
  if (m) info.fpu = `FPU present (${m[1]} BP slots)`;
  m = output.match(/FPU type:\s*(.+)/i);  // older format
  if (m) info.fpu = m[1].trim();

  // ── Flash / RAM ───────────────────────────────────────────────────────────
  m = output.match(/(\d+)\s*kB\s+FLASH/i);
  if (m) info.flashKB = parseInt(m[1]);
  m = output.match(/(\d+)\s*kB\s+RAM/i);
  if (m) info.ramKB = parseInt(m[1]);

  // ── Device name J-Link resolved ───────────────────────────────────────────
  m = output.match(/Device\s*"([^"]+)"/i) || output.match(/Selected device:\s*(.+)/i);
  if (m) info.detectedDevice = m[1].trim();

  // ── AP map (deduplicated) ─────────────────────────────────────────────────
  const apMatches = [...output.matchAll(/AP\[(\d+)\]:\s*(AHB-AP|APB-AP|AXI-AP|JTAG-AP[^,\n]*)/gi)];
  if (apMatches.length) {
    const seen = new Set();
    info.accessPorts = apMatches
      .map(a => `AP[${a[1]}]: ${a[2].trim()}`)
      .filter(s => { if (seen.has(s)) return false; seen.add(s); return true; });
  }

  // ── JTAG chain — available even from a failed connection attempt ──────────
  // Format: " #0 Id: 0x6BA00477, IRLen: 04, CoreSight JTAG-DP"
  const jtagChain = [...output.matchAll(/#(\d+)\s+Id:\s+(0x[0-9A-Fa-f]+),\s*IRLen:\s*(\d+),\s*(.+)/gi)];
  if (jtagChain.length) {
    info.jtagDevices = jtagChain.map(x => ({
      index:       parseInt(x[1]),
      idcode:      x[2].toUpperCase().replace('0X','0x'),
      irLen:       parseInt(x[3]),
      description: x[4].trim(),
    }));
    const primary = info.jtagDevices[0];
    if (!info.idcode) info.idcode = primary.idcode;
    const dp = DP_IDCODES[primary.idcode];
    if (dp) {
      if (!info.core) info.core = dp.dpCore;
      info.devicesToTry = dp.devices;
    }
  }

  return info;
}

// ── REST endpoints ─────────────────────────────────────────────────────────

// REST: get detected J-Link path
app.get('/api/jlink-path', (req, res) => {
  res.json({ path: JLINK_EXE, found: !!JLINK_EXE });
});

// REST: list connected J-Link probes
app.get('/api/scan-probes', async (req, res) => {
  if (!JLINK_EXE) return res.status(503).json({ error: 'JLink.exe not found' });
  try {
    const { stdout, stderr } = await runJLinkScript('ShowEmuList', []);
    const combined = stdout + stderr;

    // Parse probe entries: "J-Link[0]: Connection: USB, Serial number: ..., ProductName: ..."
    const probes = [];
    const lines = combined.split('\n');
    for (const line of lines) {
      const m = line.match(/J-Link\[(\d+)\]:\s*Connection:\s*(\w+),\s*Serial number:\s*(\d+),\s*ProductName:\s*(.+)/i);
      if (m) {
        probes.push({
          index:      parseInt(m[1]),
          connection: m[2].trim(),
          serial:     m[3].trim(),
          product:    m[4].trim(),
        });
      }
    }
    res.json({ probes, raw: combined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pipe all commands into J-Link stdin at once, then close the pipe.
// J-Link reads them sequentially: the blank line answers the "Device>" prompt
// (empty = auto-detect), which avoids both the -CommanderScript prompt-reading
// bug and the event-timing issues of the previous interactive approaches.
function runJLinkStdin(iface, speed, cmds, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!JLINK_EXE) return reject(new Error('JLink.exe not found'));

    const proc = spawn(JLINK_EXE, ['-NoGui', '1', '-If', iface, '-Speed', String(speed)]);
    let output = '';

    // Write all input lines upfront; closing stdin tells J-Link there is no more input
    const input = cmds.join('\n') + '\n';
    proc.stdin.write(input);
    proc.stdin.end();

    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);

    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close',  ()  => { clearTimeout(timer); resolve(output); });
    proc.on('error',  err => { clearTimeout(timer); reject(err); });
  });
}

// ── Comprehensive Renesas RA board / MCU catalog ────────────────────────────
//
// One entry per MCU group. `boards` lists every Renesas development board built
// on that group; the FIRST board is the primary one — its example_projects
// folder on github.com/renesas/ra-fsp-examples is guaranteed to exist, so FSP
// example browsing works for it. Additional boards (EK / FPB / CK / MCK / RSSK
// variants of the same silicon) are surfaced in the UI so the user can switch.
//
// Detection resolves a `group` from, in order of specificity:
//   1. the J-Link OB firmware token  (e.g. "J-Link OB-RA6E1" → RA6E1) — exact,
//   2. on-chip memory probing        (flash/SRAM size → group),
//   3. the CPUID family group        (core only → broad RA series).
// then surfaces the primary board for that group plus any alternates.
//
// flashKB / ramKB are the group maximums; null where not authoritatively known
// (the UI simply omits unknown fields rather than display a guess).
const RA_CATALOG = [
  // ── RA0 — ultra-low-power · Arm Cortex-M23 ─────────────────────────────────
  { group: 'RA0E1', core: 'Cortex-M23', flashKB:   64, ramKB:  12, part: null,            boards: ['FPB-RA0E1'] },
  { group: 'RA0E2', core: 'Cortex-M23', flashKB: null, ramKB: null, part: null,           boards: ['FPB-RA0E2'] },
  { group: 'RA0E3', core: 'Cortex-M23', flashKB: null, ramKB: null, part: null,           boards: ['FPB-RA0E3'] },
  { group: 'RA0L1', core: 'Cortex-M23', flashKB:   64, ramKB:  16, part: null,            boards: ['FPB-RA0L1'] },

  // ── RA2 — entry-level general purpose · Arm Cortex-M23 ─────────────────────
  { group: 'RA2A1', core: 'Cortex-M23', flashKB:  256, ramKB:  32, part: 'R7FA2A1AB3CFP', boards: ['EK-RA2A1'] },
  { group: 'RA2A2', core: 'Cortex-M23', flashKB:  512, ramKB:  64, part: null,            boards: ['EK-RA2A2'] },
  { group: 'RA2E1', core: 'Cortex-M23', flashKB:  128, ramKB:  16, part: 'R7FA2E1A93CFM', boards: ['EK-RA2E1'] },
  { group: 'RA2E2', core: 'Cortex-M23', flashKB:   64, ramKB:  16, part: 'R7FA2E2A7DFM',  boards: ['EK-RA2E2'] },
  { group: 'RA2E3', core: 'Cortex-M23', flashKB:   64, ramKB:  16, part: null,            boards: ['FPB-RA2E3'] },
  { group: 'RA2L1', core: 'Cortex-M23', flashKB:  256, ramKB:  32, part: 'R7FA2L1AB2DFP', boards: ['EK-RA2L1'] },
  { group: 'RA2L2', core: 'Cortex-M23', flashKB:  128, ramKB:  16, part: null,            boards: ['EK-RA2L2'] },
  { group: 'RA2T1', core: 'Cortex-M23', flashKB: null, ramKB: null, part: null,           boards: ['FPB-RA2T1'] },

  // ── RA4 / RA6 (original) · Arm Cortex-M4 ───────────────────────────────────
  { group: 'RA4M1', core: 'Cortex-M4',  flashKB:  256, ramKB:  32, part: 'R7FA4M1AB3CFP', boards: ['EK-RA4M1'] },
  { group: 'RA4W1', core: 'Cortex-M4',  flashKB:  512, ramKB:  96, part: 'R7FA4W1BB2CLG', boards: ['EK-RA4W1'] },
  { group: 'RA6M1', core: 'Cortex-M4',  flashKB:  512, ramKB: 256, part: 'R7FA6M1AD3CFP', boards: ['EK-RA6M1'] },
  { group: 'RA6M2', core: 'Cortex-M4',  flashKB: 1024, ramKB: 384, part: 'R7FA6M2AF3CFP', boards: ['EK-RA6M2'] },
  { group: 'RA6M3', core: 'Cortex-M4',  flashKB: 2048, ramKB: 640, part: 'R7FA6M3AH3CFP', boards: ['EK-RA6M3', 'EK-RA6M3G'] },
  { group: 'RA6T1', core: 'Cortex-M4',  flashKB:  512, ramKB:  64, part: 'R7FA6T1AD3CFP', boards: ['RSSK-RA6T1'] },

  // ── RA4 / RA6 (TrustZone) · Arm Cortex-M33 ─────────────────────────────────
  { group: 'RA4M2', core: 'Cortex-M33', flashKB:  512, ramKB: 128, part: 'R7FA4M2AD3CFP', boards: ['EK-RA4M2'] },
  { group: 'RA4M3', core: 'Cortex-M33', flashKB: 1024, ramKB: 256, part: 'R7FA4M3AF3CFP', boards: ['EK-RA4M3'] },
  { group: 'RA4E1', core: 'Cortex-M33', flashKB:  512, ramKB: 128, part: 'R7FA4E10D2CFM', boards: ['FPB-RA4E1'] },
  { group: 'RA4E2', core: 'Cortex-M33', flashKB:  128, ramKB:  40, part: 'R7FA4E2B93CFM', boards: ['EK-RA4E2', 'FPB-RA4E2'] },
  { group: 'RA4C1', core: 'Cortex-M33', flashKB: null, ramKB: null, part: null,           boards: ['EK-RA4C1'] },
  { group: 'RA4L1', core: 'Cortex-M33', flashKB:  512, ramKB: null, part: null,           boards: ['EK-RA4L1'] },
  { group: 'RA4T1', core: 'Cortex-M33', flashKB: null, ramKB: null, part: null,           boards: ['FPB-RA4T1', 'MCK-RA4T1'] },
  { group: 'RA6M4', core: 'Cortex-M33', flashKB: 1024, ramKB: 256, part: 'R7FA6M4AF3CFP', boards: ['EK-RA6M4'] },
  { group: 'RA6M5', core: 'Cortex-M33', flashKB: 2048, ramKB: 512, part: 'R7FA6M5BH3CFP', boards: ['EK-RA6M5', 'CK-RA6M5'] },
  { group: 'RA6E1', core: 'Cortex-M33', flashKB:  512, ramKB: 256, part: 'R7FA6E10F2CFP', boards: ['FPB-RA6E1'] },
  { group: 'RA6E2', core: 'Cortex-M33', flashKB:  256, ramKB:  40, part: 'R7FA6E2BB3CFM', boards: ['EK-RA6E2', 'FPB-RA6E2'] },
  { group: 'RA6T2', core: 'Cortex-M33', flashKB:  256, ramKB: null, part: null,           boards: ['MCK-RA6T2'] },
  { group: 'RA6T3', core: 'Cortex-M33', flashKB: null, ramKB: null, part: null,           boards: ['FPB-RA6T3', 'MCK-RA6T3'] },

  // ── RA8 — highest performance · Arm Cortex-M85 (some dual-core +M33) ────────
  { group: 'RA8M1', core: 'Cortex-M85', flashKB: 2048, ramKB:1024, part: 'R7FA8M1AHECBD', boards: ['EK-RA8M1'] },
  { group: 'RA8D1', core: 'Cortex-M85', flashKB: 2048, ramKB:1024, part: 'R7FA8D1BHECBD', boards: ['EK-RA8D1'] },
  { group: 'RA8T1', core: 'Cortex-M85', flashKB: 1024, ramKB: 512, part: 'R7FA8T1AHECBD', boards: ['MCK-RA8T1'] },
  { group: 'RA8E1', core: 'Cortex-M85', flashKB: 1024, ramKB: 544, part: null,            boards: ['FPB-RA8E1'] },
  { group: 'RA8E2', core: 'Cortex-M85', flashKB: 1024, ramKB: 672, part: null,            boards: ['EK-RA8E2'] },
  { group: 'RA8M2', core: 'Cortex-M85', flashKB: 1024, ramKB:2048, part: null,            boards: ['EK-RA8M2'] },
  { group: 'RA8D2', core: 'Cortex-M85', flashKB: 1024, ramKB:2048, part: null,            boards: ['EK-RA8D2'] },
  { group: 'RA8P1', core: 'Cortex-M85', flashKB: 1024, ramKB:2048, part: null,            boards: ['EK-RA8P1'] },
  { group: 'RA8T2', core: 'Cortex-M85', flashKB: null, ramKB: null, part: null,           boards: ['EK-RA8T2', 'MCK-RA8T2'] },
];

// Fast lookup: MCU group name (upper-case, e.g. "RA6E1") → catalog entry.
const RA_GROUP_INDEX = new Map(RA_CATALOG.map(e => [e.group, e]));
function catalogGroup(group) {
  return group ? (RA_GROUP_INDEX.get(String(group).toUpperCase()) || null) : null;
}

// Build the vendorHint object the UI consumes from a catalog entry.
// `preferBoard` (optional) chooses which of the group's boards is primary.
function hintFromGroup(group, preferBoard) {
  const e = catalogGroup(group);
  if (!e) return null;
  const board = (preferBoard && e.boards.includes(preferBoard)) ? preferBoard : e.boards[0];
  return {
    vendor:     'Renesas',
    family:     `${e.group} series`,
    board,
    partNumber: e.part || null,
    core:       e.core,
    flashKB:    e.flashKB,
    ramKB:      e.ramKB,
    boards:     e.boards.slice(),   // all variants on this silicon, for the UI
  };
}

// Merge a catalog vendorHint into a parsed-info object (mutates `info`).
// Known flash/RAM/core fields override only when the hint actually provides them.
function applyHint(info, hint) {
  if (!info || !hint) return;
  info.vendorHint = {
    vendor:      hint.vendor,
    family:      hint.family,
    board:       hint.board,
    partNumber:  hint.partNumber,
    boards:      hint.boards,
    approximate: hint.approximate || false,   // true = core known, exact board guessed
  };
  if (hint.flashKB != null) info.flashKB = hint.flashKB;
  if (hint.ramKB   != null) info.ramKB   = hint.ramKB;
  if (!info.core && hint.core) info.core = hint.core;
}

// True if a CPUID-decoded core is consistent with a catalog entry's core.
// Loose on both sides so dual-core ("Cortex-M85 + Cortex-M33") entries match a
// single detected core, and "Cortex-M3/M4"-style hints match either member.
function coreCompatible(detected, catalogCore) {
  if (!detected || !catalogCore) return true;
  const a = String(detected), b = String(catalogCore);
  return a.includes(b) || b.includes(a)
      || a.split(/[\/+]/).some(t => b.includes(t.trim()))
      || b.split(/[\/+]/).some(t => a.includes(t.trim()));
}

// When the core is known but the exact MCU group isn't — e.g. an external probe
// whose OB firmware names a different board, or a series with no size-probe path
// (RA8/RA2) — fall back to the core. Surfaces a representative board plus EVERY
// board on matching silicon, so the user can pick theirs via the UI's variant
// chips. Marked `approximate` so the UI presents it as a best guess.
const CORE_DEFAULT_GROUP = {
  'Cortex-M85': 'RA8M1',
  'Cortex-M33': 'RA6M5',
  'Cortex-M4':  'RA6M3',
  'Cortex-M23': 'RA2E1',
};
function coreFallbackHint(core) {
  if (!core) return null;
  const boards = [];
  for (const e of RA_CATALOG) if (coreCompatible(core, e.core)) boards.push(...e.boards);
  if (!boards.length) return null;
  const def = catalogGroup(CORE_DEFAULT_GROUP[core]);
  const primary = (def && coreCompatible(core, def.core)) ? def.boards[0] : boards[0];
  return {
    vendor:      'Renesas',
    family:      `RA family · ${core}`,
    board:       primary,
    partNumber:  null,
    core,
    flashKB:     null,
    ramKB:       null,
    boards,
    approximate: true,
  };
}

// Identify Renesas RA Cortex-M33 boards via SRAM write-back test.
//
// Simple read-probing is unreliable: the Renesas RA bus fabric returns a
// value (rather than faulting) for reads beyond the implemented SRAM/flash,
// making read-based boundary probes always "true".
//
// Write-back test: write a marker word, then read it back.
// - Real SRAM retains the write  → readback == marker → address is mapped.
// - Unmapped bus silently discards writes → readback == original bus default,
//   not the marker → address is not mapped.
//
// All SRAM probes are done in one J-Link session to minimise connection time.
//
// Decision tree:
//   0x20040000 write-back true  → SRAM ≥ 256KB+1 → 512 KB → RA6M5
//   0x20020000 write-back true  → SRAM ≥ 128KB+1 → 256 KB → RA6M4
//   0x00080000 read present     → flash ≥ 512KB+1 →  1 MB  → RA4M2 (best-effort)
//   default                     → 512 KB flash, 128 KB RAM  → RA6E1
async function identifyRenesasRA(iface, speed) {
  const find = hintFromGroup;   // group name → catalog vendorHint

  // Single J-Link session: write two markers, read back both
  let out;
  try {
    out = await runJLinkStdin(iface, speed, [
      'connect', 'Cortex-M33',
      'mem32 0x20040000 1',           // pre-write read A
      'mem32 0x20020000 1',           // pre-write read B
      'w4 0x20040000 0x5A5A5A5A',     // write marker A (512 KB SRAM boundary)
      'w4 0x20020000 0xA5A5A5A5',     // write marker B (256 KB SRAM boundary)
      'mem32 0x20040000 1',           // post-write read A
      'mem32 0x20020000 1',           // post-write read B
      'exit',
    ], 15000);
  } catch { return null; }

  const mA = [...out.matchAll(/20040000\s*=\s*([0-9A-Fa-f]{8})\b/gi)];
  const mB = [...out.matchAll(/20020000\s*=\s*([0-9A-Fa-f]{8})\b/gi)];

  // [0] = pre-write value, [1] = post-write value
  if (mA.length >= 2 && mA[1][1].toUpperCase() === '5A5A5A5A') return find('RA6M5');
  if (mB.length >= 2 && mB[1][1].toUpperCase() === 'A5A5A5A5') return find('RA6M4');

  // 128 KB SRAM — distinguish RA4M2 (1 MB flash) from RA6E1 (512 KB flash)
  try {
    const fo = await runJLinkStdin(iface, speed,
      ['connect', 'Cortex-M33', 'mem32 0x00080000 1', 'exit'], 10000);
    if (/00080000\s*=\s*[0-9A-Fa-f]{8}\b/i.test(fo)) return find('RA4M2');
  } catch {}

  return find('RA6E1');
}

// Identify Renesas RA Cortex-M4 boards via flash boundary probing.
//
// Decision tree (max 3 probes):
//   probe(0x00100000) true  → Flash ≥ 2 MB → RA6M3
//   probe(0x00080000) true  → Flash ≥ 1 MB → RA6M2
//   probe(0x00040000) true  → Flash ≥ 512 KB → RA6M1
//   default                → Flash = 256 KB → RA4M1
async function identifyRenesasRACM4(iface, speed) {
  async function probe(addr) {
    try {
      const hex = addr.toString(16).toUpperCase().padStart(8, '0');
      const out = await runJLinkStdin(iface, speed,
        ['connect', 'Cortex-M4', `mem32 0x${hex} 1`, 'exit'], 10000);
      return new RegExp(`${hex}\\s*=\\s*[0-9A-Fa-f]{8}\\b`, 'im').test(out);
    } catch { return false; }
  }

  const find = hintFromGroup;   // group name → catalog vendorHint

  if (await probe(0x00100000)) return find('RA6M3');   // 2 MB Flash
  if (await probe(0x00080000)) return find('RA6M2');   // 1 MB Flash
  if (await probe(0x00040000)) return find('RA6M1');   // 512 KB Flash
  return find('RA4M1');                                 // 256 KB Flash
}

// Generic Cortex-M device names to try via SWD when no IDCODE is available.
// Ordered roughly by market prevalence.  Renesas-specific part numbers are
// included because J-Link uses device-specific SWD/reset sequences that can
// succeed even when the generic Cortex-M name fails.
const SWD_GENERIC_FALLBACK = [
  // Generic cores first (fast to try, work for most unlocked devices) — these
  // already cover every Renesas RA part regardless of group.
  'Cortex-M33', 'Cortex-M4', 'Cortex-M85', 'Cortex-M23',
  'Cortex-M0+', 'Cortex-M55', 'Cortex-M7', 'Cortex-M3', 'Cortex-M0',
  // Renesas RA specific part numbers — J-Link knows device-specific
  // connect-under-reset timing and SWD init for these, spanning the lineup.
  'R7FA8M1AHECBD',  // RA8 · Cortex-M85
  'R7FA8D1BHECBD',  // RA8D1 · Cortex-M85 (graphics)
  'R7FA8E1AFDCFB',  // RA8E1 · Cortex-M85 (entry)
  'R7FA6M5BH3CFP',  // RA6M5 · Cortex-M33
  'R7FA6M4AF3CFP',  // RA6M4 · Cortex-M33
  'R7FA6E10F2CFP',  // RA6E1 · Cortex-M33 (FPB)
  'R7FA4M3AF3CFP',  // RA4M3 · Cortex-M33
  'R7FA4M2AD3CFP',  // RA4M2 · Cortex-M33
  'R7FA4E10D2CFM',  // RA4E1 · Cortex-M33 (FPB)
  'R7FA6M3AH3CFP',  // RA6M3 · Cortex-M4
  'R7FA4M1AB3CFP',  // RA4M1 · Cortex-M4
  'R7FA2L1AB2DFP',  // RA2L1 · Cortex-M23
  'R7FA2E1A93CFM',  // RA2E1 · Cortex-M23
];

// Extract the MCU group token from a J-Link On-Board firmware banner, e.g.
//   "Firmware: J-Link OB-RA4M2-CortexM compiled …"          → "RA4M2"
//   "Firmware: J-Link OB-S124-Renesas compiled …"           → "S124" (ignored)
// Returns the upper-case token, or null if the banner isn't present.
function parseOBToken(rawOutput) {
  const m = (rawOutput || '').match(/Firmware:\s+J-Link\s+OB-([A-Za-z0-9]+)/i);
  return m ? m[1].toUpperCase() : null;
}

// J-Link On-Board probe firmware → Renesas board, resolved through RA_CATALOG.
// The J-Link OB firmware banner names the target MCU group, e.g.
//   "Firmware: J-Link OB-RA4M2-CortexM compiled …"  →  RA4M2  →  EK-RA4M2.
// This identifies the board even when the CPU itself is unreachable over SWD/JTAG
// (debug protection enabled, boot/fault loop, or a wiring/power issue). Covers
// the entire RA lineup automatically since it reuses the catalog.
function detectJLinkOBBoard(rawOutput) {
  return hintFromGroup(parseOBToken(rawOutput));
}

// Read the MCU's factory-programmed Part Number (PNR) straight from silicon — the
// most authoritative ID, independent of the probe's OB firmware. The 16-byte
// ASCII string (e.g. "R7FA8M1AHECBD") lives at a family-specific factory-flash
// address; we read all candidates in the connect session (see the mem8 reads in
// /api/auto-identify) and parse whichever line returns an "R7FA…" string.
//   RA8 series                       → 0x030080F0
//   RA4M2/M3 · RA6M4/M5 · RA4E · RA6E → 0x010080F0
//   RA0 · RA2 entry                  → 0x01001C10
// J-Link prints e.g.:  030080F0 = 52 37 46 41 38 4D 31 41 48 45 43 42 44 20 20 20
const PNR_ADDRESSES = ['030080F0', '010080F0', '01001C10'];
function parsePartNumber(output) {
  for (const addr of PNR_ADDRESSES) {
    const m = output.match(new RegExp(addr + '\\s*=\\s*((?:[0-9A-Fa-f]{2}\\s+){8,})', 'i'));
    if (!m) continue;
    const ascii = m[1].trim().split(/\s+/)
      .map(h => String.fromCharCode(parseInt(h, 16))).join('');
    // RA0/RA2-entry parts store the 16-byte string byte-reversed at 0x01001C10
    // (e.g. "LFC3703E2AF7R" → "R7FA2E3073CFL"), so try both orderings.
    for (const cand of [ascii, [...ascii].reverse().join('')]) {
      const pm = cand.match(/R7FA([0-9][A-Z][0-9])([A-Z0-9]*)/);
      if (pm) return { group: 'RA' + pm[1], partNumber: 'R7FA' + pm[1] + pm[2] };
    }
  }
  return null;
}

// Resolve the exact board for a connected target, mutating `info`. Tries signals
// in order of authority and stops at the first that matches the detected core:
//   1. on-silicon Part Number  (exact MCU group + orderable part number)
//   2. J-Link OB firmware token (exact group, but reflects the PROBE)
//   3. on-chip memory-size probe (M33 / M4 groups)
// If all fail, the caller applies the core-level fallback as a last resort.
async function resolveBoard(info, raw, iface, speed) {
  // 1. Part Number read from factory flash — definitive.
  const pn = parsePartNumber(raw);
  const pnHint = pn && hintFromGroup(pn.group);
  if (pnHint && coreCompatible(info.core, pnHint.core)) {
    applyHint(info, pnHint);
    if (pn.partNumber) info.vendorHint.partNumber = pn.partNumber;   // exact orderable part
    return;
  }
  // 2. J-Link OB firmware token.
  const obHint = hintFromGroup(parseOBToken(raw));
  if (obHint && coreCompatible(info.core, obHint.core)) { applyHint(info, obHint); return; }
  // 3. On-chip memory-size probe.
  if (info.core === 'Cortex-M33')      applyHint(info, await identifyRenesasRA(iface, speed));
  else if (info.core === 'Cortex-M4')  applyHint(info, await identifyRenesasRACM4(iface, speed));
}

// REST: auto-identify target — two-phase approach
//
// Phase 1a (JTAG scan):  blank at Device> lets J-Link scan the JTAG chain.
//   Even a failed connection prints the real DP IDCODE which tells us the core.
//
// Phase 1b (SWD scan):   runs only when JTAG finds nothing (SWD-only boards).
//   A blank Device> entry still triggers a SW-DP IDCODE read before failing.
//
// Phase 2 (connect):  uses the IDCODE-derived device name (or generic fallback)
//   to connect properly, then reads the ARM CPUID register at 0xE000ED00 for
//   full core identification (revision, FPU, architecture, vendor hint).
app.post('/api/auto-identify', async (req, res) => {
  if (!JLINK_EXE) return res.status(503).json({ error: 'JLink.exe not found' });

  // ── Phase 1a: JTAG scan ──────────────────────────────────────────────────
  let phase1Raw = '';
  let scanInfo  = {};
  try {
    phase1Raw = await runJLinkStdin('JTAG', 1000, ['connect', '', 'exit'], 12000);
    scanInfo  = parseJLinkOutput(phase1Raw);
  } catch (e) {
    phase1Raw = e.message;
  }

  // ── Phase 1b: SWD scan (only when JTAG produced no IDCODE) ───────────────
  let phase1SwdRaw = '';
  if (!scanInfo.devicesToTry || !scanInfo.devicesToTry.length) {
    try {
      phase1SwdRaw = await runJLinkStdin('SWD', 4000, ['connect', '', 'exit'], 10000);
      const swdInfo = parseJLinkOutput(phase1SwdRaw);
      // SWD info takes precedence — merge in SW-DP IDCODE / devicesToTry
      scanInfo = { ...scanInfo, ...swdInfo };
    } catch (e) {
      phase1SwdRaw = e.message;
    }
  }

  const results = [];
  const devicesToTry = scanInfo.devicesToTry || [];

  // ── Phase 2: connect with the resolved (or generic) device name ──────────
  if (devicesToTry.length) {
    // IDCODE told us exactly which core family — try SWD first, then JTAG
    outer:
    for (const iface of ['SWD', 'JTAG']) {
      for (const device of devicesToTry) {
        const entry = { interface: iface, connected: false, info: {}, raw: '', usedDevice: device };
        try {
          // Read CPUID + the factory-flash Part Number (all candidate addresses)
          // in one connect session — the PNR gives the exact device at no extra cost.
          const cmds   = ['connect', device, 'mem32 0xE000ED00 1',
                          'mem8 0x030080F0 16', 'mem8 0x010080F0 16', 'mem8 0x01001C10 16', 'exit'];
          const output = await runJLinkStdin(iface, 4000, cmds, 15000);
          const info2  = parseJLinkOutput(output);

          entry.info = { ...scanInfo, ...info2 };
          if (!entry.info.core && scanInfo.core) entry.info.core = scanInfo.core;

          const failed    = /Could not connect|Cannot connect|Error while|Failed to|not supported/i.test(output) && !info2.cpuidRaw;
          entry.connected = !failed && !!(info2.cpuidRaw || info2.core);
          entry.raw       = `[Phase 1a – JTAG scan]\n${phase1Raw}\n\n[Phase 2 – ${iface} as "${device}"]\n${output}`;

          if (entry.connected) {
            await resolveBoard(entry.info, `${phase1Raw}\n${phase1SwdRaw}\n${output}`, iface, 4000);
          }
        } catch (err) {
          entry.raw = err.message;
        }

        results.push(entry);
        if (entry.connected) break outer;
      }
    }
  } else {
    // No IDCODE from either JTAG or SWD scan.
    // Probe generic Cortex-M device names via SWD at two speeds: fast first,
    // then slow (1000 kHz) in case the target needs a gentler clock.
    const combinedPhase1 = `[Phase 1a – JTAG scan]\n${phase1Raw}\n\n[Phase 1b – SWD scan]\n${phase1SwdRaw}`;
    let found = false;
    let lastAttemptRaw = '';

    outer2:
    for (const speed of [4000, 1000, 500, 200]) {
      for (const device of SWD_GENERIC_FALLBACK) {
        const entry = { interface: 'SWD', connected: false, info: {}, raw: '', usedDevice: device };
        try {
          const cmds   = ['connect', device, 'mem32 0xE000ED00 1',
                          'mem8 0x030080F0 16', 'mem8 0x010080F0 16', 'mem8 0x01001C10 16', 'exit'];
          const output = await runJLinkStdin('SWD', speed, cmds, 15000);
          const info2  = parseJLinkOutput(output);

          lastAttemptRaw = `[SWD fallback: "${device}" @ ${speed} kHz]\n${output}`;
          entry.info = { ...scanInfo, ...info2 };
          const failed    = /Could not connect|Cannot connect|Error while|Failed to|not supported/i.test(output) && !info2.cpuidRaw;
          entry.connected = !failed && !!(info2.cpuidRaw || info2.core);
          entry.raw       = `${combinedPhase1}\n\n${lastAttemptRaw}`;

          if (entry.connected) {
            await resolveBoard(entry.info, `${combinedPhase1}\n${output}`, 'SWD', speed);
          }
        } catch (err) {
          lastAttemptRaw = `[SWD fallback: "${device}" @ ${speed} kHz]\n${err.message}`;
          entry.raw       = `${combinedPhase1}\n\n${lastAttemptRaw}`;
        }
        if (entry.connected) {
          results.push(entry);
          found = true;
          break outer2;
        }
      }
    }

    if (!found) {
      const allRaw = `${combinedPhase1}\n\n${lastAttemptRaw}`;
      const ob = detectJLinkOBBoard(allRaw);
      // OB detection tells us which PROBE is being used, NOT which TARGET board
      // is connected. Treat it as a diagnostic warning only — the target could
      // be a completely different board plugged into this probe's debug header.
      results.push({
        interface: 'JTAG + SWD',
        connected: false,
        info: scanInfo,
        obProbe: ob || null,   // passed to UI for a warning note
        raw: allRaw,
      });
    }
  }

  if (!results.length) {
    results.push({ interface: 'JTAG scan', connected: false, info: scanInfo, raw: phase1Raw });
  }

  // Final fallback: a connected target whose exact board we couldn't pin (no OB
  // match, no size-probe path) still resolves to its core's board list, so the
  // FSP examples / e2 studio panel always appears and the user can pick the board.
  for (const entry of results) {
    if (entry.connected && entry.info && entry.info.core
        && (!entry.info.vendorHint || !entry.info.vendorHint.board)) {
      applyHint(entry.info, coreFallbackHint(entry.info.core));
    }
  }

  res.json({ results });
});

// REST: run a non-interactive J-Link script and return output
app.post('/api/run-script', (req, res) => {
  if (!JLINK_EXE) return res.status(503).json({ error: 'JLink.exe not found' });

  const { script, device, interface: iface, speed } = req.body;
  if (!script) return res.status(400).json({ error: 'script is required' });

  const tmpScript = path.join(os.tmpdir(), `jlink_${Date.now()}.jlink`);
  fs.writeFileSync(tmpScript, script + '\nExit\n');

  const args = [
    '-NoGui', '1',
    '-ExitOnError', '1',
    ...(device ? ['-Device', device] : []),
    ...(iface ? ['-If', iface] : ['-If', 'SWD']),
    ...(speed ? ['-Speed', String(speed)] : ['-Speed', '4000']),
    '-CommanderScript', tmpScript,
  ];

  const jlink = spawn(JLINK_EXE, args);
  let stdout = '';
  let stderr = '';

  jlink.stdout.on('data', d => { stdout += d.toString(); });
  jlink.stderr.on('data', d => { stderr += d.toString(); });

  jlink.on('close', code => {
    fs.unlink(tmpScript, () => {});
    res.json({ exitCode: code, stdout, stderr });
  });

  jlink.on('error', err => {
    res.status(500).json({ error: err.message });
  });
});

// Optional GitHub PAT — raises rate limit from 60 to 5000 req/hour
let githubToken = process.env.GITHUB_TOKEN || '';

app.post('/api/set-github-token', (req, res) => {
  githubToken = (req.body.token || '').trim();
  examplesCache.clear(); // clear cache so next request hits GitHub fresh
  res.json({ ok: true, hasToken: !!githubToken });
});

app.get('/api/github-status', (req, res) => {
  res.json({ hasToken: !!githubToken });
});

// REST: fetch example projects for an identified board from GitHub
function githubFetch(apiPath) {
  const headers = { 'User-Agent': 'renesas365patch/1.0' };
  if (githubToken) headers['Authorization'] = `Bearer ${githubToken}`;
  return new Promise((resolve, reject) => {
    https.get(
      { hostname: 'api.github.com', path: apiPath, headers },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch(e) { reject(e); }
        });
      }
    ).on('error', reject);
  });
}

// In-memory cache: board → { projects, cachedAt }
const examplesCache = new Map();
const EXAMPLES_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

app.get('/api/examples', async (req, res) => {
  const board = (req.query.board || '').trim();
  if (!board) return res.status(400).json({ error: 'board param required' });

  // Serve from cache if fresh
  const cached = examplesCache.get(board);
  if (cached && (Date.now() - cached.cachedAt) < EXAMPLES_CACHE_TTL_MS) {
    return res.json({ board, dir: cached.dir, projects: cached.projects, fromCache: true });
  }

  const dir = board.toLowerCase().replace(/-/g, '_');
  try {
    const { status, data } = await githubFetch(
      `/repos/renesas/ra-fsp-examples/contents/example_projects/${dir}`
    );
    if (status === 200 && Array.isArray(data)) {
      const projects = data
        .filter(item => item.type === 'dir')
        .map(item => ({ name: item.name, url: item.html_url }));
      examplesCache.set(board, { dir, projects, cachedAt: Date.now() });
      res.json({ board, dir, projects });
    } else if (status === 403) {
      // Rate limited — serve stale cache if available, otherwise report error
      if (cached) {
        return res.json({ board, dir: cached.dir, projects: cached.projects, fromCache: true, stale: true });
      }
      res.json({ board, dir, projects: [], rateLimited: true, message: 'GitHub API rate limit reached — try again in a few minutes.' });
    } else {
      res.json({ board, dir, projects: [], message: data.message || 'Not found' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch a URL as text, following a few redirects (https only). Requests an
// uncompressed body so we can regex it directly.
function httpGetText(url, timeoutMs = 12000, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'board_shazam/1.0', 'Accept-Encoding': 'identity', 'Accept': 'text/html' },
    }, resp => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && redirectsLeft > 0) {
        resp.resume();
        const next = new URL(resp.headers.location, url).toString();
        return resolve(httpGetText(next, timeoutMs, redirectsLeft - 1));
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', d => { body += d; });
      resp.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

// Find the board's product photo in a Renesas board-page's HTML. Renesas hosts
// these at /sites/default/files/<slug>-board*.png (with -kit / generic fallbacks).
function findBoardImage(html, slug) {
  const pats = [
    new RegExp(`/sites/default/files/${slug}-board[^"'\\s)]*\\.(?:png|jpe?g|webp)`, 'i'),
    new RegExp(`/sites/default/files/${slug}-kit[^"'\\s)]*\\.(?:png|jpe?g|webp)`, 'i'),
    new RegExp(`/sites/default/files/${slug}[^"'\\s)]*\\.(?:png|jpe?g|webp)`, 'i'),
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (m) return m[0].startsWith('http') ? m[0] : 'https://www.renesas.com' + m[0];
  }
  return null;
}

// REST: board picture + useful information links for an identified board.
// Image is scraped from the official Renesas board page (cached 24h); links are
// derived from the board name. Always returns links even if the image/page is
// unavailable, so the UI degrades gracefully.
const boardInfoCache = new Map();
const BOARD_INFO_TTL_MS = 24 * 60 * 60 * 1000;
app.get('/api/board-info', async (req, res) => {
  const board = (req.query.board || '').trim();
  if (!board) return res.status(400).json({ error: 'board param required' });

  const cached = boardInfoCache.get(board);
  if (cached && (Date.now() - cached.at) < BOARD_INFO_TTL_MS) return res.json(cached.data);

  const slug   = board.toLowerCase();              // EK-RA8M1  → ek-ra8m1
  const ghSlug = slug.replace(/-/g, '_');          //           → ek_ra8m1
  const productUrl = `https://www.renesas.com/en/design-resources/boards-kits/${slug}`;
  const data = {
    board,
    productUrl,
    imageUrl: null,
    links: [
      { label: 'Renesas Board Page',    url: productUrl },
      { label: 'Documents & Downloads', url: `https://www.renesas.com/en/search?q=${encodeURIComponent(board)}` },
      { label: 'FSP Example Projects',  url: `https://github.com/renesas/ra-fsp-examples/tree/master/example_projects/${ghSlug}` },
    ],
  };
  try {
    data.imageUrl = findBoardImage(await httpGetText(productUrl), slug);
  } catch { /* page missing (e.g. legacy board) — links still useful */ }

  boardInfoCache.set(board, { at: Date.now(), data });
  res.json(data);
});

// REST: get detected e2studio path
app.get('/api/e2studio-path', (req, res) => {
  res.json({ path: E2STUDIO_EXE, found: !!E2STUDIO_EXE });
});

// REST: app/about info — version, board-catalog size, and the detected toolchain.
app.get('/api/about', (req, res) => {
  const boards = new Set();
  RA_CATALOG.forEach(e => e.boards.forEach(b => boards.add(b)));
  let version = '1.0.0';
  try { version = require('./package.json').version || version; } catch {}
  res.json({
    name:     'board_shazam',
    version,
    groups:   RA_CATALOG.length,
    boards:   boards.size,
    jlink:    JLINK_EXE   || null,
    e2studio: E2STUDIO_EXE || null,
    node:     process.version,
  });
});

// Run a command to completion; resolve {code, out}, reject only on spawn error.
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts);
    let out = '';
    if (proc.stdout) proc.stdout.on('data', d => out += d.toString());
    if (proc.stderr) proc.stderr.on('data', d => out += d.toString());
    const timer = opts.timeoutMs ? setTimeout(() => { try { proc.kill(); } catch {} }, opts.timeoutMs) : null;
    proc.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, out }); });
    proc.on('error', err => { if (timer) clearTimeout(timer); reject(err); });
  });
}

// FSP example board folder slug — matches the /api/examples mapping.
function boardSlug(board) {
  return String(board || '').toLowerCase().replace(/-/g, '_');
}

function dirHasFiles(d) {
  try { return fs.existsSync(d) && fs.readdirSync(d).length > 0; } catch { return false; }
}

// Download ONE example project from renesas/ra-fsp-examples into destDir using a
// shallow, blob-less sparse git checkout (only that project's files are fetched).
// The project is board-specific in the repo, so the board/device is already
// configured inside its configuration.xml / .cproject.
async function downloadExample(board, project, destDir) {
  const repoRel = `example_projects/${boardSlug(board)}/${project}`;
  const tmp = path.join(os.tmpdir(), `fsp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  try {
    let r = await runCmd('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse',
      'https://github.com/renesas/ra-fsp-examples.git', tmp], { timeoutMs: 180000 });
    if (r.code !== 0) throw new Error('git clone failed: ' + r.out.slice(-300));

    r = await runCmd('git', ['-C', tmp, 'sparse-checkout', 'set', repoRel], { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error('git sparse-checkout failed: ' + r.out.slice(-300));

    const src = path.join(tmp, ...repoRel.split('/'));
    if (!fs.existsSync(src)) throw new Error(`Example "${project}" not found for board ${board} (looked for ${repoRel}).`);

    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(src, destDir, { recursive: true });
  } finally {
    cleanup();
  }
}

// Best-effort headless import of a project directory into an Eclipse workspace.
function e2HeadlessImport(workspace, projectDir) {
  const cli = findEclipsec();
  if (!cli) return Promise.resolve({ ok: false, message: 'Headless CLI (eclipsec.exe) not found — opened GUI only; import the project manually.' });
  return runCmd(cli, ['-nosplash', '-application',
    'org.eclipse.cdt.managedbuilder.core.headlessbuild',
    '-data', workspace, '-importAll', projectDir, '-no-indexer'], { timeoutMs: 180000 })
    .then(r => ({ ok: r.code === 0, message: (r.out || '').slice(-400) }))
    .catch(err => ({ ok: false, message: err.message }));
}

// REST: download the FSP example, import it into a workspace, and launch e2studio.
//   body: { path: <projectDir>, board: <EK-RAxxxx>, project: <repo folder name> }
// The workspace is the parent of projectDir. If board/project are omitted (or the
// project already exists), the download step is skipped and the existing folder is
// imported / opened as-is.
app.post('/api/open-e2studio', async (req, res) => {
  const { path: projectDir, board, project } = req.body || {};
  if (!projectDir) return res.status(400).json({ error: 'path is required' });
  if (!E2STUDIO_EXE) return res.status(503).json({ error: 'e2studio not found (set E2STUDIO_PATH to e2studio.exe)' });

  try {
    let downloaded = false;
    if (board && project && !dirHasFiles(projectDir)) {
      await downloadExample(board, project, projectDir);
      downloaded = true;
    }

    const workspace = path.dirname(projectDir);
    const imported = await e2HeadlessImport(workspace, projectDir);

    const child = spawn(E2STUDIO_EXE, ['-data', workspace], { detached: true, stdio: 'ignore' });
    child.unref();

    res.json({
      ok: true,
      downloaded,
      imported: imported.ok,
      importMessage: imported.message,
      workspace,
      projectDir,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket: interactive J-Link Commander session
wss.on('connection', ws => {
  if (!JLINK_EXE) {
    ws.send(JSON.stringify({ type: 'error', data: 'JLink.exe not found on this system.' }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: 'info', data: `Using: ${JLINK_EXE}\r\n` }));

  let jlink = null;
  let sessionParams = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'start') {
      if (jlink) { jlink.kill(); jlink = null; }

      sessionParams = {
        device: msg.device || '',
        iface: msg.interface || 'SWD',
        speed: msg.speed || '4000',
      };

      const args = [
        '-NoGui', '1',
        ...(sessionParams.device ? ['-Device', sessionParams.device] : []),
        '-If', sessionParams.iface,
        '-Speed', sessionParams.speed,
      ];

      ws.send(JSON.stringify({ type: 'info', data: `\r\nStarting J-Link Commander...\r\nArgs: ${args.join(' ')}\r\n\r\n` }));

      jlink = spawn(JLINK_EXE, args);

      jlink.stdout.on('data', data => {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: 'stdout', data: data.toString() }));
      });

      jlink.stderr.on('data', data => {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: 'stderr', data: data.toString() }));
      });

      jlink.on('close', code => {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: 'exit', data: `\r\n[Process exited with code ${code}]\r\n` }));
        jlink = null;
      });

      jlink.on('error', err => {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: 'error', data: `\r\n[Error: ${err.message}]\r\n` }));
        jlink = null;
      });

    } else if (msg.type === 'input') {
      if (jlink && jlink.stdin.writable) {
        jlink.stdin.write(msg.data);
      }

    } else if (msg.type === 'stop') {
      if (jlink) { jlink.kill(); jlink = null; }
      ws.send(JSON.stringify({ type: 'info', data: '\r\n[Session terminated]\r\n' }));
    }
  });

  ws.on('close', () => {
    if (jlink) { jlink.kill(); jlink = null; }
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`J-Link Web UI running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (listening on all interfaces)`);
  console.log(`J-Link detected: ${JLINK_EXE || 'NOT FOUND'}`);
  console.log(`e2 studio detected: ${E2STUDIO_EXE || 'NOT FOUND'}`);
  console.log(`e2 studio headless CLI: ${findEclipsec() || 'NOT FOUND (GUI import fallback)'}`);
});
