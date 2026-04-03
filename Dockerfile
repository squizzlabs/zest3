FROM node:22-alpine

ARG PORT=3000
ARG MONGODB_URI
ARG DB_NAME
ARG COLLECTION_NAME
ARG CREATE_INDEX=false

ENV PORT=${PORT}
ENV MONGODB_URI=${MONGODB_URI}
ENV DB_NAME=${DB_NAME}
ENV COLLECTION_NAME=${COLLECTION_NAME}
ENV CREATE_INDEX=${CREATE_INDEX}

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "const port=process.env.PORT||'3000';fetch(`http://127.0.0.1:${port}/health`).then((r)=>{if(!r.ok)process.exit(1);process.exit(0);}).catch(()=>process.exit(1))"]

USER node

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
CMD ["npm", "start"]
