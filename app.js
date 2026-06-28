// ─── Estado ───
const state = {
  capacidadTotal: 0,    // peso total cargado en el recipiente
  lecturaOriginal: 0,   // lectura de MQTT previa a la configuración (referencia)
  pesoRestante: 0,      // lo que queda por descargar (siempre lo dicta MQTT)
  pesoDescarga: 0,      // cuánto se descarga por operación
  operaciones: 0,       // descargas realizadas
  cargado: false,       // si el recipiente fue cargado
  recibioLectura: false, // si ya llegó la primera lectura del firmware
  ultimoColorState: 'idle', // último estado de color notificado en el log
  conectado: false,
  ws: null,
};

const MQTT_URL = 'wss://broker.hivemq.com:8884/mqtt';
const MQTT_TOPIC_COMMAND = 'iot-parcial-2/balanza-01/command';
const MQTT_TOPIC_STATUS = 'iot-parcial-2/balanza-01/status';


// ─── Elementos ───
const $pesoDisplay    = document.getElementById('peso-display');
const $estadoText     = document.getElementById('estado-text');
const $bar            = document.getElementById('weight-bar');
const $displayCard    = document.querySelector('.display-card');
const $descargaInput  = document.getElementById('descarga-input');
const $btnCargar      = document.getElementById('btn-cargar');
const $btnDescargar   = document.getElementById('btn-descargar');
const $maxLabel       = document.getElementById('max-label');
const $log            = document.getElementById('log-list');
const $connDot        = document.getElementById('conn-dot');
const $connText       = document.getElementById('conn-text');
const $btnConn        = document.getElementById('btn-connect');

// ─── Determinar estado de color ───
function getColorState() {
  if (!state.cargado) return 'idle';
  if (state.pesoRestante <= 0) return 'empty';
  if (state.pesoDescarga > 0 && state.pesoRestante <= state.pesoDescarga * 2) return 'warning';
  return 'ok';
}

// ─── UI update ───
function actualizarUI() {
  const peso = state.pesoRestante;
  const colorState = getColorState();

  // Display principal
  $pesoDisplay.innerHTML = `${peso.toFixed(2)}<span id="peso-unit">g</span>`;

  // Limpiar clases de color
  $pesoDisplay.classList.remove('color-ok', 'color-warning', 'color-empty');
  $displayCard.classList.remove('state-ok', 'state-warning', 'state-empty');
  $bar.classList.remove('bar-warning', 'bar-empty');

  // Aplicar estado de color
  switch (colorState) {
    case 'ok':
      $pesoDisplay.classList.add('color-ok');
      $displayCard.classList.add('state-ok');
      $estadoText.textContent = 'Carga activa';
      $estadoText.style.color = 'var(--accent)';
      break;
    case 'warning':
      $pesoDisplay.classList.add('color-warning');
      $displayCard.classList.add('state-warning');
      $bar.classList.add('bar-warning');
      $estadoText.textContent = '⚠ Quedan pocas descargas';
      $estadoText.style.color = 'var(--warning)';
      break;
    case 'empty':
      $pesoDisplay.classList.add('color-empty');
      $displayCard.classList.add('state-empty');
      $bar.classList.add('bar-empty');
      $estadoText.textContent = '● Recipiente vacío';
      $estadoText.style.color = 'var(--danger)';
      break;
    default:
      $estadoText.textContent = 'Sin carga';
      $estadoText.style.color = 'var(--text-dim)';
  }

  // Barra de capacidad
  const pct = state.capacidadTotal > 0
    ? (peso / state.capacidadTotal) * 100
    : 0;
  $bar.style.width = Math.max(pct, 0) + '%';
  $maxLabel.textContent = state.capacidadTotal > 0 ? state.capacidadTotal.toFixed(0) + ' g' : '— g';

  // Descargas restantes
  const descargasRest = state.pesoDescarga > 0
    ? Math.floor(state.pesoRestante / state.pesoDescarga)
    : 0;

  // Info panel
  // Apenas llega la primera lectura del firmware el sistema está activo,
  // aunque todavía no se haya configurado la descarga.
  const activo = state.cargado || state.recibioLectura;
  document.getElementById('info-capacidad').textContent     = activo ? state.capacidadTotal.toFixed(2) + ' g' : '— g';
  document.getElementById('info-restante').textContent      = activo ? peso.toFixed(2) + ' g' : '— g';
  document.getElementById('info-descarga').textContent      = state.cargado ? state.pesoDescarga.toFixed(2) + ' g' : '— g';
  document.getElementById('info-descargas-rest').textContent = state.cargado ? descargasRest.toString() : '—';
  document.getElementById('info-ops').textContent           = state.operaciones;
  document.getElementById('info-estado').textContent        = state.cargado
    ? (colorState === 'empty' ? 'Vacío' : colorState === 'warning' ? 'Bajo' : 'Activa')
    : (state.recibioLectura ? 'Activa' : 'Inactiva');

  // Habilitar/deshabilitar botón descargar
  $btnDescargar.disabled = !state.cargado || state.pesoRestante <= 0;

  // Deshabilitar inputs si ya configuró
  $descargaInput.disabled  = state.cargado;
  $btnCargar.disabled      = state.cargado;
}

