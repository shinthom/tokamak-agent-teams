/**
 * forge.js — forge.sh의 Node.js 포팅
 *
 * forge.sh의 7단계를 async 함수로 변환.
 * 각 단계마다 onProgress 콜백으로 WebSocket에 진행 상태 브로드캐스트.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const REPO_BASE = '/tmp/tokamak-forge-repos';
const WORK_BASE = '/tmp/tokamak-forge-work';

class ForgeProcess {
  constructor(gameName, agentCount, options = {}) {
    this.gameName = gameName;
    this.agentCount = agentCount;
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..');
    this.gameDescription = options.gameDescription || '';
    this.dockerManager = options.dockerManager || null;
    this.onProgress = options.onProgress || (() => {});
    this.repoPath = path.join(REPO_BASE, `${gameName}.git`);
    this.workDir = path.join(WORK_BASE, gameName);
    this.projectDir = path.join(this.workDir, 'project');
  }

  log(message) {
    console.log(`[Forge] ${message}`);
    this.onProgress({ type: 'log', message });
  }

  async run() {
    try {
      this.onProgress({ type: 'step', step: 0, message: 'Checking prerequisites' });
      await this.validatePrereqs();

      this.onProgress({ type: 'step', step: 1, message: 'Creating bare repository' });
      this.createBareRepo();

      this.onProgress({ type: 'step', step: 2, message: 'Scaffolding project' });
      this.scaffoldProject();

      this.onProgress({ type: 'step', step: 3, message: 'Generating SPEC.md' });
      await this.generateSpec();

      this.onProgress({ type: 'step', step: 4, message: 'Setting up tests' });
      this.setupTests();

      this.onProgress({ type: 'step', step: 5, message: 'Initial commit & push' });
      this.initialCommit();

      this.onProgress({ type: 'complete', repoPath: this.repoPath, workDir: this.projectDir });

      return {
        repoPath: this.repoPath,
        workDir: this.projectDir
      };
    } catch (err) {
      this.onProgress({ type: 'error', message: err.message });
      throw err;
    }
  }

  // Step 1: Validate prerequisites
  async validatePrereqs() {
    this.log('Checking ANTHROPIC_API_KEY...');
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    const masked = process.env.ANTHROPIC_API_KEY.slice(0, 6) + '...' + process.env.ANTHROPIC_API_KEY.slice(-4);
    this.log(`  ANTHROPIC_API_KEY: ${masked}`);

    if (process.env.ANTHROPIC_BASE_URL) {
      this.log(`  ANTHROPIC_BASE_URL: ${process.env.ANTHROPIC_BASE_URL}`);
    }

    for (const cmd of ['git', 'docker']) {
      this.log(`Checking ${cmd}...`);
      try {
        const ver = execSync(`${cmd} --version`, { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
        this.log(`  ${cmd}: ${ver}`);
      } catch {
        throw new Error(`'${cmd}' is required but not installed`);
      }
    }

    // Verify Docker daemon is actually running
    if (this.dockerManager) {
      this.log('Pinging Docker daemon...');
      const ping = await this.dockerManager.ping();
      if (!ping.ok) {
        throw new Error(`Docker daemon is not running (${ping.error}). Please start Docker Desktop.`);
      }
      this.log(`  Docker daemon: OK (${ping.socketPath})`);
    }

    this.log('All prerequisites OK');
  }

  // Step 2: Create bare git repo
  createBareRepo() {
    if (fs.existsSync(this.repoPath)) {
      this.log(`Existing repo found at ${this.repoPath}`);
      this.log('Removing old repository...');
      fs.rmSync(this.repoPath, { recursive: true, force: true });
      this.log('Old repository removed');
    }

    this.log(`Creating directory: ${REPO_BASE}`);
    fs.mkdirSync(REPO_BASE, { recursive: true });

    this.log(`Running: git init --bare ${this.repoPath}`);
    execSync(`git init --bare "${this.repoPath}"`, { stdio: 'ignore' });
    this.log(`Bare repo created: ${this.repoPath}`);
  }

  // Step 3: Scaffold project
  scaffoldProject() {
    // Clean and create work directory
    if (fs.existsSync(this.workDir)) {
      this.log(`Cleaning existing work dir: ${this.workDir}`);
      fs.rmSync(this.workDir, { recursive: true, force: true });
    }
    this.log(`Creating work directory: ${this.workDir}`);
    fs.mkdirSync(this.workDir, { recursive: true });

    // Clone bare repo
    this.log(`Cloning bare repo to ${this.projectDir}`);
    execSync(`git clone "${this.repoPath}" "${this.projectDir}"`, { stdio: 'ignore' });

    // Configure git
    this.log('Configuring git user: tokamak-forge <forge@tokamak>');
    execSync(`git -C "${this.projectDir}" config user.name "tokamak-forge"`);
    execSync(`git -C "${this.projectDir}" config user.email "forge@tokamak"`);

    // Create directory structure
    const dirs = ['src', 'tests', 'current_tasks', 'completed_tasks', 'logs'];
    this.log(`Creating directories: ${dirs.join(', ')}`);
    for (const dir of dirs) {
      fs.mkdirSync(path.join(this.projectDir, dir), { recursive: true });
    }

    // Create .gitkeep files
    for (const dir of ['current_tasks', 'completed_tasks', 'logs']) {
      fs.writeFileSync(path.join(this.projectDir, dir, '.gitkeep'), '');
    }

    // .gitignore
    this.log('Writing .gitignore');
    fs.writeFileSync(path.join(this.projectDir, '.gitignore'),
      'logs/*.log\nnode_modules/\n.DS_Store\n*.swp\n'
    );

    // CLAUDE.md from template
    this.log('Generating CLAUDE.md from template ({{GAME_NAME}} → ' + this.gameName + ')');
    const claudeTemplate = fs.readFileSync(
      path.join(this.projectRoot, 'templates', 'CLAUDE.md.template'), 'utf-8'
    );
    fs.writeFileSync(
      path.join(this.projectDir, 'CLAUDE.md'),
      claudeTemplate.replace(/\{\{GAME_NAME\}\}/g, this.gameName)
    );

    // Copy test utilities
    this.log('Copying tests/base-test.js');
    fs.copyFileSync(
      path.join(this.projectRoot, 'templates', 'tests', 'base-test.js'),
      path.join(this.projectDir, 'tests', 'base-test.js')
    );
    this.log('Copying tests/run-tests.sh');
    fs.copyFileSync(
      path.join(this.projectRoot, 'templates', 'tests', 'run-tests.sh'),
      path.join(this.projectDir, 'tests', 'run-tests.sh')
    );
    fs.chmodSync(path.join(this.projectDir, 'tests', 'run-tests.sh'), '755');

    // Generate index.html from template
    this.log('Generating src/index.html from template');
    const indexTemplate = fs.readFileSync(
      path.join(this.projectRoot, 'templates', 'src', 'index.html'), 'utf-8'
    );
    fs.writeFileSync(
      path.join(this.projectDir, 'src', 'index.html'),
      indexTemplate.replace(/\{\{GAME_NAME\}\}/g, this.gameName)
    );

    // Create src stubs
    this.log('Writing src/game.js (stub: createGame, updateGame, isGameOver)');
    this.writeGameStub();
    this.log('Writing src/renderer.js (stub: createRenderer, render)');
    this.writeRendererStub();
    this.log('Writing src/input.js (stub: setupInput)');
    this.writeInputStub();

    // Create test files
    this.log('Writing tests/structure.test.js (12 assertions)');
    this.writeStructureTest();
    this.log('Writing tests/game-logic.test.js (7 assertions)');
    this.writeGameLogicTest();

    // Summary
    const fileCount = this.countFiles(this.projectDir);
    this.log(`Scaffold complete: ${fileCount} files created`);
  }

  countFiles(dir) {
    let count = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        if (entry.isDirectory()) {
          count += this.countFiles(path.join(dir, entry.name));
        } else {
          count++;
        }
      }
    } catch {}
    return count;
  }

  writeGameStub() {
    fs.writeFileSync(path.join(this.projectDir, 'src', 'game.js'), `/**
 * game.js — Game logic module
 *
 * Exports: createGame(), updateGame(state, action), isGameOver(state)
 */

