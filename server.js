const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ══════════════════════════════════════════════════════════
// Auth Configuration
// ══════════════════════════════════════════════════════════

const USERS_FILE = '/opt/oryahchat/data/users.json';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || '72');
const SETUP_PASSWORD = process.env.SETUP_PASSWORD || '';

let users = {};
try {
  if (fs.existsSync(USERS_FILE)) {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(users).length} user(s)`);
  }
} catch (e) {
  console.error('Failed to load users:', e.message);
}

if (Object.keys(users).length === 0 && SETUP_PASSWORD) {
  users.admin = { hash: hashPassword(SETUP_PASSWORD), role: 'admin', created: Date.now() };
  saveUsers();
  console.log('Created initial admin user');
}

function hashPassword(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function saveUsers() {
  try {
    const dir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) { console.error('Failed to save users:', e.message); }
}

function createToken(username) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: username, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (SESSION_HOURS * 3600)
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    if (signature !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function parseCookies(h) {
  const c = {};
  if (!h) return c;
  h.split(';').forEach(s => { const [k, ...v] = s.trim().split('='); if (k) c[k.trim()] = v.join('=').trim(); });
  return c;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.oryahchat_token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired session' });
  req.user = payload.sub;
  next();
}

function wsAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.oryahchat_token;
  if (!token) return null;
  const payload = verifyToken(token);
  return payload ? payload.sub : null;
}

// ══════════════════════════════════════════════════════════
// Agent Registry + Live Status
// ══════════════════════════════════════════════════════════

const AGENTS = {
  oryah:       { name: 'Oryah',       emoji: '🤖', host: '10.0.0.72', port: 18789, token: '130805ae118c37611ef01bdbaa05661475c306b7481b30e5', model: 'Claude Sonnet' },
  oryahclaude: { name: 'OryahClaude', emoji: '🔮', host: '10.0.0.76', port: 18789, token: '9df51168641494fc330d94c12d07d3474a3d6473a1540255', model: 'Claude Opus' },
  oryahopenai: { name: 'OryahOpenAI', emoji: '🧠', host: '10.0.0.74', port: 18789, token: '9df51168641494fc330d94c12d07d3474a3d6473a1540255', model: 'OpenAI' },
  alfred:      { name: 'Alfred',      emoji: '🎩', host: '10.0.0.75', port: 18789, token: 'c4d7e2a918f053b64729e1c8530da46f7b2913e5d08f4c62', model: 'GPT-4.5' },
  oryahmom:    { name: 'OryahMom',    emoji: '💜', host: '10.0.0.83', port: 18789, token: 'a8f3c92e174b6d05928e41c730f5a897b2641de8f094c371', model: 'Claude Sonnet' },
  oryahnoc:    { name: 'OryahNOC',    emoji: '📡', host: '10.0.0.90', port: 18789, token: '920427fc3eef33911a8f6f55caa565592e86f6443c0711ee', model: 'Claude Opus' },
};

// Live agent activity tracking
const agentActivity = {};
for (const id of Object.keys(AGENTS)) {
  agentActivity[id] = {
    status: 'unknown',    // online, offline, unknown
    activity: 'idle',     // idle, thinking, responding, error
    lastSeen: null,
    lastMessage: null,
    lastError: null,
    currentUser: null,    // who is chatting with this agent right now
    responseStart: null,  // when the current response started
    tokensGenerated: 0,   // tokens in current response
    totalMessages: 0,
    totalTokens: 0,
    upSince: null,
  };
}

// Status polling (every 15s)
async function pollAgentStatus() {
  const checks = Object.entries(AGENTS).map(([id, agent]) => {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const options = {
        hostname: agent.host, port: agent.port, path: '/health',
        method: 'GET', timeout: 3000,
      };
      const req = http.request(options, (r) => {
        const wasOffline = agentActivity[id].status === 'offline';
        agentActivity[id].status = r.statusCode < 500 ? 'online' : 'offline';
        agentActivity[id].lastSeen = Date.now();
        agentActivity[id].latencyMs = Date.now() - t0;
        if (wasOffline && agentActivity[id].status === 'online') {
          agentActivity[id].upSince = Date.now();
        }
        r.resume();
        resolve();
      });
      req.on('error', () => { agentActivity[id].status = 'offline'; resolve(); });
      req.on('timeout', () => { req.destroy(); agentActivity[id].status = 'offline'; resolve(); });
      req.end();
    });
  });
  await Promise.all(checks);
  broadcastActivity();
}

setInterval(pollAgentStatus, 15000);
pollAgentStatus();

// Broadcast activity to all connected WS clients
function broadcastActivity() {
  const payload = JSON.stringify({ type: 'activity', data: getActivitySummary() });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && ws.authenticated) {
      ws.send(payload);
    }
  });
}

function getActivitySummary() {
  const summary = {};
  for (const [id, act] of Object.entries(agentActivity)) {
    summary[id] = {
      status: act.status,
      activity: act.activity,
      lastSeen: act.lastSeen,
      latencyMs: act.latencyMs || 0,
      currentUser: act.currentUser,
      responseStart: act.responseStart,
      tokensGenerated: act.tokensGenerated,
      totalMessages: act.totalMessages,
      totalTokens: act.totalTokens,
      lastError: act.lastError,
      upSince: act.upSince,
    };
  }
  return summary;
}

// ══════════════════════════════════════════════════════════
// Slash Commands
// ══════════════════════════════════════════════════════════

const SLASH_COMMANDS = {
  '/help': { desc: 'Show available commands', handler: cmdHelp },
  '/status': { desc: 'Show agent status dashboard', handler: cmdStatus },
  '/clear': { desc: 'Clear chat history for current agent', handler: cmdClear },
  '/reset': { desc: 'Reset conversation (clear + fresh start)', handler: cmdReset },
  '/model': { desc: 'Show current agent model info', handler: cmdModel },
  '/ping': { desc: 'Ping the current agent', handler: cmdPing },
  '/users': { desc: 'List users (admin only)', handler: cmdUsers },
  '/uptime': { desc: 'Show agent uptime', handler: cmdUptime },
  '/history': { desc: 'Show message count per agent', handler: cmdHistory },
  '/export': { desc: 'Export chat history as JSON', handler: cmdExport },
};

function cmdHelp(agentId, args, username) {
  let text = '**Available Commands:**\n\n';
  for (const [cmd, info] of Object.entries(SLASH_COMMANDS)) {
    text += `\`${cmd}\` — ${info.desc}\n`;
  }
  text += '\nCommands are handled locally by OryahChat. Regular messages go to the agent.';
  return { type: 'system', content: text };
}

