'use strict';
// Hardware check: decides how well this PC can run the local AI before anything is installed.
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const sh = (cmd, args, timeout = 15000) => new Promise(res => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 22 }, (e, out) => res(e ? '' : String(out)));
});

async function gpus() {
  const list = [];
  const smi = await sh('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  for (const line of smi.split(/\r?\n/).filter(Boolean)) {
    const [name, mem, driver] = line.split(',').map(s => s.trim());
    list.push({ vendor: 'nvidia', name, vramMB: Number(mem) || 0, driver });
  }
  if (list.length) return list;
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      const chip = (await sh('sysctl', ['-n', 'machdep.cpu.brand_string'])).trim() || 'Apple Silicon';
      list.push({ vendor: 'apple', name: chip, vramMB: Math.round(os.totalmem() / 1048576 * 0.7), unified: true });
    } else list.push({ vendor: 'intel-mac', name: 'Mac Intel', vramMB: 0 });
    return list;
  }
  if (process.platform === 'win32') {
    // DriverDesc + 64-bit memory size from the display-adapter class key (AdapterRAM caps at 4 GB).
    const ps = await sh('powershell', ['-NoProfile', '-Command',
      "Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.DriverDesc) { $p.DriverDesc + '|' + $p.'HardwareInformation.MemorySize' + '|' + $p.'HardwareInformation.qwMemorySize' } }"]);
    for (const line of ps.split(/\r?\n/).filter(Boolean)) {
      const [name, ram, qw] = line.split('|');
      if (/basic display|remote|virtual|parsec|meta|idd/i.test(name)) continue;
      const vendor = /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : /nvidia/i.test(name) ? 'nvidia-nodriver' : 'other';
      const bytes = Number(qw) || Number(ram) || 0;
      list.push({ vendor, name: name.trim(), vramMB: Math.round(bytes / 1048576) });
    }
    return list;
  }
  const lspci = await sh('lspci', []);
  for (const line of lspci.split('\n').filter(l => /vga|3d controller/i.test(l))) {
    const vendor = /amd|radeon/i.test(line) ? 'amd' : /intel/i.test(line) ? 'intel' : /nvidia/i.test(line) ? 'nvidia-nodriver' : 'other';
    list.push({ vendor, name: line.replace(/^.*?: /, ''), vramMB: 0 });
  }
  return list;
}

function freeDiskGB(dir) {
  try {
    let d = dir;
    while (d && !fs.existsSync(d)) d = require('node:path').dirname(d);
    const s = fs.statfsSync(d);
    return Math.round((s.bavail * s.bsize) / 1073741824);
  } catch { return null; }
}

/**
 * Returns { level: 'great'|'good'|'limited'|'unsupported', torch: 'cu128'|'cpu'|'mps'|..., lowVram, notes[], recommend{packs} }
 */
async function check(installDir) {
  const g = await gpus();
  const ramGB = Math.round(os.totalmem() / 1073741824);
  const diskGB = freeDiskGB(installDir);
  const best = g.slice().sort((a, b) => b.vramMB - a.vramMB)[0] || null;
  const notes = [];
  let level = 'unsupported', torch = 'cpu', lowVram = false;
  const vramGB = best ? Math.round(best.vramMB / 1024) : 0;

  if (best?.vendor === 'nvidia') {
    torch = 'cu128';
    if (vramGB >= 12) { level = 'great'; notes.push({ t: 'ok', k: 'hw.nvidiaGreat', v: { name: best.name, vram: vramGB } }); }
    else if (vramGB >= 8) { level = 'good'; notes.push({ t: 'ok', k: 'hw.nvidiaGood', v: { name: best.name, vram: vramGB } }); }
    else if (vramGB >= 6) { level = 'limited'; lowVram = true; notes.push({ t: 'warn', k: 'hw.nvidiaLow', v: { name: best.name, vram: vramGB } }); }
    else { level = 'limited'; lowVram = true; notes.push({ t: 'bad', k: 'hw.nvidiaTiny', v: { name: best.name, vram: vramGB } }); }
  } else if (best?.vendor === 'apple') {
    torch = 'mps';
    if (ramGB >= 32) { level = 'good'; notes.push({ t: 'ok', k: 'hw.appleGood', v: { name: best.name, ram: ramGB } }); }
    else if (ramGB >= 16) { level = 'limited'; notes.push({ t: 'warn', k: 'hw.appleMid', v: { name: best.name, ram: ramGB } }); }
    else { level = 'unsupported'; notes.push({ t: 'bad', k: 'hw.appleLow', v: { name: best.name, ram: ramGB } }); }
  } else if (best?.vendor === 'nvidia-nodriver') {
    level = 'limited'; notes.push({ t: 'bad', k: 'hw.nvidiaNoDriver', v: { name: best.name } });
  } else if (best?.vendor === 'amd' && process.platform === 'linux') {
    torch = 'rocm6.3'; level = 'limited'; notes.push({ t: 'warn', k: 'hw.amdLinux', v: { name: best.name } });
  } else {
    level = 'unsupported';
    notes.push({ t: 'bad', k: 'hw.noGpu', v: { name: best?.name || '—' } });
  }

  if (ramGB < 12) { notes.push({ t: 'bad', k: 'hw.ramLow', v: { ram: ramGB } }); if (level === 'great') level = 'good'; else if (level === 'good') level = 'limited'; }
  else if (ramGB < 16) notes.push({ t: 'warn', k: 'hw.ramMid', v: { ram: ramGB } });
  else notes.push({ t: 'ok', k: 'hw.ramOk', v: { ram: ramGB } });

  if (diskGB != null) {
    if (diskGB < 25) notes.push({ t: 'bad', k: 'hw.diskLow', v: { disk: diskGB } });
    else if (diskGB < 50) notes.push({ t: 'warn', k: 'hw.diskMid', v: { disk: diskGB } });
    else notes.push({ t: 'ok', k: 'hw.diskOk', v: { disk: diskGB } });
  }

  const unifiedGB = best?.vendor === 'apple' ? ramGB : vramGB;
  const recommend = {
    base: level !== 'unsupported',
    style: (level === 'great' || level === 'good'),
    anime: level === 'great' || level === 'good',
    zimage: (best?.vendor === 'nvidia' && vramGB >= 12 && ramGB >= 16) || (best?.vendor === 'apple' && ramGB >= 48),
  };
  return {
    level, torch, lowVram, cpuOnly: torch === 'cpu', notes, recommend,
    system: { os: `${os.type()} ${os.release()}`, arch: process.arch, cpu: os.cpus()[0]?.model || '', cores: os.cpus().length, ramGB, diskGB, gpus: g, vramGB: unifiedGB },
  };
}

module.exports = { check, freeDiskGB };
