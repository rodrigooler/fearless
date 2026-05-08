# Fearless examples

Each example is a self-contained app you can run with `npx tsx`.

| Example | Port | Shows |
|---|---|---|
| [hello-world](./hello-world/) | 3000 | Smallest possible app: template route + handler route. |
| [rest-crud](./rest-crud/) | 3001 | In-memory User CRUD with validation, `HttpError`, status codes. |
| [with-middleware](./with-middleware/) | 3002 | `onRequest`/`onResponse`/`onError` hooks. Auth, logging, error handling. |
| [microservice](./microservice/) | 3003 | Health probes, Prometheus metrics, graceful shutdown. |

## Run any example

    npx tsx examples/<name>/server.ts

## See also

- The `basic.ts` example at the repo root demonstrates the original template-only API.
- Project README for the full API reference.
