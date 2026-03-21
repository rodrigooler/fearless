import { App, type } from "../index.js";

const UserSchema = type({
  name: "string",
  email: "string.email",
  age: "number",
});

const app = new App({ port: 3000 });

app.use(async (req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  await next();
});

app.get("/", (req, res) => {
  res.json({ message: "Hello from microu!", version: "1.0.0" });
});

app.get("/users/:id", (req, res) => {
  res.json({
    id: req.params.id,
    name: "John Doe",
    email: "john@example.com",
  });
});

app.post("/users", async (req, res) => {
  const user = await req.parseBodyRaw(UserSchema);

  if (!user) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  res.json({ created: true, user });
});

app.put("/users/:id", async (req, res) => {
  const user = await req.parseBodyRaw(UserSchema);

  if (!user) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  res.json({ updated: true, id: req.params.id, user });
});

app.delete("/users/:id", (req, res) => {
  res.json({ deleted: true, id: req.params.id });
});

app.get("/query", (req, res) => {
  res.json({ query: req.query });
});

app.listen((socket) => {
  if (socket) {
    console.log("Server running on http://localhost:3000");
  } else {
    console.error("Failed to start server");
  }
});
