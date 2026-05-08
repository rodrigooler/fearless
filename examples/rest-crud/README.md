# REST CRUD

In-memory User CRUD with validation, params, and proper status codes.

## Run

    npx tsx examples/rest-crud/server.ts

## Try

    # List
    curl http://localhost:3001/users

    # Create
    curl -X POST http://localhost:3001/users \
      -H 'content-type: application/json' \
      -d '{"name":"Ada","email":"ada@example.com"}'

    # Get one
    curl http://localhost:3001/users/<id>

    # Bad payload — 422 ValidationError
    curl -X POST http://localhost:3001/users -d '{}'

    # Delete
    curl -X DELETE http://localhost:3001/users/<id>

## What it shows

- `ctx.params` for path variables.
- `ctx.validate(fn)` — body parse + validation in one step. Throws `ValidationError` (422) on failure.
- `HttpError.notFound(msg)` — clean 404 with structured body.
- Chainable status + header before the response builder.
- `ctx.noContent()` for proper 204 on delete.
