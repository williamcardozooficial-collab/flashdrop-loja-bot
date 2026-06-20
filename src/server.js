const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Content-Type, x-bot-secret'); res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(200); next(); });

app.use(express.static(path.join(__dirname, '../admin')));

const PORT = process.env.PORT || 3001;
const BOT_SECRET = process.env.BOT_SECRET || 'flashdrop-loja-bot-secret';

// Map de instÃ¢ncias: lojaId -> { client, status, qrCode, phone }
const instances = {};

// --- Auth middleware ---
function auth(req, res, next) {
  const secret = req.headers['x-bot-secret'] || req.query.secret;
  if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// --- Cria ou retorna instÃ¢ncia de uma loja ---
function getInstance(lojaId) {
  if (!instances[lojaId]) {
    instances[lojaId] = {
      client: null,
      status: 'disconnected',
      qrCode: null,
      phone: null
    };
  }
  return instances[lojaId];
}

// --- Inicia o client WhatsApp de uma loja ---
function startClient(lojaId) {
  const inst = getInstance(lojaId);

  if (inst.client) {
    try { inst.client.destroy(); } catch(e) {}
  }

  inst.status = 'loading';
  inst.qrCode = null;
  inst.phone = null;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `loja_${lojaId}` }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  client.on('qr', async (qr) => {
    inst.status = 'qr';
    inst.qrCode = await qrcode.toDataURL(qr);
    console.log(`[LOJA BOT] QR gerado para loja ${lojaId}`);
  });

  client.on('ready', () => {
    inst.status = 'connected';
    inst.qrCode = null;
    inst.phone = client.info?.wid?.user || null;
    console.log(`[LOJA BOT] Loja ${lojaId} conectada - ${inst.phone}`);
  });

  client.on('disconnected', (reason) => {
    inst.status = 'disconnected';
    inst.qrCode = null;
    inst.phone = null;
    inst.client = null;
    console.log(`[LOJA BOT] Loja ${lojaId} desconectada: ${reason}`);
  });

  client.initialize();
  inst.client = client;
}

// ============================
// ROTAS PÃBLICAS (sem auth)
// ============================

// Status de uma loja
app.get('/api/loja/:lojaId/status', (req, res) => {
  const { lojaId } = req.params;
  const inst = instances[lojaId];
  if (!inst) return res.json({ status: 'disconnected', phone: null, qrCode: null });
  res.json({ status: inst.status, phone: inst.phone, qrCode: inst.qrCode });
});

// Conectar loja (inicia o client e gera QR)
app.post('/api/loja/:lojaId/connect', (req, res) => {
  const { lojaId } = req.params;
  startClient(lojaId);
  res.json({ ok: true, message: 'Iniciando conexÃ£o...' });
});

// Desconectar loja
app.post('/api/loja/:lojaId/disconnect', async (req, res) => {
  const { lojaId } = req.params;
  const inst = instances[lojaId];
  if (inst && inst.client) {
    try { await inst.client.logout(); } catch(e) {}
    try { await inst.client.destroy(); } catch(e) {}
    instances[lojaId] = { client: null, status: 'disconnected', qrCode: null, phone: null };
  }
  res.json({ ok: true });
});

// ============================
// ROTAS INTERNAS (com auth)
// ============================

// Enviar mensagem para nÃºmero
app.post('/api/send-message', auth, async (req, res) => {
  const { lojaId, phone, message } = req.body;
  if (!lojaId || !phone || !message) return res.status(400).json({ error: 'lojaId, phone e message obrigatorios' });

  const inst = instances[lojaId];
  if (!inst || inst.status !== 'connected' || !inst.client) {
    return res.status(503).json({ error: 'Bot desta loja nao esta conectado' });
  }

  try {
    const numClean = phone.replace(/\D/g, '');
    const numId = await inst.client.getNumberId(numClean);
    if (numId == null) return res.status(404).json({ error: 'Numero nao encontrado no WhatsApp' });
    await inst.client.sendMessage(numId._serialized, message);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  const summary = Object.entries(instances).map(([id, inst]) => ({
    lojaId: id, status: inst.status, phone: inst.phone
  }));
  res.json({ ok: true, instances: summary.length, detail: summary });
});

app.listen(PORT, () => console.log(`[LOJA BOT] Servidor rodando na porta ${PORT}`));