// ─── Log ───
function addLog(msg, type = '') {
  const now = new Date();
  const time = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (type ? ` log-${type}` : '');
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  $log.prepend(entry);
}

// ─── Configurar descarga ───
// La capacidad ya no se ingresa: se toma del peso recibido por MQTT.
function configurarDescarga() {
  const descarga = parseFloat($descargaInput.value);

  if (isNaN(descarga) || descarga <= 0) {
    addLog('Ingresá un peso de descarga válido mayor a 0', 'warn');
    return;
  }

  const capacidad = state.pesoRestante;   // valor obtenido desde MQTT
  if (isNaN(capacidad) || capacidad <= 0) {
    addLog('Esperando peso desde MQTT para configurar la descarga', 'warn');
    return;
  }
  if (descarga > capacidad) {
    addLog('El peso de descarga no puede ser mayor al peso actual', 'warn');
    return;
  }

  state.lecturaOriginal  = capacidad;   // guardamos la lectura previa a configurar
  state.capacidadTotal   = capacidad;
  state.pesoRestante     = capacidad;
  state.pesoDescarga     = descarga;
  state.operaciones      = 0;
  state.cargado          = true;
  state.ultimoColorState = 'ok';

  const descargas = Math.floor(capacidad / descarga);
  addLog(`Descarga configurada: ${capacidad.toFixed(2)} g — ${descargas} descargas de ${descarga.toFixed(2)} g`, 'ok');

  enviarWokwi({ action: 'config', capacity: capacidad, discharge: descarga });
  actualizarUI();
}

// ─── Descargar ───
function descargarPeso() {
  if (!state.cargado || state.pesoRestante <= 0) {
    addLog('No hay peso para descargar', 'warn');
    return;
  }

  const descarga = Math.min(state.pesoDescarga, state.pesoRestante);
  state.operaciones++;

  // El nuevo peso restante NO se calcula acá: llega desde MQTT y se aplica
  // en handleWokwiMessage(). Acá solo solicitamos la descarga.
  addLog(`Descarga #${state.operaciones} solicitada: -${descarga.toFixed(2)} g (esperando peso desde MQTT)`, '');

  enviarWokwi({ action: 'unload', weight: descarga });
  actualizarUI();
}

// ─── Reset ───
function resetBalanza() {
  state.capacidadTotal   = 0;
  state.lecturaOriginal  = 0;
  state.pesoRestante     = 0;
  state.pesoDescarga     = 0;
  state.operaciones      = 0;
  state.cargado          = false;
  state.recibioLectura   = false;
  state.ultimoColorState = 'idle';

  $descargaInput.value  = '';

  addLog('Balanza reseteada', 'warn');
  enviarWokwi({ action: 'reset' });
  actualizarUI();
}

// ─── Wokwi / WebSocket ───
function toggleConexion() {
  if (state.conectado) {
    desconectar();
  } else {
    conectar();
  }
}

