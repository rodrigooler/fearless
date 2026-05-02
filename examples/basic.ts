import { App } from "../index.js";
import { cors, securityHeaders } from "../src/dependencies/index.js";

const app = new App({ port: 3000 });

app.use(cors({ origin: true }));
app.use(securityHeaders());

app.get("/", {
  kind: "json",
  body: { message: "Hello from microu!", version: "1.0.0" },
});

app.get("/users/:id", {
  kind: "json",
  body: {
    id: "{{ params.id }}",
    name: "John Doe",
    email: "john@example.com",
  },
});

app.post("/users", {
  kind: "json",
  status: 201,
  body: { created: true, resource: "users" },
});

app.put("/users/:id", {
  kind: "json",
  body: {
    updated: true,
    id: "{{ params.id }}",
  },
});

app.delete("/users/:id", {
  kind: "json",
  body: {
    deleted: true,
    id: "{{ params.id }}",
  },
});

app.get("/query", {
  kind: "json",
  body: {
    query: {
      tag: "{{ query.tag }}",
      mode: "{{ query.mode }}",
    },
  },
});

app.listen((socket) => {
  if (socket) {
    console.log("Server running on http://localhost:3000");
  } else {
    console.error("Failed to start server");
  }
});
