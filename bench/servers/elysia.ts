import { Elysia } from "elysia";
import { node } from "@elysiajs/node";

const port = Number(process.env.PORT ?? 4104);

new Elysia({ adapter: node() })
  .get("/", () => "Hello, World!")
  .listen(port);

console.log(`READY ${port}`);
