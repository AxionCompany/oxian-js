# Chapter 3: Lifecycle and middleware

Chapter 2 put the redaction policy directly in one route. That works until more
routes need the same policy or every response needs the same operational
headers.

## The pain

Copying setup into handlers wastes work and spreads policy across files. Copying
request IDs and timing code into every method is even easier to get wrong. The
service also needs one predictable place to release resources when its worker
stops.

## The solution

Move the shared redaction policy into application state, construct that state
with an application factory, and wrap matched routes with root middleware.

Stop `dev` with `Ctrl-C`. Create `logwash.ts` at the project root:

```ts
export const PROFILES = Object.freeze(
  [
    "basic",
    "strict",
  ] as const,
);

export type Profile = (typeof PROFILES)[number];

export type LogwashState = Readonly<{
  startedAt: string;
  profiles: readonly Profile[];
  redact(profile: Profile, message: string): string;
}>;

export function asProfile(value: unknown): Profile | undefined {
  return typeof value === "string" &&
      PROFILES.includes(value as Profile)
    ? value as Profile
    : undefined;
}

export function createLogwashState(): LogwashState {
  return Object.freeze({
    startedAt: new Date().toISOString(),
    profiles: PROFILES,
    redact(profile: Profile, message: string): string {
      const withoutEmail = message.replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[EMAIL]",
      );
      return profile === "strict"
        ? withoutEmail.replace(
          /\bsk-[A-Za-z0-9_-]+\b/g,
          "[SECRET]",
        )
        : withoutEmail;
    },
  });
}
```

Create `application.ts` beside it:

```ts
import {
  createApplication,
  defineApplicationFactory,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/app";
import { createLogwashState, type LogwashState } from "./logwash.ts";

export default defineApplicationFactory<LogwashState>(
  ({ router, basePath, signal }) => {
    signal.throwIfAborted();

    return createApplication({
      router,
      basePath,
      setup: ({ signal: applicationSignal }) => {
        applicationSignal.throwIfAborted();
        const state = createLogwashState();
        console.log(`Logwash ready since ${state.startedAt}`);
        return state;
      },
      onError: (error) => {
        console.error("Unhandled Logwash request error", error);
        return Response.json(
          { error: "internal server error" },
          { status: 500 },
        );
      },
      dispose: (state, { reason }) => {
        console.log(
          `Logwash stopped (${String(reason)}); started ${state.startedAt}`,
        );
      },
    });
  },
);
```

An application factory module has one export: its default factory. The public
`defineApplicationFactory` helper checks that boundary, and `createApplication`
owns setup, requests, and disposal.

Tell Oxian to use the factory by replacing `oxian.config.ts`:

```ts
export default {
  application: {
    routesRoot: "./routes",
    basePath: "/",
    factory: "./application.ts",
  },
  gateway: {
    listener: {
      hostname: "127.0.0.1",
      port: 8000,
    },
  },
} as const;
```

Add root route middleware in `routes/_middleware.ts`:

```ts
import type { RouteMiddleware } from "jsr:@oxian/oxian-js@0.20.0-rc.5/router";
import type { LogwashState } from "../logwash.ts";

export const middleware: RouteMiddleware<LogwashState> = async (
  request,
  _context,
  next,
) => {
  const requestId = request.headers.get("x-request-id") ??
    crypto.randomUUID();
  const started = performance.now();
  const response = await next();

  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set(
    "server-timing",
    `logwash;dur=${(performance.now() - started).toFixed(1)}`,
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
```

The filename and export are intentional: route middleware is named
`_middleware.ts` and has a named `middleware` export. It runs from the routes
root toward the selected route and may call `next()` once.

Finally, replace `routes/redactions/[profile].ts` so it consumes the prepared
state:

```ts
import type { RouteContext } from "jsr:@oxian/oxian-js@0.20.0-rc.5/router";
import { asProfile, type LogwashState } from "../../logwash.ts";

type Context = RouteContext<LogwashState>;

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function GET(
  _request: Request,
  context: Context,
): Response {
  const profile = asProfile(context.params.profile);
  if (profile === undefined) {
    return errorResponse("unknown profile", 404);
  }

  return Response.json({
    profile,
    startedAt: context.state.startedAt,
  });
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const profile = asProfile(context.params.profile);
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
    redacted: context.state.redact(profile, message),
  });
}
```

The project shape is now:

```text
logwash/
├── application.ts
├── logwash.ts
├── oxian.config.ts
└── routes/
    ├── _middleware.ts
    ├── index.ts
    └── redactions/
        └── [profile].ts
```

Check it, then start it:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.5/bin check
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.5/bin dev
```

`check` validates the factory module's shape but deliberately does not invoke
the factory or run `setup`. The `Logwash ready` line appears only when `dev`
constructs the application.

## Verify it

Send a stable request ID so the middleware result is easy to see:

```bash
curl --include \
  --header 'x-request-id: guide-chapter-3' \
  http://127.0.0.1:8000/redactions/basic
```

The response has these headers:

```text
x-request-id: guide-chapter-3
server-timing: logwash;dur=...
```

Its JSON includes the profile and the time from the one shared state:

```json
{ "profile": "basic", "startedAt": "..." }
```

Make the same request again. `startedAt` stays the same because `setup` did not
run per request.

Stop `dev` with `Ctrl-C`. The terminal prints the `Logwash stopped` message from
`dispose`.

## What happened

The local worker invoked the factory once to construct its application. `setup`
produced the state available as `context.state` in every handler and middleware
for that application instance.

For a matched handler, middleware ran before the handler, awaited `next()`, and
decorated the returned response. If a handler or middleware throws, `onError`
returns a stable public response while the original error remains in the server
log.

During shutdown, the application stops accepting requests, aborts active request
signals, waits for response bodies to settle, and then invokes `dispose`. In a
deployment with several workers, each worker owns its own application instance
and therefore runs its own setup and disposal.

## What this unlocks

Logwash can now prepare shared dependencies once, keep request code small, apply
cross-cutting behavior consistently, and clean up deterministically. Those
lifecycle boundaries are suitable for resources such as database clients or
background tasks as the service grows.

## What's next

In [Chapter 4: Streaming and cancellation](04-streaming-and-cancellation.md),
Logwash will redact newline-delimited records while they are still arriving,
without buffering the whole request or response.
