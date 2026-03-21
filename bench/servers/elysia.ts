import { Elysia } from "elysia";

const port = Number(process.env.PORT ?? 4102);

const app = new Elysia()
  .headers({
    server: "Elysia",
  })
  .get("/plaintext", () => "Hello, World!")
  .get("/json", () => ({ message: "Hello, World!" }))
  .listen(port);

console.log(`READY ${port}`);

process.on("SIGTERM", () => {
  app.stop();
  process.exit(0);
});
