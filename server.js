const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Agent registry
const AGENTS = {
  oryah: { name: 'Oryah', emoji: '🤖', host: '10.0.0.72', port: 18789, token: '130805ae118c37611ef01bdbaa05661475c306b7481b30e5', model: 'Claude Sonnet' },
  oryahclaude: { name: 'OryahClaude', emoji: '🔮', host: '10.0.0.76', port: 18789, token: '9df51168641494fc330d94c12d07d3474a3d6473a1540255', model: 'Claude Opus' },
  oryahopenai: { name: 'OryahOpenAI', emoji: '🧠', host: '10.0.0.74', port: 18789, token: '9df51168641494fc330d94c12d07d3474a3d6473a1540255', model: 'OpenAI' },
  alfred: { name: 'Alfred', emoji: '🎩', host: '10.0.0.75', port: 18789, token: 'c4d7e2a918f053b64729e1c8530da46f7b2913e5d08f4c62', model: 'GPT-4.5' },
  oryahmom: { name: 'OryahMom', emoji: '💜', host: '10.0.0.83', port: 18789, token: 'a8f3c92e174b6d05928e41c730f5a897b2641de8f094c371', model: 'Claude Sonnet' },
  oryahnoc: { name: 'OryahNOC', emoji: '📡', host: '10.0.0.90', port: 18789, token: '920427fc3eef33911a8f6f55caa565592e86f6443c0711ee', model: 'Claude Opus' },
};

// Persistent chat history
const HISTORY_FILE = '/opt/oryahchat/data/history.json';
let chatHistory = {};
try {
  if (fs.existsSync(HISTORY_FILE)) {
    chatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    console.log('Loaded chat history from disk');
  }
} catch (e) {
  console.error('Failed to load history:', e.message);
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory), 'utf8');
  } catch (e) {
    console.error('Failed to save history:', e.message);
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API: list agents
app.get('/api/agents', (req, res) => {
  const agents = Object.entries(AGENTS).map(([id, a]) => ({
    id, name: a.name, emoji: a.emoji, model: a.model
  }));
  res.json(agents);
});

// API: agent status (ping each agent's health endpoint)
app.get('/api/status', async (req, res) => {
  const results = {};
  const checks = Object.entries(AGENTS).map(([id, agent]) => {
    return new Promise((resolve) => {
      const options = {
        hostname: agent.host,
        port: agent.port,
        path: '/health',
        method: 'GET',
        timeout: 3000,
      };
      const req = http.request(options, (r) => {
        results[id] = r.statusCode < 500 ? 'online' : 'offline';
        r.resume();
        resolve();
      });
      req.on('error', () => { results[id] = 'offline'; resolve(); });
      req.on('timeout', () => { req.destroy(); results[id] = 'offline'; resolve(); });
      req.end();
    });
  });
  await Promise.all(checks);
  res.json(results);
});

// API: get chat history
app.get('/api/history/:agentId', (req, res) => {
  const key = req.params.agentId;
  res.json(chatHistory[key] || []);
});

// WebSocket handler
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'chat') {
        const agent = AGENTS[msg.agent];
        if (!agent) { ws.send(JSON.stringify({ type: 'error', error: 'Unknown agent' })); return; }

        // Store user message
        if (!chatHistory[msg.agent]) chatHistory[msg.agent] = [];
        chatHistory[msg.agent].push({ role: 'user', content: msg.content, ts: Date.now() });
        saveHistory();

        // Build messages array (last 20 for context)
        const messages = chatHistory[msg.agent]
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map(m => ({ role: m.role, content: m.content }));

        // Send to OpenClaw gateway with streaming
        const postData = JSON.stringify({
          model: 'openclaw',
          messages,
          stream: true,
          user: 'webchat-jason'
        });

        const options = {
          hostname: agent.host,
          port: agent.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${agent.token}`,
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 120000
        };

        // Send typing indicator
        ws.send(JSON.stringify({ type: 'typing', agent: msg.agent }));

        const req = http.request(options, (res) => {
          let fullContent = '';
          let buffer = '';

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') {
                chatHistory[msg.agent].push({ role: 'assistant', content: fullContent, ts: Date.now() });
                saveHistory();
                ws.send(JSON.stringify({ type: 'done', agent: msg.agent }));
                return;
              }
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  fullContent += delta;
                  ws.send(JSON.stringify({ type: 'chunk', agent: msg.agent, content: delta }));
                }
                const content = parsed.choices?.[0]?.message?.content;
                if (content) {
                  fullContent = content;
                  ws.send(JSON.stringify({ type: 'chunk', agent: msg.agent, content }));
                  chatHistory[msg.agent].push({ role: 'assistant', content: fullContent, ts: Date.now() });
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
                if (content && !fullContent) {
                  fullContent = content;
                  ws.send(JSON.stringify({ type: 'chunk', agent: msg.agent, content }));
                }
              } catch (e) {}
            }
            if (fullContent && !chatHistory[msg.agent].find(m => m.content === fullContent && m.role === 'assistant')) {
              chatHistory[msg.agent].push({ role: 'assistant', content: fullContent, ts: Date.now() });
              saveHistory();
            }
            ws.send(JSON.stringify({ type: 'done', agent: msg.agent }));
          });
        });

        req.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'error', agent: msg.agent, error: `Connection failed: ${err.message}` }));
        });

        req.on('timeout', () => {
          req.destroy();
          ws.send(JSON.stringify({ type: 'error', agent: msg.agent, error: 'Request timed out' }));
        });

        req.write(postData);
        req.end();
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`OryahChat running on port ${PORT}`);
});