function conectar() {

  try {
    state.mqttClient = mqtt.connect(MQTT_URL, {
      clientId: `balanza-web-${crypto.randomUUID()}`,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 3_000,
    });

    state.mqttClient.on('connect', () => {
      state.conectado = true;

      $connDot.classList.add('connected');
      $connText.textContent = 'Conectado a MQTT';
      $btnConn.textContent = '⚡ Desconectar MQTT';
      $btnConn.classList.add('active');

      state.mqttClient.subscribe(MQTT_TOPIC_STATUS, (error) => {
        if (error) {
          addLog('Error al suscribirse al topic de estado', 'error');
          return;
        }

        addLog(`Conectado a Mosquitto`, 'ok');
        addLog(`Escuchando ← ${MQTT_TOPIC_STATUS}`, 'ok');

        // Opcional: avisar al ESP32 que el panel web quedó disponible.
        enviarWokwi({
          action: 'web_connected',
          sentAt: new Date().toISOString(),
        });
      });
    });

    state.mqttClient.on('message', (topic, payload) => {
      const rawMessage = payload.toString();

      try {
        const data = JSON.parse(rawMessage);
        handleWokwiMessage(data);
      } catch {
        addLog(`Recibido ← ${topic}: ${rawMessage}`, '');
      }
    });

    state.mqttClient.on('error', (error) => {
      addLog(`Error MQTT: ${error.message}`, 'error');
    });

    state.mqttClient.on('close', () => {
      if (state.conectado) {
        desconectarUI();
        addLog('Conexión MQTT cerrada', 'warn');
      }
    });

    state.mqttClient.on('reconnect', () => {
      addLog('Intentando reconectar a Mosquitto...', 'warn');
    });

  } catch (error) {
    addLog(`No se pudo conectar: ${error.message}`, 'error');
  }

}

function desconectar() {
  if (state.mqttClient) {
    state.mqttClient.end(true);
  }

  desconectarUI();
  addLog('Desconectado de Mosquitto', 'warn');
}

function desconectarUI() {
  state.conectado = false;
  state.ws = null;
  $connDot.classList.remove('connected');
  $connText.textContent = 'Desconectado';
  $btnConn.textContent = '⚡ Conectar Wokwi';
  $btnConn.classList.remove('active');
}

function enviarWokwi(data) {
  if (!state.conectado || !state.mqttClient || !state.mqttClient.connected) {
    addLog(`No se pudo enviar → ${data.action} (sin conexión MQTT)`, 'warn');
    return;
  }

  const payload = JSON.stringify(data);
  state.mqttClient.publish(MQTT_TOPIC_COMMAND, payload, (error) => {
    if (error) {
      addLog(`Error al enviar → ${data.action}: ${error.message}`, 'error');
      return;
    }
    addLog(`Enviado → ${MQTT_TOPIC_COMMAND}: ${data.action}${data.weight !== undefined ? ' (' + data.weight + ' g)' : ''}`, '');
  });
}

function handleWokwiMessage(data) {
  if (data.type === 'weight' || data.weight !== undefined) {
    const w = data.value ?? data.weight;
    const nuevoPeso = parseFloat(w);
    if (isNaN(nuevoPeso)) return;

    // El peso restante es siempre el último valor que reporta MQTT.
    state.pesoRestante = Math.round(nuevoPeso * 100) / 100;

    // Primera lectura del firmware: el sistema pasa a ACTIVO y tomamos
    // ese peso como capacidad total de referencia.
    if (!state.recibioLectura) {
      state.recibioLectura = true;
      state.capacidadTotal = state.pesoRestante;
      addLog(`Primera lectura del firmware: ${state.pesoRestante.toFixed(2)} g — capacidad total establecida`, 'ok');
    }

    actualizarUI();
    notificarEstadoDescarga();
  }
  if (data.type === 'status') {
    addLog(`Estado Wokwi: ${data.message || JSON.stringify(data)}`, '');
  }
}

// Avisa en el log solo cuando cambia el estado (ok → bajo → vacío).
// El peso llega continuamente por MQTT, así evitamos llenar el registro.
function notificarEstadoDescarga() {
  if (!state.cargado) return;

  const colorState = getColorState();
  if (colorState === state.ultimoColorState) return;
  state.ultimoColorState = colorState;

  const descargasRest = state.pesoDescarga > 0
    ? Math.floor(state.pesoRestante / state.pesoDescarga)
    : 0;

  if (colorState === 'warning') {
    addLog(`⚠ Atención: quedan ${descargasRest} descarga(s) — ${state.pesoRestante.toFixed(2)} g`, 'warn');
  } else if (colorState === 'empty') {
    addLog('● Recipiente completamente vacío', 'error');
  } else if (colorState === 'ok') {
    addLog(`Peso restante: ${state.pesoRestante.toFixed(2)} g`, 'ok');
  }
}

// ─── Init ───
addLog('Aplicación iniciada', 'ok');
actualizarUI();
