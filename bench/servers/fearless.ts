import { App } from "../../src/index.js";

const port = Number(process.env.PORT ?? 4101);

const app = new App({ port, host: "127.0.0.1" });

app.get("/", (_req, res) => {
  res.text("Hello, World!");
});

app.listen((socket) => {
  if (socket) {
    console.log(`READY ${port}`);
    return;
  }

  console.error(`FAILED ${port}`);
  process.exitCode = 1;
});
