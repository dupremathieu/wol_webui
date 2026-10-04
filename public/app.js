'use strict';

const state = {
  devices: [],
  status: {},
  editingId: null,
};

const els = {
  form: document.getElementById('device-form'),
  formTitle: document.getElementById('form-title'),
  id: document.getElementById('device-id'),
  name: document.getElementById('name'),
  mac: document.getElementById('mac'),
  ip: document.getElementById('ip'),
  submitBtn: document.getElementById('submit-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  body: document.getElementById('device-body'),
  empty: document.getElementById('empty'),
  pingAll: document.getElementById('ping-all'),
  pingForm: document.getElementById('ping-form'),
  pingHost: document.getElementById('ping-host'),
  pingResult: document.getElementById('ping-result'),
  toast: document.getElementById('toast'),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Erreur ${response.status}`);
  }
  return data;
}

let toastTimer;
function toast(message, type = 'info') {
  els.toast.textContent = message;
  els.toast.className = `toast show ${type}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
    els.toast.hidden = true;
  }, 3500);
}

function makeButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = className;
  button.addEventListener('click', onClick);
  return button;
}

function statusBadge(deviceId) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  const status = state.status[deviceId];

  if (!status) {
    badge.classList.add('unknown');
    badge.textContent = 'Inconnu';
  } else if (status === 'checking') {
    badge.classList.add('checking');
    badge.textContent = 'Vérification…';
  } else if (status.alive) {
    badge.classList.add('online');
    badge.textContent = status.rtt != null ? `En ligne · ${status.rtt} ms` : 'En ligne';
  } else {
    badge.classList.add('offline');
    badge.textContent = 'Hors ligne';
  }
  return badge;
}

function renderRow(device) {
  const row = document.createElement('tr');

  const nameCell = document.createElement('td');
  nameCell.className = 'name';
  nameCell.textContent = device.name;

  const macCell = document.createElement('td');
  macCell.className = 'mono';
  macCell.textContent = device.mac;

  const ipCell = document.createElement('td');
  ipCell.className = 'mono';
  ipCell.textContent = device.ip || '—';

  const statusCell = document.createElement('td');
  statusCell.appendChild(statusBadge(device.id));

  const actionsCell = document.createElement('td');
  actionsCell.className = 'actions-cell';
  actionsCell.append(
    makeButton('Wake', 'primary small', () => wake(device)),
    makeButton('Ping', 'small', () => ping(device)),
    makeButton('Éditer', 'ghost small', () => startEdit(device)),
    makeButton('Supprimer', 'danger small', () => remove(device)),
  );

  row.append(nameCell, macCell, ipCell, statusCell, actionsCell);
  return row;
}

function render() {
  els.body.textContent = '';
  els.empty.hidden = state.devices.length > 0;
  for (const device of state.devices) {
    els.body.appendChild(renderRow(device));
  }
}

async function load() {
  state.devices = await api('/api/devices');
  render();
}

function resetForm() {
  state.editingId = null;
  els.form.reset();
  els.id.value = '';
  els.formTitle.textContent = 'Ajouter un appareil';
  els.submitBtn.textContent = 'Ajouter';
  els.cancelBtn.hidden = true;
  els.name.focus();
}

function startEdit(device) {
  state.editingId = device.id;
  els.formTitle.textContent = 'Modifier un appareil';
  els.submitBtn.textContent = 'Enregistrer';
  els.cancelBtn.hidden = false;
  els.name.value = device.name;
  els.mac.value = device.mac;
  els.ip.value = device.ip || '';
  els.name.focus();
}

async function submitForm(event) {
  event.preventDefault();
  const payload = {
    name: els.name.value.trim(),
    mac: els.mac.value.trim(),
    ip: els.ip.value.trim(),
  };

  try {
    if (state.editingId) {
      await api(`/api/devices/${state.editingId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      toast('Appareil modifié', 'success');
    } else {
      await api('/api/devices', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast('Appareil ajouté', 'success');
    }
    resetForm();
    await load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function remove(device) {
  if (!window.confirm(`Supprimer « ${device.name} » ?`)) return;
  try {
    await api(`/api/devices/${device.id}`, { method: 'DELETE' });
    delete state.status[device.id];
    toast('Appareil supprimé', 'success');
    await load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function wake(device) {
  try {
    const result = await api(`/api/devices/${device.id}/wake`, { method: 'POST' });
    if (result.ok) {
      toast(`Paquet magique envoyé à ${device.name}`, 'success');
    } else {
      toast(`Échec de l'envoi du paquet à ${device.name}`, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function ping(device) {
  if (!device.ip) {
    toast('Aucune adresse renseignée pour cet appareil', 'error');
    return;
  }
  state.status[device.id] = 'checking';
  render();
  try {
    const result = await api(`/api/devices/${device.id}/ping`, { method: 'POST' });
    state.status[device.id] = { alive: result.alive, rtt: result.rtt };
  } catch (err) {
    state.status[device.id] = { alive: false };
    toast(err.message, 'error');
  }
  render();
}

async function pingAll() {
  if (state.devices.length === 0) return;
  await Promise.all(state.devices.map((device) => ping(device)));
}

async function quickPing(event) {
  event.preventDefault();
  const host = els.pingHost.value.trim();
  els.pingResult.textContent = 'Ping en cours…';
  els.pingResult.className = 'ping-result';

  try {
    const result = await api('/api/ping', {
      method: 'POST',
      body: JSON.stringify({ host }),
    });
    if (result.alive) {
      els.pingResult.textContent = result.rtt != null
        ? `✔ ${host} répond en ${result.rtt} ms`
        : `✔ ${host} répond`;
      els.pingResult.className = 'ping-result success';
    } else {
      els.pingResult.textContent = `✘ ${host} ne répond pas`;
      els.pingResult.className = 'ping-result error';
    }
  } catch (err) {
    els.pingResult.textContent = err.message;
    els.pingResult.className = 'ping-result error';
  }
}

els.form.addEventListener('submit', submitForm);
els.cancelBtn.addEventListener('click', resetForm);
els.pingForm.addEventListener('submit', quickPing);
els.pingAll.addEventListener('click', pingAll);

load().catch((err) => toast(err.message, 'error'));
