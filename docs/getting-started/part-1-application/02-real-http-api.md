# Chapter 2: A real HTTP API

Chapter 1 proved that Logwash can answer a request. Now it needs an API that
does useful work.

## The pain

A redaction service cannot be one hard-coded `GET` response. Clients need to
choose a policy, send a log message, and receive a useful error when their
request is invalid. You also need a way to catch route mistakes before opening a
port.

## The solution

Add a dynamic route named `[profile].ts`. A filename in brackets captures that
URL segment, while named exports decide which HTTP methods the route accepts.

Stop the Chapter 1 `dev` process with `Ctrl-C`, then create the route directory:

```bash
mkdir -p routes/redactions
```

Create `routes/redactions/[profile].ts`:

```ts
import type { RouteContext } from "jsr:@oxian/oxian-js@0.20.0-rc.1/router";

function redactEmail(message: string): string {
  return message.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[EMAIL]",
  );
}

const REDACTORS = Object.freeze({
  basic: redactEmail,
  strict: (message: string) =>
    redactEmail(message).replace(
      /\bsk-[A-Za-z0-9_-]+\b/g,
      "[SECRET]",
    ),
});

type Profile = keyof typeof REDACTORS;

function selectedProfile(
  context: RouteContext,
): Profile | undefined {
  const value = context.params.profile;
  if (
    typeof value !== "string" ||
    !Object.hasOwn(REDACTORS, value)
  ) {
    return undefined;
  }
  return value as Profile;
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function GET(
  _request: Request,
  context: RouteContext,
): Response {
  const profile = selectedProfile(context);
  if (profile === undefined) {
    return errorResponse("unknown profile", 404);
  }

  return Response.json({ profile });
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const profile = selectedProfile(context);
  if (profile === undefined) {
    return errorResponse("unknown profile", 404);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return errorResponse("content-type must be application/json", 415);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return errorResponse("body must be valid JSON", 400);
  }

  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof (input as Record<string, unknown>).message !== "string"
  ) {
    return errorResponse("message must be a string", 400);
  }

  const message = (input as Record<string, string>).message;
  return Response.json({
    profile,
    redacted: REDACTORS[profile](message),
  });
}
```

The project now contains two route modules:

```text
routes/
├── index.ts
└── redactions/
    └── [profile].ts
```

Validate the configuration and every route module without starting the listener:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.1/bin check
```

You should see:

```text
configuration, application entry, and 2 routes are valid
```

Inspect the compiled route table:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.1/bin routes
```

It includes these patterns:

```text
GET                      /
GET,POST                 /redactions/:profile
```

Start Logwash again:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.1/bin dev
```

## Verify it

Ask which profile the dynamic route selected:

```bash
curl --silent --show-error \
  http://127.0.0.1:8000/redactions/basic
```

```json
{ "profile": "basic" }
```

Send a message through the strict profile:

```bash
curl --silent --show-error \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"message":"login jane@example.com token sk-local-123"}' \
  http://127.0.0.1:8000/redactions/strict
```

```json
{ "profile": "strict", "redacted": "login [EMAIL] token [SECRET]" }
```

An unknown profile is an application-level `404`:

```bash
curl --include \
  http://127.0.0.1:8000/redactions/unknown
```

An unsupported method is handled by Oxian:

```bash
curl --include \
  --request DELETE \
  http://127.0.0.1:8000/redactions/basic
```

The response is `405 Method Not Allowed` and its `Allow` header contains
`GET, HEAD, POST, OPTIONS`. Oxian derives `HEAD` from `GET` and supplies
`OPTIONS` when the route does not export it.

## What happened

The file `redactions/[profile].ts` compiled to `/redactions/:profile`. For this
route, `context.params.profile` is the captured segment. Parameter values have
the common router type `string | readonly string[]`, so the handler narrows it
before use; catch-all parameters use the array form.

The same module exports both `GET` and `POST`. The `POST` handler reads the
native request body, validates it, and returns explicit `400`, `404`, or `415`
responses for client mistakes. Errors are ordinary `Response` objects, not
special framework exceptions.

`check` imports and validates the route table without opening an HTTP listener.
`routes` prints the exact patterns and methods Oxian compiled.

## What this unlocks

Logwash is now a useful synchronous API. File placement expresses URL shape,
method exports express HTTP behavior, and native Fetch APIs handle bodies,
headers, and status codes.

## What's next

In [Chapter 3: Lifecycle and middleware](03-lifecycle-and-middleware.md),
Logwash will prepare shared policy once, add route middleware, and clean up when
its worker stops.
