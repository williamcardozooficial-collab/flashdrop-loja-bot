const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Pasta onde a sessao do WhatsApp (LocalAuth) fica salva em disco. Por padrao
// fica dentro do proprio container (.wwebjs_auth), que e apagado toda vez que
// o Railway derruba/recria o container (por exemplo, ao "dormir" por
// inatividade para economizar - diferente da hibernacao interna do app, que
// so fecha o Chrome mas mantem o container e o disco vivos).
// Se WWEBJS_AUTH_PATH apontar para um Volume persistente do Railway montado
// nesse caminho, a sessao sobrevive ao container reiniciar e a loja acorda
// sozinha sem precisar escanear o QR de novo.
const WWEBJS_AUTH_PATH = process.env.WWEBJS_AUTH_PATH || path.join(process.cwd(), '.wwebjs_auth');
try { fs.mkdirSync(WWEBJS_AUTH_PATH, { recursive: true }); } catch (e) { console.error('[LOJA BOT] Erro ao preparar pasta de sessao:', e.message); }
console.log('[LOJA BOT] Sessao do WhatsApp salva em: ' + WWEBJS_AUTH_PATH + (process.env.WWEBJS_AUTH_PATH ? ' (via WWEBJS_AUTH_PATH)' : ' (padrao - NAO sobrevive a reinicio do container sem um Volume aqui)'));

const app = express();
app.use(express.json());

app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Content-Type, x-bot-secret'); res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(200); next(); });

app.use(express.static(path.join(__dirname, '../admin')));

const PORT = process.env.PORT || 3001;
const BOT_SECRET = process.env.BOT_SECRET || 'flashdrop-loja-bot-secret';

// Tempo de inatividade (sem enviar mensagem) apos o qual uma loja "hiberna":
// fecha o Chrome/Puppeteer daquela loja para liberar memoria, mas mantem a
// sessao do WhatsApp salva em disco (LocalAuth) para reconectar rapido depois,
// sem precisar escanear QR de novo.
const IDLE_TIMEOUT_MS = (parseInt(process.env.IDLE_TIMEOUT_MINUTES, 10) || 20) * 60 * 1000;
const HIBERNATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WAKE_TIMEOUT_MS = 45 * 1000;

// Map de instÃ¢ncias: lojaId -> { client, status, qrCode, phone, lastActivity }
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
      phone: null,
      lastActivity: 0,
      waiters: [],
      wakingPromise: null
    };
  }
  return instances[lojaId];
}

// Fecha o browser do Puppeteer de um client antigo com seguranca, sem travar
// o resto do fluxo caso algo de errado (client ja pode ter caido sozinho).
async function safeDestroy(client) {
  if (!client) return;
  try { await client.destroy(); } catch (e) { /* ja pode estar fechado */ }
}

// --- Inicia (ou reinicia) o client WhatsApp de uma loja ---
async function startClient(lojaId) {
  const inst = getInstance(lojaId);

  // Espera o client anterior (se houver) fechar de verdade antes de criar um
  // novo - sem isso o browser antigo pode ficar "orfao" rodando em segundo
  // plano, consumindo memoria pra sempre (era a causa do vazamento).
  const oldClient = inst.client;
  inst.client = null;
  await safeDestroy(oldClient);

  inst.status = 'loading';
  inst.qrCode = null;
  inst.phone = null;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `loja_${lojaId}`, dataPath: WWEBJS_AUTH_PATH }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking'
      ]
    }
  });

  // Guarda para os handlers abaixo: se enquanto isso ja rolou outro
  // startClient() pra essa mesma loja, esse client virou "velho" e nao deve
  // mais mexer no estado da instancia (evita condicao de corrida).
  const isCurrent = () => inst.client === client;

  client.on('qr', async (qr) => {
    if (!isCurrent()) return;
    inst.status = 'qr';
    inst.qrCode = await qrcode.toDataURL(qr);
    console.log(`[LOJA BOT] QR gerado para loja ${lojaId}`);
  });

  client.on('ready', () => {
    if (!isCurrent()) return;
    inst.status = 'connected';
    inst.qrCode = null;
    inst.phone = client.info?.wid?.user || null;
    inst.lastActivity = Date.now();
    console.log(`[LOJA BOT] Loja ${lojaId} conectada - ${inst.phone}`);
    const waiters = inst.waiters.splice(0, inst.waiters.length);
    waiters.forEach(w => w.resolve());
  });

  client.on('disconnected', async (reason) => {
    if (!isCurrent()) return;
    console.log(`[LOJA BOT] Loja ${lojaId} desconectada: ${reason}`);
    inst.status = 'disconnected';
    inst.qrCode = null;
    inst.phone = null;
    inst.client = null;
    const waiters = inst.waiters.splice(0, inst.waiters.length);
    waiters.forEach(w => w.reject(new Error('Loja desconectada: ' + reason)));
    // Fecha o browser desse client explicitamente: o evento 'disconnected'
    // por si so nao mata o processo do Chrome que ficaria orfao.
    await safeDestroy(client);
  });

  // client.initialize() retorna uma Promise. Sem tratar o erro dela, uma
  // falha ao abrir o Chrome de UMA loja (ex: sem memoria disponivel no
  // momento) derrubava o processo inteiro e desconectava TODAS as lojas de
  // uma vez - por isso o .catch abaixo.
  client.initialize().catch(e => {
    if (!isCurrent()) return;
    console.error(`[LOJA BOT] Erro ao inicializar loja ${lojaId}:`, e.message);
    inst.status = 'disconnected';
    inst.qrCode = null;
    inst.client = null;
    const waiters = inst.waiters.splice(0, inst.waiters.length);
    waiters.forEach(w => w.reject(e));
  });
  inst.client = client;
}

