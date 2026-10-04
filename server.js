'use strict';

/**
 * Wake-on-LAN Web UI - zero dependency backend.
 *
 * Serves the static frontend from ./public and exposes a small JSON API to
 * manage devices (name + MAC + IP), send Wake-on-LAN magic packets and run
 * connectivity checks with ping.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DEVICES_FILE = process.env.DEVICES_FILE
  ? path.resolve(process.env.DEVICES_FILE)
  : path.join(__dirname, 'devices.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const WOL_PORTS = [9, 7];
const MAX_BODY_BYTES = 1024 * 100;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT value: ${process.env.PORT}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isValidMac(mac) {
  return /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(mac);
}

function normalizeMac(mac) {
  return mac.replace(/-/g, ':').toLowerCase();
}

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  if (ipv4.test(host)) return true;
  const hostname = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
  return hostname.test(host);
}

function validateDevice(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const macRaw = typeof body.mac === 'string' ? body.mac.trim() : '';
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';

  if (!name) throw httpError(400, 'name is required');
  if (name.length > 100) throw httpError(400, 'name is too long');
  if (!isValidMac(macRaw)) throw httpError(400, 'invalid MAC address');
  if (ip && !isValidHost(ip)) throw httpError(400, 'invalid IP address or hostname');

  return { name, mac: normalizeMac(macRaw), ip };
}

/* -------------------------------------------------------------------------- */
/* Device storage (JSON file)                                                 */
/* -------------------------------------------------------------------------- */

// Serializes read-modify-write sequences so concurrent requests cannot lose
// updates. writeDevices() itself is atomic (temp file + rename).
let devicesLock = Promise.resolve();

function withDevicesLock(fn) {
  const run = devicesLock.then(() => fn());
  devicesLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readDevices() {
  try {
    const raw = await fsp.readFile(DEVICES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeDevices(devices) {
  const tmp = `${DEVICES_FILE}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, `${JSON.stringify(devices, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, DEVICES_FILE);
}

/* -------------------------------------------------------------------------- */
/* Wake-on-LAN                                                                */
/* -------------------------------------------------------------------------- */

function buildMagicPacket(mac) {
  const macBytes = Buffer.from(mac.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  const packet = Buffer.alloc(6 + 16 * macBytes.length, 0xff);
  for (let i = 0; i < 16; i += 1) {
    macBytes.copy(packet, 6 + i * macBytes.length);
  }
  return packet;
}

function broadcastAddress(ip, netmask) {
  const ipParts = ip.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);
  if (ipParts.length !== 4 || maskParts.length !== 4) throw new Error('invalid address');
  return ipParts.map((part, i) => (part | (~maskParts[i] & 255)) & 255).join('.');
}

function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal && net.netmask) {
        try {
          targets.add(broadcastAddress(net.address, net.netmask));
        } catch (err) {
          // ignore malformed interface data
        }
      }
    }
  }
  return [...targets];
}

function sendMagicPacket(packet, address, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        // some platforms reject broadcast on loopback; ignore
      }
      socket.send(packet, 0, packet.length, port, address, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

async function wakeDevice(device) {
  const packet = buildMagicPacket(device.mac);
  const targets = new Set(broadcastTargets());
  if (device.ip) targets.add(device.ip);

  const results = [];
  for (const address of targets) {
    for (const port of WOL_PORTS) {
      try {
        await sendMagicPacket(packet, address, port);
        results.push({ address, port, ok: true });
      } catch (err) {
        results.push({ address, port, ok: false, error: err.message });
      }
    }
  }

  return {
    mac: device.mac,
    targets: [...targets],
    ports: WOL_PORTS,
    ok: results.some((result) => result.ok),
    results,
  };
}

/* -------------------------------------------------------------------------- */
/* Ping                                                                       */
/* -------------------------------------------------------------------------- */

// `-W 2` is interpreted as seconds by iputils (Linux). On BSD/macOS the flag is
// in milliseconds; this project targets Linux / systemd deployments.
function pingHost(host) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', '-n', host], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        let message = 'unreachable';
        if (err.code === 'ENOENT') message = 'ping command not found';
        else if (err.killed || err.signal) message = 'timeout';
        resolve({ host, alive: false, error: message });
        return;
      }
      const match = /time[=<]\s*([\d.]+)\s*ms/.exec(stdout);
      resolve({ host, alive: true, rtt: match ? Number.parseFloat(match[1]) : null });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(httpError(413, 'payload too large'));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(httpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* API router                                                                 */
/* -------------------------------------------------------------------------- */

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // /api/ping
  if (parts.length === 2 && parts[1] === 'ping') {
    if (method !== 'POST') throw httpError(405, 'method not allowed');
    const body = await readBody(req);
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    if (!isValidHost(host)) throw httpError(400, 'invalid host');
    return sendJson(res, 200, await pingHost(host));
  }

  // /api/devices
  if (parts.length === 2 && parts[1] === 'devices') {
    if (method === 'GET') {
      return sendJson(res, 200, await readDevices());
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const record = await withDevicesLock(async () => {
        const device = validateDevice(body);
        const devices = await readDevices();
        const created = {
          id: crypto.randomUUID(),
          ...device,
          createdAt: new Date().toISOString(),
        };
        devices.push(created);
        await writeDevices(devices);
        return created;
      });
      return sendJson(res, 201, record);
    }
    throw httpError(405, 'method not allowed');
  }

  // /api/devices/:id
  if (parts.length === 3 && parts[1] === 'devices') {
    const id = parts[2];

    if (method === 'PUT') {
      const body = await readBody(req);
      const updated = await withDevicesLock(async () => {
        const devices = await readDevices();
        const index = devices.findIndex((d) => d.id === id);
        if (index === -1) throw httpError(404, 'device not found');
        const merged = validateDevice({ ...devices[index], ...body });
        devices[index] = { ...devices[index], ...merged };
        await writeDevices(devices);
        return devices[index];
      });
      return sendJson(res, 200, updated);
    }

    if (method === 'DELETE') {
      const removed = await withDevicesLock(async () => {
        const devices = await readDevices();
        const index = devices.findIndex((d) => d.id === id);
        if (index === -1) throw httpError(404, 'device not found');
        const [record] = devices.splice(index, 1);
        await writeDevices(devices);
        return record;
      });
      return sendJson(res, 200, removed);
    }

    throw httpError(405, 'method not allowed');
  }

  // /api/devices/:id/wake and /api/devices/:id/ping
  if (parts.length === 4 && parts[1] === 'devices' && method === 'POST') {
    const [, , id, action] = parts;
    const devices = await readDevices();
    const device = devices.find((d) => d.id === id);
    if (!device) throw httpError(404, 'device not found');

    if (action === 'wake') {
      const result = await wakeDevice(device);
      return sendJson(res, 200, { device: device.name, ...result });
    }
    if (action === 'ping') {
      if (!device.ip) throw httpError(400, 'device has no IP address');
      return sendJson(res, 200, { device: device.name, ...(await pingHost(device.ip)) });
    }
    throw httpError(404, 'not found');
  }

  throw httpError(404, 'not found');
}

/* -------------------------------------------------------------------------- */
/* HTTP server                                                                */
/* -------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (req.method === 'GET') {
      await serveStatic(res, url.pathname);
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, err.status || 500, { error: err.message || 'internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Wake-on-LAN Web UI listening on http://${HOST}:${PORT}`);
  console.log(`Devices file: ${DEVICES_FILE}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server };
