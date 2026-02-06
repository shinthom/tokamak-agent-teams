/**
 * session.js — 세션 상태 관리
 *
 * Session 클래스와 SessionManager로 forge 세션 라이프사이클을 관리.
 * v1에서는 단일 세션만 허용.
 */

const crypto = require('crypto');

const STATUS = {
  INITIALIZING: 'initializing',
  SCAFFOLDING: 'scaffolding',
  GENERATING_SPEC: 'generating-spec',
  LAUNCHING_AGENTS: 'launching-agents',
  RUNNING: 'running',
  STOPPED: 'stopped'
};

class Session {
  constructor(gameName, agentCount) {
    this.id = crypto.randomBytes(4).toString('hex');
    this.gameName = gameName;
    this.agentCount = agentCount;
    this.status = STATUS.INITIALIZING;
    this.repoPath = null;
    this.workDir = null;
    this.logs = [];
    this.forgeStep = 0;
    this.forgeSteps = [
      'Checking prerequisites',
      'Creating bare repository',
      'Scaffolding project',
      'Generating SPEC.md',
      'Setting up tests',
      'Initial commit & push',
      'Launching agents'
    ];
    this.containerIds = [];
    this.createdAt = Date.now();
  }

  setStatus(status) {
    this.status = status;
  }

  setForgeStep(step) {
    this.forgeStep = step;
  }

  addLog(message) {
    const entry = { time: Date.now(), message };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    return entry;
  }

  toJSON() {
    return {
      id: this.id,
      gameName: this.gameName,
      agentCount: this.agentCount,
      status: this.status,
      repoPath: this.repoPath,
      workDir: this.workDir,
      forgeStep: this.forgeStep,
      forgeSteps: this.forgeSteps,
      containerIds: this.containerIds,
      createdAt: this.createdAt,
      logs: this.logs.slice(-50)
    };
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.activeSessionId = null;
  }

  create(gameName, agentCount) {
    // v1: 단일 세션만 허용 — 기존 세션이 있으면 에러
    if (this.activeSessionId) {
      const existing = this.sessions.get(this.activeSessionId);
      if (existing && existing.status !== STATUS.STOPPED) {
        throw new Error(`Session already active: ${existing.gameName} (${existing.id})`);
      }
    }

    const session = new Session(gameName, agentCount);
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    return session;
  }

  getActive() {
    if (!this.activeSessionId) return null;
    const session = this.sessions.get(this.activeSessionId);
    if (!session || session.status === STATUS.STOPPED) return null;
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  stop(id) {
    const session = this.sessions.get(id || this.activeSessionId);
    if (session) {
      session.setStatus(STATUS.STOPPED);
    }
    return session;
  }
}

module.exports = { Session, SessionManager, STATUS };
