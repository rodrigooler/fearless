import { App } from "../../src/index.js";

const port = Number(process.env.PORT ?? 4101);

const app = new App({ port, host: "127.0.0.1", engine: "rust" });

app.text("/plaintext", "Hello, World!");

app.json("/json", { message: "Hello, World!" });

app.listen((socket) => {
  if (socket) {
    console.log(`READY ${port}`);
    return;
  }

  console.error(`FAILED ${port}`);
  process.exitCode = 1;
});

process.on("SIGTERM", async () => {
  await app.close();
  process.exit(0);
});