function cmdStatus(agentId, args, username) {
  let text = '**Agent Status Dashboard:**\n\n';
  for (const [id, agent] of Object.entries(AGENTS)) {
    const act = agentActivity[id];
    const statusIcon = act.status === 'online' ? '🟢' : '🔴';
    const activityIcon = { idle: '💤', thinking: '🤔', responding: '✍️', error: '❌' }[act.activity] || '❓';
    const latency = act.latencyMs ? `${act.latencyMs}ms` : '—';
    const lastSeen = act.lastSeen ? timeSince(act.lastSeen) : 'never';
    text += `${statusIcon} **${agent.name}** ${activityIcon} | ${latency} | seen ${lastSeen}\n`;
    if (act.currentUser) text += `   └ chatting with ${act.currentUser}\n`;
    if (act.lastError) text += `   └ ⚠️ ${act.lastError}\n`;
  }
  return { type: 'system', content: text };
}

function cmdClear(agentId, args, username) {
  if (agentId && chatHistory[agentId]) {
    chatHistory[agentId] = [];
    saveHistory();
    return { type: 'system', content: `Chat history cleared for ${AGENTS[agentId]?.name || agentId}.` };
  }
  return { type: 'system', content: 'Select an agent first.' };
}

function cmdReset(agentId, args, username) {
  if (agentId && chatHistory[agentId]) {
    chatHistory[agentId] = [];
    saveHistory();
    return { type: 'system', content: `Conversation reset for ${AGENTS[agentId]?.name || agentId}. Fresh start!` };
  }
  return { type: 'system', content: 'Select an agent first.' };
}