// Coloca a loja para "dormir": fecha o Chrome/Puppeteer (libera memoria) mas
// preserva a sessao salva em disco (LocalAuth), entao da pra acordar rapido
// e sem pedir QR de novo.
async function hibernateInstance(lojaId) {
  const inst = instances[lojaId];
  if (!inst || inst.status !== 'connected') return;
  console.log(`[LOJA BOT] Loja ${lojaId} hibernando por inatividade`);
  const client = inst.client;
  inst.client = null;
  inst.status = 'hibernated';
  inst.qrCode = null;
  await safeDestroy(client);
}

// Verifica periodicamente quais lojas estao conectadas mas ociosas ha muito
// tempo e hiberna elas para economizar memoria.
setInterval(() => {
  const now = Date.now();
  Object.keys(instances).forEach(lojaId => {
    const inst = instances[lojaId];
    if (inst.status === 'connected' && inst.lastActivity && (now - inst.lastActivity) > IDLE_TIMEOUT_MS) {
      hibernateInstance(lojaId).catch(e => console.error(`[LOJA BOT] Erro ao hibernar loja ${lojaId}:`, e.message));
    }
  });
}, HIBERNATE_CHECK_INTERVAL_MS);

// Garante que a loja esta acordada (conectada) antes de usar o client.
// Se estiver hibernada, reconecta usando a sessao ja salva em disco - nao
// deve pedir QR de novo. Se ja estiver conectada, so atualiza lastActivity.
async function ensureAwake(lojaId) {
  const inst = getInstance(lojaId);

  if (inst.status === 'connected' && inst.client) {
    inst.lastActivity = Date.now();
    return inst;
  }

  if (inst.status === 'hibernated') {
    // Se ja tem um "acordar" em andamento (ex: duas mensagens chegaram quase
    // juntas para a mesma loja), reaproveita a mesma promise em vez de
    // disparar dois startClient() concorrentes pra mesma loja.
    if (!inst.wakingPromise) {
      inst.wakingPromise = (async () => {
        console.log(`[LOJA BOT] Loja ${lojaId} acordando (estava hibernada)`);
        const waitPromise = new Promise((resolve, reject) => {
          inst.waiters.push({ resolve, reject });
        });
        await startClient(lojaId);
        await Promise.race([
          waitPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout acordando a loja')), WAKE_TIMEOUT_MS))
        ]);
      })().finally(() => { inst.wakingPromise = null; });
    }
    await inst.wakingPromise;
    inst.lastActivity = Date.now();
    return inst;
  }

  return inst;
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
  startClient(lojaId).catch(e => console.error(`[LOJA BOT] Erro ao conectar loja ${lojaId}:`, e.message));
  res.json({ ok: true, message: 'Iniciando conexÃ£o...' });
});

// Desconectar loja
app.post('/api/loja/:lojaId/disconnect', async (req, res) => {
  const { lojaId } = req.params;
  const inst = instances[lojaId];
  if (inst && inst.client) {
    try { await inst.client.logout(); } catch(e) {}
    try { await inst.client.destroy(); } catch(e) {}
  }
  instances[lojaId] = { client: null, status: 'disconnected', qrCode: null, phone: null, lastActivity: 0, waiters: [], wakingPromise: null };
  res.json({ ok: true });
});

// ============================
// ROTAS INTERNAS (com auth)
// ============================

// Enviar mensagem para nÃºmero
app.post('/api/send-message', auth, async (req, res) => {
  const { lojaId, phone, message } = req.body;
  if (!lojaId || !phone || !message) return res.status(400).json({ error: 'lojaId, phone e message obrigatorios' });

  let inst = instances[lojaId];
  if (!inst || (inst.status !== 'connected' && inst.status !== 'hibernated')) {
    return res.status(503).json({ error: 'Bot desta loja nao esta conectado' });
  }

  try {
    inst = await ensureAwake(lojaId);
  } catch (e) {
    console.error(`[LOJA BOT] Erro ao acordar loja ${lojaId}:`, e.message);
    return res.status(503).json({ error: 'Nao foi possivel reconectar o bot desta loja' });
  }

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
