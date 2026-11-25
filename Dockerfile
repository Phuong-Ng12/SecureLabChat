FROM node:20-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', { signal: AbortSignal.timeout(2500) }).then((res) => { if (!res.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; })"
CMD [ "npm", "run", "start" ]
