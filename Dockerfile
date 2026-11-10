FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=53405 OUTPUT_DIR=/app/output
VOLUME ["/app/output"]
EXPOSE 53405
CMD ["node", "src/server.js"]
