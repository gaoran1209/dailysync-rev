FROM node:20-bookworm

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

COPY package.json yarn.lock package-lock.json tsconfig.json ./
RUN yarn install --frozen-lockfile
RUN npx playwright install --with-deps chromium

COPY src ./src
COPY assets ./assets
COPY LICENSE.txt README.md ./

RUN yarn build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["yarn", "start"]
