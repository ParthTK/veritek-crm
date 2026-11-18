# Veritek CRM for Google Cloud Run: builds the web app, then runs the API and serves the built app on $PORT.
# Data lives in Cloud SQL (PostgreSQL) and documents in a Cloud Storage bucket — see docs/deploy-google-cloud.md.
# Base images come through Google's Docker Hub mirror, which avoids Docker Hub's pull limits in Cloud Build.
FROM mirror.gcr.io/library/node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY shared ./shared
RUN npm run build

FROM mirror.gcr.io/library/node:24-slim
WORKDIR /app
ENV NODE_ENV=production CRM_ENV=production CRM_DATA_DIR=/tmp/veritek-data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/client/dist ./client/dist
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
