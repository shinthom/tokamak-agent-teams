/**
 * docker-manager.js — Docker 컨테이너 프로그래밍 관리
 *
 * dockerode를 사용하여 에이전트 컨테이너를 동적으로 생성/시작/중지.
 * v1에서는 호스트에서 직접 실행 (Docker-in-Docker 회피).
 */

const Docker = require('dockerode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT_IMAGE = 'tokamak-forge-agent';

// macOS Docker Desktop uses a different socket path
function findDockerSocket() {
  const candidates = [
    '/var/run/docker.sock',
    path.join(os.homedir(), '.docker/run/docker.sock'),
    path.join(os.homedir(), 'Library/Containers/com.docker.docker/Data/docker.raw.sock')
  ];
  for (const sock of candidates) {
    try {
      fs.accessSync(sock, fs.constants.R_OK | fs.constants.W_OK);
      return sock;
    } catch {}
  }
  return null;
}

class DockerManager {
  constructor(options = {}) {
    const socketPath = options.socketPath || findDockerSocket();
    this.docker = socketPath ? new Docker({ socketPath }) : new Docker();
    this.socketPath = socketPath;
    this.containers = new Map(); // agentId -> container
    this.logStreams = new Map(); // agentId -> stream
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..');
  }

  // Check Docker daemon connectivity
  async ping() {
    try {
      await this.docker.ping();
      return { ok: true, socketPath: this.socketPath };
    } catch (err) {
      return { ok: false, error: err.message, socketPath: this.socketPath };
    }
  }

  // Build agent image from docker/Dockerfile (skip if already exists)
  async buildAgentImage() {
    try {
      const image = await this.docker.getImage(AGENT_IMAGE).inspect();
      console.log(`[DockerManager] Image ${AGENT_IMAGE} already exists, skipping build`);
      return image;
    } catch {
      // Image doesn't exist, build it
    }

    console.log(`[DockerManager] Building image ${AGENT_IMAGE}...`);

    const dockerContext = path.join(this.projectRoot, 'docker');
    const stream = await this.docker.buildImage(
      { context: dockerContext, src: ['Dockerfile', 'agent-loop.sh'] },
      { t: AGENT_IMAGE }
    );

    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err, output) => {
        if (err) {
          console.error('[DockerManager] Build error:', err.message);
          reject(err);
        } else {
          console.log(`[DockerManager] Image ${AGENT_IMAGE} built successfully`);
          resolve(output);
        }
      });
    });
  }

  // Launch N agent containers
  async launchAgents(session) {
    const { gameName, agentCount, repoPath } = session;
    const launched = [];

    for (let i = 1; i <= agentCount; i++) {
      const agentId = String(i);
      const containerName = `tokamak-agent-${session.id}-${agentId}`;

      console.log(`[DockerManager] Creating container: ${containerName}`);

      const container = await this.docker.createContainer({
        Image: AGENT_IMAGE,
        name: containerName,
        Env: [
          `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`,
          `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || ''}`,
          `AGENT_ID=${agentId}`,
          `GAME_NAME=${gameName}`
        ],
        HostConfig: {
          Binds: [
            `${repoPath}:/repo:rw`
          ],
          RestartPolicy: { Name: 'unless-stopped' }
        }
      });

      await container.start();
      this.containers.set(agentId, container);
      launched.push({ agentId, containerId: container.id });

      console.log(`[DockerManager] Agent ${agentId} started: ${container.id.slice(0, 12)}`);
    }

    return launched;
  }

  // Stream logs from a container
  async streamLogs(agentId, callback) {
    const container = this.containers.get(agentId);
    if (!container) return;

    // Stop existing stream if any
    this.stopLogStream(agentId);

    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 50
    });

    this.logStreams.set(agentId, stream);

    stream.on('data', (chunk) => {
      // Docker log stream has 8-byte header prefix per frame
      const text = chunk.toString('utf-8');
      // Strip docker stream header bytes (first 8 bytes of each frame)
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        // Remove non-printable header bytes
        const clean = line.replace(/^[\x00-\x08]/g, '').replace(/[\x00-\x1f]/g, (c) => {
          return c === '\n' || c === '\t' ? c : '';
        });
        if (clean.trim()) {
          callback(agentId, clean.trim());
        }
      }
    });

    stream.on('end', () => {
      this.logStreams.delete(agentId);
    });
  }

  stopLogStream(agentId) {
    const stream = this.logStreams.get(agentId);
    if (stream) {
      stream.destroy();
      this.logStreams.delete(agentId);
    }
  }

  // Stop and remove all containers for a session
  async stopAll() {
    const promises = [];

    for (const [agentId, container] of this.containers) {
      console.log(`[DockerManager] Stopping agent ${agentId}...`);
      this.stopLogStream(agentId);

      promises.push(
        container.stop({ t: 5 })
          .then(() => container.remove({ force: true }))
          .catch(err => {
            console.error(`[DockerManager] Error stopping agent ${agentId}:`, err.message);
            // Try force remove even if stop fails
            return container.remove({ force: true }).catch(() => {});
          })
      );
    }

    await Promise.all(promises);
    this.containers.clear();
    this.logStreams.clear();
    console.log('[DockerManager] All containers stopped');
  }

  // Get container status for all agents
  async getStatus() {
    const statuses = {};
    for (const [agentId, container] of this.containers) {
      try {
        const info = await container.inspect();
        statuses[agentId] = {
          id: container.id.slice(0, 12),
          status: info.State.Status,
          running: info.State.Running
        };
      } catch {
        statuses[agentId] = { id: 'unknown', status: 'removed', running: false };
      }
    }
    return statuses;
  }
}

module.exports = { DockerManager };
