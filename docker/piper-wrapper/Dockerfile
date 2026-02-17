FROM node:18-alpine

RUN npm install -g piper

WORKDIR /app
COPY server.js .

EXPOSE 5002
CMD ["node", "server.js"]