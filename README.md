# Tokamak Agent Teams

Inspired by Anthropic's [**"How we built a C compiler using Claude as our coding agent"**](https://www.anthropic.com/engineering/building-c-compiler), this project applies the same multi-agent approach to building mini-games autonomously.

## Key Principles

The original blog post demonstrated that a team of 16 parallel Claude instances could build a 100,000-line C compiler — coordinating solely through Git with no central orchestrator. We adopted the core principles from that work:

**Constitution-driven agents** — Each agent reads a shared `CLAUDE.md` that defines its role, rules, and workflow. There is no central scheduler telling agents what to do. They read the constitution, assess the current state of the repo, and decide their next action independently.

**Git as the only coordination layer** — Agents share a bare Git repository. They push, pull, and rebase just like human developers. Conflicts are resolved through `git rebase`, not through a message broker or task queue.

**File-based task locking** — Before starting work, an agent writes a lock file to `current_tasks/` and pushes it. Other agents check this directory to avoid duplicate work. This mirrors the file-based locking used in the C compiler project.

**Tests gate all progress** — Agents must run `tests/run-tests.sh` before pushing. Failing tests block the push. This ensures that autonomous agents don't degrade the codebase, matching the blog's emphasis on high-quality automated tests as the primary feedback loop.

**Small, atomic commits** — The constitution enforces one small feature per cycle. This keeps merge conflicts manageable and makes it easy for other agents to integrate changes on the next pull.

## Our Design

We built a pipeline that scaffolds a game project, launches N Claude agents in Docker containers, and monitors everything in real-time:

```bash
./forge.sh pingpong 3
```

1. Scaffold a bare git repo with `CLAUDE.md` (constitution) and test infrastructure
2. Auto-generate a detailed game spec (`SPEC.md`) via Claude
3. Launch N agents in isolated Docker containers, each with its own workspace
4. Each agent loops: pull → read constitution → find next task → implement → test → commit → push
5. Real-time dashboard at `http://localhost:3000` to monitor agent status, commits, and progress

Each agent runs Claude CLI in a 5-second loop. On every iteration, it syncs with the repo, invokes Claude with the constitution as the prompt, and lets the model autonomously decide what to build next — following the priority order: fix failing tests, implement missing features, then improve code quality.

<img width="1728" height="1117" alt="image" src="https://github.com/user-attachments/assets/ee93bcde-c98a-421a-a5f3-76f99f4cde17" />


## Quick Start

```bash
cp .env.example .env
# Set your ANTHROPIC_API_KEY in .env

./forge.sh <game-name> <agent-count>
```
