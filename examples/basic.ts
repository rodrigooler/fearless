import { App } from "../index.js";

type User = {
  name: string;
  email: string;
  age: number;
};

function parseUser(data: unknown): User | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const candidate = data as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.email !== "string" ||
    typeof candidate.age !== "number"
  ) {
    return null;
  }

  if (!candidate.email.includes("@")) {
    return null;
  }

  return {
    name: candidate.name,
    email: candidate.email,
    age: candidate.age,
  };
}

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
  const user = await req.parseBodyRaw(parseUser);

  if (!user) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  res.json({ created: true, user });
});

app.put("/users/:id", async (req, res) => {
  const user = await req.parseBodyRaw(parseUser);

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