// Game state factory
function createGame() {
  return {
    score: 0,
    level: 1,
    gameOver: false,
    initialized: true
  };
}

// State update handler
function updateGame(state, action) {
  if (!state || state.gameOver) return state;

  if (action && action.type === 'tick') {
    // Game tick logic - to be implemented
  }

  return state;
}

// Game over check
function isGameOver(state) {
  return state ? state.gameOver : false;
}

// Node.js exports for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createGame, updateGame, isGameOver };
}
`);
  }

  writeRendererStub() {
    fs.writeFileSync(path.join(this.projectDir, 'src', 'renderer.js'), `/**
 * renderer.js — Canvas rendering module
 *
 * Exports: createRenderer(canvas), render(renderer, state)
 */

function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  return {
    ctx: ctx,
    width: canvas.width,
    height: canvas.height
  };
}

function render(renderer, state) {
  if (!renderer || !renderer.ctx) return;

  const ctx = renderer.ctx;
  const w = renderer.width;
  const h = renderer.height;

  // Clear canvas
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, w, h);

  // Placeholder text
  ctx.fillStyle = '#00d4ff';
  ctx.font = '16px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('Game initializing...', w / 2, h / 2);

  if (state && state.score !== undefined) {
    ctx.fillText('Score: ' + state.score, w / 2, h / 2 + 30);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRenderer, render };
}
`);
  }

  writeInputStub() {
    fs.writeFileSync(path.join(this.projectDir, 'src', 'input.js'), `/**
 * input.js — Input handling module
 *
 * Exports: setupInput(callback)
 */

