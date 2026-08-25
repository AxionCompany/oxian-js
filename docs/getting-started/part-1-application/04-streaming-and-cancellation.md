# Chapter 4: Streaming and cancellation

Chapter 3 gave Logwash shared policy and a controlled lifecycle. The existing
`POST` route still waits for one complete JSON body before returning one
complete JSON result.

## The pain

Real log exports can be much larger than memory, and a caller may disconnect
halfway through. Buffering the full upload delays the first result, defeats
backpressure, and can leave unnecessary work running after nobody is listening.

## The solution

Add a newline-delimited JSON endpoint. Each input line becomes one output line.
Native web streams let output demand pull input forward gradually, while the
request `AbortSignal` and stream cancellation stop the pipeline on disconnect.

Stop `dev` with `Ctrl-C`. Create `routes/redactions/stream.ts`:

```ts
import type { RouteContext } from "jsr:@oxian/oxian-js@0.21.0/router";
import { asProfile, type LogwashState } from "../../logwash.ts";

type Context = RouteContext<LogwashState>;

const encoder = new TextEncoder();

function splitLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<string> {
  let buffered = "";

  const decoded = body.pipeThrough(
    new TextDecoderStream("utf-8", { fatal: true }),
    { signal },
  );

  return decoded.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        buffered += chunk;

        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          controller.enqueue(
            line.endsWith("\r") ? line.slice(0, -1) : line,
          );
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      },
      flush(controller) {
        if (buffered.length > 0) {
          controller.enqueue(
            buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered,
          );
        }
      },
    }),
    { signal },
  );
}

function resultLine(
  source: string,
  line: number,
  state: LogwashState,
): Uint8Array {
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    return encoder.encode(
      JSON.stringify({ line, error: "invalid_json" }) + "\n",
    );
  }

  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return encoder.encode(
      JSON.stringify({ line, error: "expected_object" }) + "\n",
    );
  }

  const record = input as Record<string, unknown>;
  const profile = asProfile(record.profile);
  if (profile === undefined) {
    return encoder.encode(
      JSON.stringify({ line, error: "unknown_profile" }) + "\n",
    );
  }
  if (typeof record.message !== "string") {
    return encoder.encode(
      JSON.stringify({ line, error: "message_must_be_string" }) + "\n",
    );
  }

  return encoder.encode(
    JSON.stringify({
      line,
      profile,
      redacted: state.redact(profile, record.message),
    }) + "\n",
  );
}

function redactLines(
  lines: ReadableStream<string>,
  context: Context,
): ReadableStream<Uint8Array> {
  const reader = lines.getReader();
  let lineNumber = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          context.signal.throwIfAborted();
          const next = await reader.read();

          if (next.done) {
            controller.close();
            return;
          }
          if (next.value.trim().length === 0) {
            continue;
          }

          lineNumber++;
          controller.enqueue(
            resultLine(next.value, lineNumber, context.state),
          );
          return;
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

export function POST(
  request: Request,
  context: Context,
): Response {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.toLowerCase().startsWith(
      "application/x-ndjson",
    )
  ) {
    return Response.json(
      { error: "content-type must be application/x-ndjson" },
      { status: 415 },
    );
  }
  if (request.body === null) {
    return Response.json(
      { error: "request body is required" },
      { status: 400 },
    );
  }

  const lines = splitLines(request.body, context.signal);
  const output = redactLines(lines, context);

  return new Response(output, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}
```

The new static route is `POST /redactions/stream`. It wins over the dynamic
`/redactions/:profile` route because static routes are more specific.

Check and start the project:

```bash
deno run -A jsr:@oxian/oxian-js@0.21.0/bin check
deno run -A jsr:@oxian/oxian-js@0.21.0/bin routes
deno run -A jsr:@oxian/oxian-js@0.21.0/bin dev
```

The route table now includes:

```text
POST                     /redactions/stream
```

## Verify it

In another terminal, stream two records with a two-second pause between them:

```bash
(
  printf '%s\n' \
    '{"profile":"basic","message":"user jane@example.com"}'
  sleep 2
  printf '%s\n' \
    '{"profile":"strict","message":"token sk-local-123"}'
) | curl --silent --show-error --no-buffer --http1.1 \
  --request POST \
  --header 'content-type: application/x-ndjson' \
  --header 'expect:' \
  --upload-file - \
  http://127.0.0.1:8000/redactions/stream
```

The first result appears before the pause finishes; the second appears after the
second input line:

```json
{"line":1,"profile":"basic","redacted":"user [EMAIL]"}
{"line":2,"profile":"strict","redacted":"token [SECRET]"}
```

Malformed records remain explicit records because the response status and
headers may already have been sent:

```bash
printf '%s\n' \
  'not-json' \
  '{"profile":"missing","message":"hello"}' |
  curl --silent --show-error --no-buffer --http1.1 \
    --request POST \
    --header 'content-type: application/x-ndjson' \
    --header 'expect:' \
    --upload-file - \
    http://127.0.0.1:8000/redactions/stream
```

```json
{"line":1,"error":"invalid_json"}
{"line":2,"error":"unknown_profile"}
```

To exercise cancellation, run a longer stream and press `Ctrl-C` after the first
few results:

```bash
while true; do
  printf '%s\n' \
    '{"profile":"basic","message":"user jane@example.com"}'
  sleep 0.2
done | curl --silent --show-error --no-buffer --http1.1 \
  --request POST \
  --header 'content-type: application/x-ndjson' \
  --header 'expect:' \
  --upload-file - \
  http://127.0.0.1:8000/redactions/stream
```

After cancellation, Logwash still accepts a new request:

```bash
curl --silent --show-error http://127.0.0.1:8000/
```

## What happened

The request body arrived as a `ReadableStream<Uint8Array>`. A decoder and line
splitter transformed it without collecting the whole upload. The output stream's
`pull()` reads one non-empty input record and emits one output record, then
returns. When the downstream reader slows, pulls slow, and that pressure
propagates through the HTTP workload and Oxian's backpressured worker streams.
The local in-process host passes Web Streams directly; a separated worker maps
the same demand onto protocol byte credit.

`context.signal` combines request cancellation with application shutdown.
Passing it into the input pipeline interrupts pending reads. If the response
consumer disconnects, the output stream's `cancel()` cancels the line reader,
which propagates back to the request body. Cancellation is therefore one
connected path, not a background task that has to be rediscovered later.

A valid HTTP response cannot change its status after streaming begins. That is
why invalid JSON and invalid profiles are represented as terminal results for
their individual lines. Invalid UTF-8 or an infrastructure failure still errors
the stream itself.

Backpressure bounds queued chunks, but this tutorial splitter does not impose a
maximum length for one line. A production endpoint should add a per-record byte
limit appropriate to its clients.

## What this unlocks

Logwash can process uploads larger than memory, return useful work before an
upload finishes, and stop promptly when the caller or worker goes away. The same
Fetch-native pattern works for file transforms, event feeds, model output, and
other long-lived HTTP responses.

## What's next

Part 1 kept the HTTP entrypoint and worker in one local process. In
[Chapter 5: Separate the worker](../part-2-workers/05-separate-worker.md), you
will run the same Logwash application behind a separately started outbound
worker.
