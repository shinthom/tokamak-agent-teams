# Tokamak Agent Teams

Inspired by Anthropic's [**"How we built a C compiler using Claude as our coding agent"**](https://www.anthropic.com/engineering/building-c-compiler), this project applies the same multi-agent approach to building mini-games. Multiple Claude agents run in Docker containers, coordinating through a shared Git repository with no central orchestrator.

## How It Works

```bash
./forge.sh pingpong 3
```

1. Auto-generates a game spec (`SPEC.md`)
2. Each agent reads `CLAUDE.md` (the constitution) and decides what to do next
3. File-based task locking prevents work conflicts
4. Implement → test → commit → push, on repeat
5. Real-time dashboard at `http://localhost:3000` to monitor progress

## Quick Start

```bash
cp .env.example .env
# Set your ANTHROPIC_API_KEY in .env

./forge.sh <game-name> <agent-count>
```
