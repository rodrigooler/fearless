FROM oven/bun:1.3.10

EXPOSE 8080

WORKDIR /app

COPY ./src ./src

USER bun

CMD ["bun", "./src/techempower-spawn.ts"]