function cmdModel(agentId, args, username) {
  if (!agentId || !AGENTS[agentId]) return { type: 'system', content: 'Select an agent first.' };
  const agent = AGENTS[agentId];
  return { type: 'system', content: `**${agent.name}** runs on **${agent.model}**\nEndpoint: \`${agent.host}:${agent.port}\`` };
}

function cmdPing(agentId, args, username) {
  if (!agentId || !AGENTS[agentId]) return { type: 'system', content: 'Select an agent first.' };
  const act = agentActivity[agentId];
  const latency = act.latencyMs ? `${act.latencyMs}ms` : 'unknown';
  return { type: 'system', content: `**${AGENTS[agentId].name}** — ${act.status === 'online' ? '🟢 Online' : '🔴 Offline'} | Latency: ${latency}` };
}

function cmdUsers(agentId, args, username) {
  const user = users[username];
  if (!user || user.role !== 'admin') return { type: 'system', content: '⛔ Admin only.' };
  let text = '**Users:**\n\n';
  for (const [name, info] of Object.entries(users)) {
    text += `• **${name}** (${info.role}) — created ${new Date(info.created).toLocaleDateString()}\n`;
  }
  return { type: 'system', content: text };
}

function cmdUptime(agentId, args, username) {
  let text = '**Agent Uptime:**\n\n';
  for (const [id, agent] of Object.entries(AGENTS)) {
    const act = agentActivity[id];
    const uptime = act.upSince ? timeSince(act.upSince) : (act.status === 'online' ? 'unknown' : 'offline');
    text += `${act.status === 'online' ? '🟢' : '🔴'} **${agent.name}** — up ${uptime}\n`;
  }
  return { type: 'system', content: text };
}

function cmdHistory(agentId, args, username) {
  let text = '**Message History:**\n\n';
  for (const [id, agent] of Object.entries(AGENTS)) {
    const count = (chatHistory[id] || []).length;
    text += `${agent.emoji} **${agent.name}** — ${count} messages\n`;
  }
  return { type: 'system', content: text };
}

function cmdExport(agentId, args, username) {
  if (!agentId) return { type: 'system', content: 'Select an agent first.' };
  const history = chatHistory[agentId] || [];
  return { type: 'system', content: `Exported ${history.length} messages for ${AGENTS[agentId]?.name}.\n\n\`\`\`json\n${JSON.stringify(history.slice(-20), null, 2)}\n\`\`\`` };
}

function timeSince(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function isSlashCommand(text) {
  return text.trim().startsWith('/') && SLASH_COMMANDS[text.trim().split(/\s/)[0].toLowerCase()];
}

function handleSlashCommand(text, agentId, username) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  const handler = SLASH_COMMANDS[cmd];
  if (!handler) return null;
  return handler.handler(agentId, args, username);
}

// ══════════════════════════════════════════════════════════
// Chat History
// ══════════════════════════════════════════════════════════

const HISTORY_FILE = '/opt/oryahchat/data/history.json';
let chatHistory = {};
try {
  if (fs.existsSync(HISTORY_FILE)) {
    chatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    console.log('Loaded chat history from disk');
  }
} catch (e) { console.error('Failed to load history:', e.message); }

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory), 'utf8'); }
  catch (e) { console.error('Failed to save history:', e.message); }
}

// ══════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════

