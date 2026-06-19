FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
EXPOSE 8092
CMD ["node", "server.js"]