function setupInput(callback) {
  if (typeof document === 'undefined') return;

  document.addEventListener('keydown', function(e) {
    var action = null;

    switch (e.key) {
      case 'ArrowLeft':  action = { type: 'move', direction: 'left' }; break;
      case 'ArrowRight': action = { type: 'move', direction: 'right' }; break;
      case 'ArrowDown':  action = { type: 'move', direction: 'down' }; break;
      case 'ArrowUp':    action = { type: 'rotate' }; break;
      case ' ':          action = { type: 'drop' }; break;
      case 'r': case 'R': action = { type: 'restart' }; break;
      case 'p': case 'P': action = { type: 'pause' }; break;
    }

    if (action && callback) {
      e.preventDefault();
      callback(action);
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { setupInput };
}
`);
  }

  writeStructureTest() {
    fs.writeFileSync(path.join(this.projectDir, 'tests', 'structure.test.js'), `const { assert, describe, it, summary } = require('./base-test');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');

describe('Project Structure', function() {
  it('should have index.html', function() {
    assert.ok(fs.existsSync(path.join(srcDir, 'index.html')), 'index.html missing');
  });

  it('should have game.js', function() {
    assert.ok(fs.existsSync(path.join(srcDir, 'game.js')), 'game.js missing');
  });

  it('should have renderer.js', function() {
    assert.ok(fs.existsSync(path.join(srcDir, 'renderer.js')), 'renderer.js missing');
  });

  it('should have input.js', function() {
    assert.ok(fs.existsSync(path.join(srcDir, 'input.js')), 'input.js missing');
  });

  it('should have CLAUDE.md', function() {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'CLAUDE.md')), 'CLAUDE.md missing');
  });

  it('should have SPEC.md', function() {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'SPEC.md')), 'SPEC.md missing');
  });
});