app.use(express.json());

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = users[username.toLowerCase()];
  if (!user || user.hash !== hashPassword(password)) {
    console.log(`Failed login: ${username} from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = createToken(username.toLowerCase());
  res.cookie('oryahchat_token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: SESSION_HOURS * 3600 * 1000 });
  console.log(`Login: ${username} from ${req.ip}`);
  res.json({ success: true, user: username.toLowerCase() });
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('oryahchat_token'); res.json({ success: true }); });

app.get('/api/auth/check', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.oryahchat_token;
  if (!token) return res.json({ authenticated: false });
  const payload = verifyToken(token);
  if (!payload) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: payload.sub });
});

app.post('/api/auth/users', requireAuth, (req, res) => {
  const admin = users[req.user];
  if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  users[username.toLowerCase()] = { hash: hashPassword(password), role: 'user', created: Date.now() };
  saveUsers();
  res.json({ success: true, user: username.toLowerCase() });
});

app.get('/api/auth/users', requireAuth, (req, res) => {
  if (!users[req.user] || users[req.user].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  res.json(Object.entries(users).map(([k, v]) => ({ username: k, role: v.role, created: v.created })));
});

app.delete('/api/auth/users/:username', requireAuth, (req, res) => {
  if (!users[req.user] || users[req.user].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const key = req.params.username.toLowerCase();
  if (key === req.user) return res.status(400).json({ error: "Can't delete yourself" });
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  delete users[key];
  saveUsers();
  res.json({ success: true });
});

app.get('/', (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.oryahchat_token;
  if (!token || !verifyToken(token)) return res.redirect('/login');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/agents', requireAuth, (req, res) => {
  res.json(Object.entries(AGENTS).map(([id, a]) => ({ id, name: a.name, emoji: a.emoji, model: a.model })));
});

app.get('/api/status', requireAuth, async (req, res) => {
  const results = {};
  const checks = Object.entries(AGENTS).map(([id, agent]) => {
    return new Promise((resolve) => {
      const opts = { hostname: agent.host, port: agent.port, path: '/health', method: 'GET', timeout: 3000 };
      const req = http.request(opts, (r) => { results[id] = r.statusCode < 500 ? 'online' : 'offline'; r.resume(); resolve(); });
      req.on('error', () => { results[id] = 'offline'; resolve(); });
      req.on('timeout', () => { req.destroy(); results[id] = 'offline'; resolve(); });
      req.end();
    });
  });
  await Promise.all(checks);
  res.json(results);
});

app.get('/api/activity', requireAuth, (req, res) => {
  res.json(getActivitySummary());
});

app.get('/api/commands', requireAuth, (req, res) => {
  res.json(Object.entries(SLASH_COMMANDS).map(([cmd, info]) => ({ command: cmd, description: info.desc })));
});

app.get('/api/history/:agentId', requireAuth, (req, res) => {
  res.json(chatHistory[req.params.agentId] || []);
});

// ══════════════════════════════════════════════════════════
// WebSocket
// ══════════════════════════════════════════════════════════

wss.on('connection', (ws, req) => {
  const username = wsAuth(req);
  if (!username) {
    ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
    ws.close(4001, 'Not authenticated');
    return;
  }
  ws.authenticated = true;
  ws.username = username;
  console.log(`WS connected: ${username}`);

  // Send current activity state
  ws.send(JSON.stringify({ type: 'activity', data: getActivitySummary() }));
  // Send available commands
  ws.send(JSON.stringify({ type: 'commands', data: Object.entries(SLASH_COMMANDS).map(([cmd, info]) => ({ command: cmd, description: info.desc })) }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'chat') {
        const agent = AGENTS[msg.agent];
        if (!agent) { ws.send(JSON.stringify({ type: 'error', error: 'Unknown agent' })); return; }

        // ── Slash command check ──
        if (isSlashCommand(msg.content)) {
          const result = handleSlashCommand(msg.content, msg.agent, username);
          if (result) {
            // Show the command in chat
            if (!chatHistory[msg.agent]) chatHistory[msg.agent] = [];
            chatHistory[msg.agent].push({ role: 'user', content: msg.content, ts: Date.now(), user: username });
            chatHistory[msg.agent].push({ role: 'system', content: result.content, ts: Date.now() });
            saveHistory();
            ws.send(JSON.stringify({ type: 'command_result', agent: msg.agent, content: result.content }));
            return;
          }
        }

        // ── Regular chat message ──
        if (!chatHistory[msg.agent]) chatHistory[msg.agent] = [];
        chatHistory[msg.agent].push({ role: 'user', content: msg.content, ts: Date.now(), user: username });
        saveHistory();

        // Update activity: thinking
        agentActivity[msg.agent].activity = 'thinking';
        agentActivity[msg.agent].currentUser = username;
        agentActivity[msg.agent].responseStart = Date.now();
        agentActivity[msg.agent].tokensGenerated = 0;
        broadcastActivity();

        const messages = chatHistory[msg.agent]
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map(m => ({ role: m.role, content: m.content }));

        const postData = JSON.stringify({ model: 'openclaw', messages, stream: true, user: `webchat-${username}` });
        const options = {
          hostname: agent.host, port: agent.port, path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent.token}`, 'Content-Length': Buffer.byteLength(postData) },
          timeout: 120000
        };

        ws.send(JSON.stringify({ type: 'typing', agent: msg.agent }));

        const httpReq = http.request(options, (res) => {
          let fullContent = '';
          let buffer = '';
          let firstChunk = true;

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') {
                chatHistory[msg.agent].push({ role: 'assistant', content: fullContent, ts: Date.now() });
                agentActivity[msg.agent].totalMessages++;
                agentActivity[msg.agent].totalTokens += agentActivity[msg.agent].tokensGenerated;
                agentActivity[msg.agent].activity = 'idle';
                agentActivity[msg.agent].currentUser = null;
                agentActivity[msg.agent].lastMessage = Date.now();
                broadcastActivity();
                saveHistory();
                ws.send(JSON.stringify({ type: 'done', agent: msg.agent }));
                return;
              }
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  if (firstChunk) {
                    agentActivity[msg.agent].activity = 'responding';
                    broadcastActivity();
                    firstChunk = false;
                  }
                  fullContent += delta;
                  agentActivity[msg.agent].tokensGenerated++;
                  ws.send(JSON.stringify({ type: 'chunk', agent: msg.agent, content: delta }));
                }
                const content = parsed.choices?.[0]?.message?.content;
                if (content) {
                  fullContent = content;
                  ws.send(JSON.stringify({ type: 'chunk', agent: msg.agent, content }));
                  chatHistory[msg.agent].push({ role: 'assistant', content: fullContent, ts: Date.now() });
                  agentActivity[msg.agent].activity = 'idle';
                  agentActivity[msg.agent].currentUser = null;
                  agentActivity[msg.agent].totalMessages++;
                  broadcastActivity();
                  saveHistory();
                  ws.send(JSON.stringify({ type: 'done', agent: msg.agent }));
                }
              } catch (e) {}
            }
          });

          res.on('end', () => {
            if (buffer.trim()) {
              try {
                const parsed = JSON.parse(buffer.trim());
                const content = parsed.choices?.[0]?.message?.content;
                if (content && !fullContent) { fullContent = content; ws.send(JSON.stringify({ type: 'chunk', agent: msg.agent, content })); }
              } catch (e) {}
            }
            if (fullContent && !chatHistory[msg.agent].find(m => m.content === fullContent && m.role === 'assistant')) {
              chatHistory[msg.agent].push({ role: 'assistant', content: fullContent, ts: Date.now() });
              saveHistory();
            }
            agentActivity[msg.agent].activity = 'idle';
            agentActivity[msg.agent].currentUser = null;
            broadcastActivity();
            ws.send(JSON.stringify({ type: 'done', agent: msg.agent }));
          });
        });

        httpReq.on('error', (err) => {
          agentActivity[msg.agent].activity = 'error';
          agentActivity[msg.agent].lastError = err.message;
          agentActivity[msg.agent].currentUser = null;
          broadcastActivity();
          ws.send(JSON.stringify({ type: 'error', agent: msg.agent, error: `Connection failed: ${err.message}` }));
        });

        httpReq.on('timeout', () => {
          httpReq.destroy();
          agentActivity[msg.agent].activity = 'error';
          agentActivity[msg.agent].lastError = 'Request timed out';
          agentActivity[msg.agent].currentUser = null;
          broadcastActivity();
          ws.send(JSON.stringify({ type: 'error', agent: msg.agent, error: 'Request timed out' }));
        });

        httpReq.write(postData);
        httpReq.end();
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`OryahChat running on port ${PORT}`);
  if (Object.keys(users).length === 0) console.log('⚠️  No users! Set SETUP_PASSWORD and restart.');
});
