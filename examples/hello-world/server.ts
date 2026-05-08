import { App } from "../../src/index.js";

const app = new App({ port: 3000 });

// Template route — eligible for the Rust hot path.
app.text("/", "Hello, World!");

// Handler route — runs on Node/Bun.
app.get("/greet/:name", (ctx) => ctx.json({ message: `Hello, ${ctx.params.name}!` }));

app.listen((started) => {
  if (started) {
    console.log("Hello world server on http://localhost:3000");
    console.log("Try: curl http://localhost:3000/");
    console.log("Try: curl http://localhost:3000/greet/Alice");
  }
});