describe('Module Exports', function() {
  it('game.js should export createGame', function() {
    const game = require('../src/game');
    assert.strictEqual(typeof game.createGame, 'function');
  });

  it('game.js should export updateGame', function() {
    const game = require('../src/game');
    assert.strictEqual(typeof game.updateGame, 'function');
  });

  it('game.js should export isGameOver', function() {
    const game = require('../src/game');
    assert.strictEqual(typeof game.isGameOver, 'function');
  });

  it('renderer.js should export createRenderer', function() {
    const renderer = require('../src/renderer');
    assert.strictEqual(typeof renderer.createRenderer, 'function');
  });

  it('renderer.js should export render', function() {
    const renderer = require('../src/renderer');
    assert.strictEqual(typeof renderer.render, 'function');
  });

  it('input.js should export setupInput', function() {
    const input = require('../src/input');
    assert.strictEqual(typeof input.setupInput, 'function');
  });
});

process.exit(summary());
`);
  }

  writeGameLogicTest() {
    fs.writeFileSync(path.join(this.projectDir, 'tests', 'game-logic.test.js'), `const { assert, describe, it, summary, createCanvasMock } = require('./base-test');

describe('Game Logic', function() {
  it('createGame should return valid initial state', function() {
    const { createGame } = require('../src/game');
    const state = createGame();
    assert.ok(state, 'state should not be null');
    assert.strictEqual(typeof state.score, 'number');
    assert.strictEqual(state.gameOver, false);
    assert.strictEqual(state.initialized, true);
  });

  it('updateGame should handle tick action', function() {
    const { createGame, updateGame } = require('../src/game');
    const state = createGame();
    const newState = updateGame(state, { type: 'tick', delta: 16 });
    assert.ok(newState, 'updateGame should return state');
  });

  it('updateGame should not update when game is over', function() {
    const { updateGame } = require('../src/game');
    const state = { score: 100, gameOver: true };
    const result = updateGame(state, { type: 'tick', delta: 16 });
    assert.strictEqual(result.score, 100);
  });

  it('isGameOver should return false for new game', function() {
    const { createGame, isGameOver } = require('../src/game');
    const state = createGame();
    assert.strictEqual(isGameOver(state), false);
  });

  it('isGameOver should handle null state', function() {
    const { isGameOver } = require('../src/game');
    assert.strictEqual(isGameOver(null), false);
  });
});

describe('Renderer', function() {
  it('createRenderer should accept canvas mock', function() {
    const { createRenderer } = require('../src/renderer');
    const { canvas } = createCanvasMock();
    const renderer = createRenderer(canvas);
    assert.ok(renderer, 'renderer should not be null');
    assert.ok(renderer.ctx, 'renderer should have ctx');
  });

  it('render should not throw with valid state', function() {
    const { createRenderer, render } = require('../src/renderer');
    const { createGame } = require('../src/game');
    const { canvas } = createCanvasMock();
    const renderer = createRenderer(canvas);
    const state = createGame();
    assert.doesNotThrow(() => render(renderer, state));
  });
});

process.exit(summary());
`);
  }

  // Step 4: Generate SPEC.md with Claude CLI
  async generateSpec() {
    const descriptionClause = this.gameDescription
      ? `\n\nThe user described this game as: "${this.gameDescription}"\nUse this description to understand what the game should be.\n`
      : '';

    const specPrompt = `You are a game design expert. Generate a detailed SPEC.md for a '${this.gameName}' game.
${descriptionClause}
The game must be implemented in pure HTML5 Canvas + vanilla JavaScript (no libraries).

Format the document exactly like this:

# ${this.gameName} — Game Specification

## Overview
[Brief description of the game]

## Game Rules
[Detailed rules]

## Controls
[Keyboard controls]

## Module Breakdown

### 1. **Module Name** — description
- Detailed requirements
- Exported functions

### 2. **Module Name** — description
...

## Visual Design
[Canvas layout, colors, sizes]

## Scoring
[Score calculation rules]

## Implementation Priority
1. First thing to implement
2. Second thing
...

