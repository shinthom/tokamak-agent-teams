/**
 * server.js — Dashboard WebSocket server
 *
 * HTTP + WebSocket 기반 실시간 대시보드 서버.
 * REST API로 forge 세션을 관리하고, WebSocket으로 진행 상태를 push.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const { RepoWatcher } = require('./watcher');
const { SessionManager, STATUS } = require('./session');
const { ForgeProcess } = require('./forge');
const { DockerManager } = require('./docker-manager');

// Load .env file if present
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = path.resolve(__dirname, '..');

const sessionManager = new SessionManager();
const dockerManager = new DockerManager({ projectRoot: PROJECT_ROOT });
let watcher = null;

// Serve static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

// JSON body parser (express 없이 직접 구현)
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// LLM API call (OpenAI-compatible endpoint)
function callLLM(messages, model) {
  return new Promise((resolve, reject) => {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const url = new URL('/v1/chat/completions', baseUrl);
    const payload = JSON.stringify({
      model: model || 'claude-haiku-4.5',
      messages,
      max_tokens: 512
    });
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const content = data.choices?.[0]?.message?.content || '';
          resolve(content);
        } catch (e) {
          reject(new Error('Failed to parse LLM response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('LLM request timeout')); });
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // --- REST API endpoints ---

    // GET /api/state — 기존 watcher 상태
    if (req.url === '/api/state' && req.method === 'GET') {
      const state = watcher ? watcher.getState() : {};
      sendJSON(res, 200, state);
      return;
    }

    // GET /api/logs — 기존 로그 조회
    if (req.url === '/api/logs' && req.method === 'GET') {
      const session = sessionManager.getActive();
      if (!session || !session.workDir) {
        sendJSON(res, 200, {});
        return;
      }
      const logsDir = path.join(session.workDir, 'logs');
      try {
        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
        const logs = {};
        files.forEach(f => {
          const content = fs.readFileSync(path.join(logsDir, f), 'utf-8');
          const lines = content.split('\n');
          logs[f] = lines.slice(-50);
        });
        sendJSON(res, 200, logs);
      } catch {
        sendJSON(res, 200, {});
      }
      return;
    }

    // GET /api/session — 현재 활성 세션 정보
    if (req.url === '/api/session' && req.method === 'GET') {
      const session = sessionManager.getActive();
      sendJSON(res, 200, { session: session ? session.toJSON() : null });
      return;
    }

    // POST /api/validate-game — 게임 이름 검증 (모호하면 설명 요청)
    if (req.url === '/api/validate-game' && req.method === 'POST') {
      const body = await parseBody(req);
      const { gameName } = body;

      if (!gameName) {
        sendJSON(res, 400, { error: 'gameName is required' });
        return;
      }

      try {
        const prompt = `The user wants to create a game called "${gameName}".

Determine if this is a well-known, unambiguous game that can be implemented as a browser HTML5 Canvas game.

Reply with ONLY a JSON object (no markdown, no code fences):
{
  "known": true or false,
  "question": "If not known or ambiguous, write a short question in Korean asking the user to describe the game. If known, set to null."
}

Examples:
- "tetris" → {"known": true, "question": null}
- "snake" → {"known": true, "question": null}
- "zxcv" → {"known": false, "question": "'zxcv'가 어떤 게임인지 설명해 주세요. 어떤 규칙과 조작 방식의 게임인가요?"}
- "war" → {"known": false, "question": "'war'는 여러 종류의 게임이 있습니다. 어떤 종류의 war 게임을 원하시나요? (카드 게임, 전략 게임 등)"}`;

        const response = await callLLM([{ role: 'user', content: prompt }]);

        // Parse JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          sendJSON(res, 200, result);
        } else {
          // Fallback: treat as known
          sendJSON(res, 200, { known: true, question: null });
        }
      } catch (err) {
        console.error('[Validate] Error:', err.message);
        // On error, skip validation and proceed
        sendJSON(res, 200, { known: true, question: null });
      }
      return;
    }

    // POST /api/forge — 세션 생성, forge 실행
    if (req.url === '/api/forge' && req.method === 'POST') {
      const body = await parseBody(req);
      const { gameName, agentCount = 3, gameDescription = '' } = body;

      if (!gameName || typeof gameName !== 'string') {
        sendJSON(res, 400, { error: 'gameName is required' });
        return;
      }

      // Validate gameName: only alphanumeric, hyphens, underscores
      if (!/^[a-zA-Z0-9_-]+$/.test(gameName)) {
        sendJSON(res, 400, { error: 'gameName must be alphanumeric (hyphens and underscores allowed)' });
        return;
      }

      const count = Math.min(Math.max(parseInt(agentCount, 10) || 3, 1), 5);

      try {
        const session = sessionManager.create(gameName, count);
        session.gameDescription = gameDescription;
        sendJSON(res, 200, { session: session.toJSON() });

        // Start forge process asynchronously
        runForge(session);
      } catch (err) {
        sendJSON(res, 409, { error: err.message });
      }
      return;
    }

    // POST /api/session/stop — 에이전트 중지
    if (req.url === '/api/session/stop' && req.method === 'POST') {
      const session = sessionManager.getActive();
      if (!session) {
        sendJSON(res, 404, { error: 'No active session' });
        return;
      }

      try {
        await dockerManager.stopAll();
        if (watcher) {
          watcher.stop();
          watcher = null;
        }
        sessionManager.stop(session.id);
        broadcast({ type: 'session:stopped' });
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // --- Static file serving ---
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  } catch (err) {
    console.error('[Server] Request error:', err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[Dashboard] Client connected');

  const session = sessionManager.getActive();
  ws.send(JSON.stringify({
    type: 'init',
    gameName: session ? session.gameName : null,
    session: session ? session.toJSON() : null,
    state: watcher ? watcher.getState() : null
  }));

  ws.on('close', () => {
    console.log('[Dashboard] Client disconnected');
  });
});

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Forge process runner
async function runForge(session) {
  const forge = new ForgeProcess(session.gameName, session.agentCount, {
    projectRoot: PROJECT_ROOT,
    gameDescription: session.gameDescription || '',
    dockerManager,
    onProgress: (progress) => {
      // Update session state
      if (progress.type === 'step') {
        session.setForgeStep(progress.step);
        if (progress.step <= 2) session.setStatus(STATUS.SCAFFOLDING);
        else if (progress.step === 3) session.setStatus(STATUS.GENERATING_SPEC);
        else if (progress.step >= 4) session.setStatus(STATUS.LAUNCHING_AGENTS);
      }

      if (progress.type === 'log') {
        session.addLog(progress.message);
      }

      // Broadcast to WebSocket clients
      broadcast({
        type: progress.type === 'complete' ? 'forge:complete'
          : progress.type === 'error' ? 'forge:error'
          : 'forge:progress',
        data: progress,
        session: session.toJSON(),
        timestamp: Date.now()
      });
    }
  });

  try {
    const result = await forge.run();

    // Update session with paths
    session.repoPath = result.repoPath;
    session.workDir = result.workDir;

    // Start watcher on the working copy
    if (watcher) watcher.stop();
    watcher = new RepoWatcher(result.workDir);
    watcher.onChange((event, data) => {
      broadcast({ type: event, data, timestamp: Date.now() });
    });
    watcher.start();

    // Build agent image and launch containers
    session.setStatus(STATUS.LAUNCHING_AGENTS);
    session.setForgeStep(6);
    broadcast({
      type: 'forge:progress',
      data: { type: 'step', step: 6, message: 'Launching agents' },
      session: session.toJSON(),
      timestamp: Date.now()
    });

    const logForge = (msg) => {
      session.addLog(msg);
      broadcast({
        type: 'forge:progress',
        data: { type: 'log', message: msg },
        session: session.toJSON(),
        timestamp: Date.now()
      });
    };

    logForge('Building agent Docker image (tokamak-forge-agent)...');
    await dockerManager.buildAgentImage();
    logForge('Agent Docker image ready');

    logForge(`Launching ${session.agentCount} agent containers...`);
    const agents = await dockerManager.launchAgents(session);

    for (const agent of agents) {
      logForge(`  Agent ${agent.agentId}: container ${agent.containerId.slice(0, 12)} started`);
    }

    session.containerIds = agents.map(a => a.containerId);
    session.setStatus(STATUS.RUNNING);
    logForge('All agents running!');

    broadcast({
      type: 'forge:complete',
      data: { agents },
      session: session.toJSON(),
      timestamp: Date.now()
    });

    // Stream logs from each agent container
    for (const agent of agents) {
      dockerManager.streamLogs(agent.agentId, (agentId, line) => {
        broadcast({
          type: 'agent:log',
          data: { agentId, line },
          timestamp: Date.now()
        });
      });
    }

    console.log(`[Forge] Session ${session.id} fully running with ${agents.length} agents`);

  } catch (err) {
    console.error('[Forge] Error:', err);
    // Stop watcher if it was started
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    session.setStatus(STATUS.STOPPED);
    broadcast({
      type: 'forge:error',
      data: { message: err.message },
      session: session.toJSON(),
      timestamp: Date.now()
    });
  }
}

// Start server
server.listen(PORT, () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
  console.log(`[Dashboard] Project root: ${PROJECT_ROOT}`);
});
