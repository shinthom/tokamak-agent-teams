/**
 * watcher.js — Git repo & task directory watcher
 *
 * Polls the shared git repo for changes and emits events
 * to the dashboard server via callback.
 */

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const POLL_INTERVAL = 2000; // 2 seconds

class RepoWatcher {
  constructor(repoPath, options = {}) {
    this.repoPath = repoPath;
    this.pollInterval = options.pollInterval || POLL_INTERVAL;
    this.listeners = [];
    this.lastCommitHash = null;
    this.timer = null;
    this.state = {
      agents: {},
      commits: [],
      currentTasks: [],
      completedTaskCount: 0,
      testResults: null,
      totalLines: 0,
      totalCommits: 0,
      specModules: []
    };
  }

  onChange(callback) {
    this.listeners.push(callback);
  }

  emit(event, data) {
    this.listeners.forEach(cb => cb(event, data));
  }

  start() {
    console.log(`[Watcher] Monitoring repo: ${this.repoPath}`);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(newRepoPath) {
    this.stop();
    this.repoPath = newRepoPath;
    this.lastCommitHash = null;
    this.state = {
      agents: {},
      commits: [],
      currentTasks: [],
      completedTaskCount: 0,
      testResults: null,
      totalLines: 0,
      totalCommits: 0,
      specModules: []
    };
    this.start();
  }

  poll() {
    try {
      // Pull latest changes from origin (에이전트의 push를 동기화)
      this.execGit('pull --rebase origin main');

      this.updateCommits();
      this.updateCurrentTasks();
      this.updateCompletedTasks();
      this.updateCodeStats();
      this.updateSpecModules();
      this.updateAgentStatus();
      this.emit('state', this.getState());
    } catch (err) {
      console.error('[Watcher] Poll error:', err.message);
    }
  }

  execGit(cmd) {
    try {
      return execSync(`git -C "${this.repoPath}" ${cmd}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    } catch {
      return '';
    }
  }

  updateCommits() {
    const log = this.execGit('log --oneline --format="%H|%an|%s|%cr" -30');
    if (!log) return;

    const commits = log.split('\n').filter(Boolean).map(line => {
      const [hash, author, message, timeAgo] = line.split('|');
      return { hash, author, message, timeAgo };
    });

    const latestHash = commits[0]?.hash;
    if (latestHash && latestHash !== this.lastCommitHash) {
      this.lastCommitHash = latestHash;
      this.emit('newCommit', commits[0]);
    }

    this.state.commits = commits;
    this.state.totalCommits = parseInt(this.execGit('rev-list --count HEAD') || '0', 10);
  }

  updateCurrentTasks() {
    const tasksDir = path.join(this.repoPath, 'current_tasks');
    try {
      const files = fs.readdirSync(tasksDir).filter(f => f !== '.gitkeep');
      this.state.currentTasks = files.map(f => {
        const content = fs.readFileSync(path.join(tasksDir, f), 'utf-8').trim();
        const match = f.match(/agent-(\d+)-(\d+)/);
        return {
          file: f,
          agentId: match ? match[1] : 'unknown',
          timestamp: match ? parseInt(match[2], 10) : 0,
          description: content
        };
      });
    } catch {
      this.state.currentTasks = [];
    }
  }

  updateCompletedTasks() {
    const completedDir = path.join(this.repoPath, 'completed_tasks');
    try {
      const files = fs.readdirSync(completedDir).filter(f => f !== '.gitkeep');
      this.state.completedTaskCount = files.length;
    } catch {
      this.state.completedTaskCount = 0;
    }
  }

  updateCodeStats() {
    const srcDir = path.join(this.repoPath, 'src');
    try {
      let totalLines = 0;
      const walkDir = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (/\.(js|html|css)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            totalLines += content.split('\n').length;
          }
        }
      };
      walkDir(srcDir);
      this.state.totalLines = totalLines;
    } catch {
      this.state.totalLines = 0;
    }
  }

  updateSpecModules() {
    const specPath = path.join(this.repoPath, 'SPEC.md');
    try {
      const content = fs.readFileSync(specPath, 'utf-8');
      const modules = [];
      const moduleRegex = /^###?\s+\d+\.\s+\*\*(.+?)\*\*/gm;
      let match;
      while ((match = moduleRegex.exec(content)) !== null) {
        modules.push({
          name: match[1].trim(),
          status: 'pending' // Will be updated by checking src/ files
        });
      }
      this.state.specModules = modules;
    } catch {
      this.state.specModules = [];
    }
  }

  updateAgentStatus() {
    // Derive agent status from current tasks and recent commits
    const activeAgents = new Set();

    this.state.currentTasks.forEach(task => {
      activeAgents.add(task.agentId);
      if (!this.state.agents[task.agentId]) {
        this.state.agents[task.agentId] = {
          id: task.agentId,
          status: 'working',
          currentTask: task.description,
          commitCount: 0,
          taskCount: 0
        };
      } else {
        this.state.agents[task.agentId].status = 'working';
        this.state.agents[task.agentId].currentTask = task.description;
      }
    });

    // Count commits per agent
    this.state.commits.forEach(commit => {
      const match = commit.author?.match(/agent-(\d+)/);
      if (match) {
        const id = match[1];
        if (!this.state.agents[id]) {
          this.state.agents[id] = {
            id,
            status: activeAgents.has(id) ? 'working' : 'idle',
            currentTask: null,
            commitCount: 0,
            taskCount: 0
          };
        }
        this.state.agents[id].commitCount++;
        if (commit.message?.includes('작업 완료')) {
          this.state.agents[id].taskCount++;
        }
      }
    });

    // Mark agents without current tasks as idle
    Object.keys(this.state.agents).forEach(id => {
      if (!activeAgents.has(id)) {
        this.state.agents[id].status = 'idle';
        this.state.agents[id].currentTask = null;
      }
    });
  }

  getState() {
    return { ...this.state };
  }
}

module.exports = { RepoWatcher };
