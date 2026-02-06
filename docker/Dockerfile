FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash agent

# Create working directories with agent ownership
RUN mkdir -p /repo /work && chown -R agent:agent /work

# Copy agent loop script
COPY agent-loop.sh /usr/local/bin/agent-loop.sh
RUN chmod +x /usr/local/bin/agent-loop.sh

WORKDIR /work
USER agent

ENTRYPOINT ["/usr/local/bin/agent-loop.sh"]
