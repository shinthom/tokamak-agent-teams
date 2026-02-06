FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js watcher.js session.js forge.js docker-manager.js index.html ./

EXPOSE 3000

CMD ["node", "server.js"]