Keep it detailed enough that multiple developers can work on different modules independently.
Respond with ONLY the markdown content, no code fences.`;

    let specGenerated = false;

    try {
      // Check if claude CLI is available
      execSync('which claude', { stdio: 'ignore' });

      this.log('Claude CLI found, generating SPEC.md...');
      this.log(`Model: claude-opus-4-6`);
      this.log(`Prompt: generating ${this.gameName} game specification...`);

      const specContent = await new Promise((resolve, reject) => {
        let output = '';
        let errorOutput = '';

        const proc = spawn('claude', [
          '--model', 'claude-opus-4-6',
          '--print',
          '-p', specPrompt
        ], {
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        proc.stdout.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          this.onProgress({ type: 'spec-stream', chunk });
        });

        proc.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0 && output.trim()) {
            resolve(output.trim());
          } else {
            reject(new Error(`Claude CLI exited with code ${code}: ${errorOutput}`));
          }
        });

        proc.on('error', (err) => {
          reject(err);
        });
      });

      fs.writeFileSync(path.join(this.projectDir, 'SPEC.md'), specContent);
      specGenerated = true;
      const specLines = specContent.split('\n').length;
      this.log(`SPEC.md generated by Claude (${specLines} lines, ${specContent.length} bytes)`);

    } catch (err) {
      this.log(`Claude CLI unavailable (${err.message}), using template`);
    }

    if (!specGenerated) {
      // Fallback to template
      this.log('Falling back to SPEC.md template...');
      const specTemplate = fs.readFileSync(
        path.join(this.projectRoot, 'templates', 'SPEC.md.template'), 'utf-8'
      );
      const specContent = specTemplate.replace(/\{\{GAME_NAME\}\}/g, this.gameName);
      fs.writeFileSync(path.join(this.projectDir, 'SPEC.md'), specContent);
      this.log(`SPEC.md created from template (${specContent.split('\n').length} lines)`);
    }
  }

  // Step 5: Setup tests
  setupTests() {
    this.log('Verifying test files...');
    const testFiles = ['structure.test.js', 'game-logic.test.js', 'base-test.js', 'run-tests.sh'];
    for (const f of testFiles) {
      const exists = fs.existsSync(path.join(this.projectDir, 'tests', f));
      this.log(`  tests/${f}: ${exists ? 'OK' : 'MISSING'}`);
    }
    this.log('Tests ready');
  }

  // Step 6: Initial commit & push
  initialCommit() {
    const git = (cmd) => execSync(`git -C "${this.projectDir}" ${cmd}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.log('Staging all files (git add -A)...');
    git('add -A');

    // Show what's being committed
    const status = execSync(`git -C "${this.projectDir}" status --short`, { encoding: 'utf-8' }).trim();
    const fileLines = status.split('\n').filter(Boolean);
    this.log(`Staged ${fileLines.length} files:`);
    for (const line of fileLines) {
      this.log(`  ${line}`);
    }

    this.log('Creating initial commit...');
    git(`commit -m "init: scaffold ${this.gameName} project

- CLAUDE.md: agent constitution
- SPEC.md: game specification
- src/: initial game stubs (game.js, renderer.js, input.js, index.html)
- tests/: structure and game logic tests
- current_tasks/ & completed_tasks/: task coordination directories"`);

    this.log('Setting branch to main...');
    git('branch -M main');

    this.log(`Pushing to origin (${this.repoPath})...`);
    git('push -u origin main');

    this.log('Initial commit pushed to bare repo');

    // Verify tests pass
    this.log('Running initial tests...');
    try {
      const testOutput = execSync(`bash "${path.join(this.projectDir, 'tests', 'run-tests.sh')}"`, {
        cwd: this.projectDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      // Extract summary line
      const lines = testOutput.trim().split('\n');
      const resultLine = lines.find(l => l.includes('Results:') || l.includes('PASSED'));
      if (resultLine) this.log(`  ${resultLine.trim()}`);
      this.log('All initial tests pass');
    } catch (err) {
      this.log('Some initial tests failed (agents will fix these)');
      if (err.stdout) {
        const failLines = err.stdout.toString().split('\n').filter(l => l.includes('FAIL') || l.includes('✗'));
        for (const line of failLines.slice(0, 5)) {
          this.log(`  ${line.trim()}`);
        }
      }
    }
  }
}

module.exports = { ForgeProcess };
