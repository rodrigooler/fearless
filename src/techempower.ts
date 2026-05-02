import { App } from "./index.js";

const app = new App({
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "0.0.0.0",
  runtime: "auto",
});

const benchmarkHeaders = {
  Server: "Fearless",
};

app.text("/plaintext", "Hello, World!", {
  headers: benchmarkHeaders,
});

app.json("/json", { message: "Hello, World!" }, {
  headers: benchmarkHeaders,
});

app.listen();
