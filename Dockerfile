FROM node:14
WORKDIR /app

COPY dist /app/dist
COPY package.json /app
COPY yarn.lock /app

RUN yarn install 
EXPOSE 31208

CMD ["yarn", "start"]
