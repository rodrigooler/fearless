import { App, HttpError } from "../../src/index.js";

interface User {
  id: string;
  name: string;
  email: string;
}

interface CreateUserBody {
  name: string;
  email: string;
}

const users = new Map<string, User>();

function parseCreateUser(data: unknown): CreateUserBody | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return null;
  if (typeof candidate.email !== "string" || !candidate.email.includes("@")) return null;
  return { name: candidate.name, email: candidate.email };
}

function nextId(): string {
  return `usr_${Math.random().toString(36).slice(2, 10)}`;
}

const app = new App({ port: 3001 });

app.get("/users", (ctx) => {
  return ctx.json({ users: Array.from(users.values()) });
});

app.get("/users/:id", (ctx) => {
  const user = users.get(ctx.params.id);
  if (!user) throw HttpError.notFound(`user ${ctx.params.id} not found`);
  return ctx.json(user);
});

app.post("/users", async (ctx) => {
  const body = await ctx.validate(parseCreateUser);
  const user: User = { id: nextId(), ...body };
  users.set(user.id, user);
  return ctx.status(201).header("Location", `/users/${user.id}`).json(user);
});

app.delete("/users/:id", (ctx) => {
  if (!users.has(ctx.params.id)) {
    throw HttpError.notFound(`user ${ctx.params.id} not found`);
  }
  users.delete(ctx.params.id);
  return ctx.noContent();
});

app.listen((started) => {
  if (started) console.log("REST CRUD on http://localhost:3001");
});
