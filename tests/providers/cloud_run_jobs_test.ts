import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects, assertThrows } from "../support/assert.ts";
import {
  createCloudRunJobsProvider,
  isProviderError,
  runProviderConformance,
} from "../../src/providers/core.ts";
import type {
  CloudRunJobsLaunchSpec,
  ProviderResource,
} from "../../src/providers/core.ts";

const PROJECT = "oxian-test-project";
const LOCATION = "us-central1";
const JOB = "oxian-worker";
const OPERATION = `projects/${PROJECT}/locations/${LOCATION}/operations/run-operation-1`;
const EXECUTION = `projects/${PROJECT}/locations/${LOCATION}/jobs/${JOB}/executions/execution-1`;
const CANCEL_OPERATION = `projects/${PROJECT}/locations/${LOCATION}/operations/cancel-operation-1`;
const RUN_URL = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/jobs/${JOB}:run`;
const OPERATION_URL = `https://run.googleapis.com/v2/${OPERATION}`;
const EXECUTION_URL = `https://run.googleapis.com/v2/${EXECUTION}`;
const CANCEL_URL = `${EXECUTION_URL}:cancel`;

const IDENTITY = Object.freeze({
  workerId: "cloud-worker-1",
  attemptId: "cloud-attempt-1",
  epoch: 7,
});

type FetchCall = Readonly<{
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

type FakeFetch = Readonly<{
  calls: FetchCall[];
  fetcher: typeof fetch;
}>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function createFakeFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FakeFetch {
  const calls: FetchCall[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const call = Object.freeze({
      url: request.url,
      method: request.method,
      headers: Object.freeze(Object.fromEntries(request.headers.entries())),
      body: request.body === null ? "" : await request.text(),
    });
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  return { calls, fetcher };
}

function createTokenRecorder(token = "test-access-token") {
  const signals: Array<AbortSignal | undefined> = [];
  return {
    signals,
    getAccessToken(options: Readonly<{ signal?: AbortSignal }> = {}): string {
      signals.push(options.signal);
      return token;
    },
  };
}

function assertProviderErrorCode(error: unknown, code: string): void {
  assert.ok(isProviderError(error));
  assert.deepStrictEqual(error.code, code);
  assert.deepStrictEqual(error.providerId, "google-cloud-run-jobs");
}

async function provision(
  provider: ReturnType<typeof createCloudRunJobsProvider>,
  launch: CloudRunJobsLaunchSpec = { job: JOB },
): Promise<ProviderResource> {
  return await provider.provision({
    identity: IDENTITY,
    launch,
  });
}

function realShapedExecution(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name: EXECUTION,
    uid: "01f5f5f8-282f-4de1-8452-3f455011e734",
    generation: "1",
    labels: {
      "run.googleapis.com/job": JOB,
    },
    createTime: "2026-07-28T00:00:00.000000Z",
    startTime: "2026-07-28T00:00:01.000000Z",
    updateTime: "2026-07-28T00:00:01.000000Z",
    launchStage: "GA",
    job: JOB,
    parallelism: 1,
    taskCount: 1,
    template: {
      containers: [
        {
          image: "us-docker.pkg.dev/cloudrun/container/hello",
        },
      ],
      maxRetries: 3,
      timeout: "3600s",
      serviceAccount: "worker@example.iam.gserviceaccount.com",
    },
    reconciling: false,
    conditions: [
      {
        type: "Started",
        state: "CONDITION_SUCCEEDED",
        lastTransitionTime: "2026-07-28T00:00:01.000000Z",
      },
    ],
    observedGeneration: "1",
    runningCount: 1,
    logUri: "https://console.cloud.google.com/logs/viewer",
    satisfiesPzs: true,
    etag: '"real-shaped-etag"',
    ...overrides,
  };
}

test("Cloud Run Jobs provision sends the exact authenticated run request and persists only safe attributes", async () => {
  const fake = createFakeFetch((call) => {
    assert.deepStrictEqual(call.url, RUN_URL);
    return jsonResponse({
      name: OPERATION,
      metadata: {
        name: EXECUTION,
      },
    });
  });
  const tokens = createTokenRecorder();
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: tokens.getAccessToken,
    fetcher: fake.fetcher,
    now: () => 1_700_000_000_000,
  });

  const resource = await provision(provider, {
    job: JOB,
    containerOverride: {
      name: "worker",
      args: ["deno", "task", "worker", "--opaque=argument-secret"],
      env: {
        OXIAN_REGISTRATION_CAPABILITY: "environment-secret",
        OXIAN_URL: "wss://control.example.test/_oxian/workers/connect",
      },
    },
    timeoutSeconds: 3_600,
    attributes: {
      pool: "fast",
    },
  });

  assert.deepStrictEqual(fake.calls.length, 1);
  assert.deepStrictEqual(fake.calls[0].url, RUN_URL);
  assert.deepStrictEqual(fake.calls[0].method, "POST");
  assert.deepStrictEqual(fake.calls[0].headers, {
    accept: "application/json",
    authorization: "Bearer test-access-token",
    "content-type": "application/json",
  });
  assert.deepStrictEqual(JSON.parse(fake.calls[0].body), {
    overrides: {
      taskCount: 1,
      containerOverrides: [
        {
          name: "worker",
          args: ["deno", "task", "worker", "--opaque=argument-secret"],
          env: [
            {
              name: "OXIAN_REGISTRATION_CAPABILITY",
              value: "environment-secret",
            },
            {
              name: "OXIAN_URL",
              value: "wss://control.example.test/_oxian/workers/connect",
            },
          ],
        },
      ],
      timeout: "3600s",
    },
  });
  assert.deepStrictEqual(tokens.signals.length, 1);
  assert.deepStrictEqual(resource, {
    providerId: "google-cloud-run-jobs",
    resourceId: OPERATION,
    identity: IDENTITY,
    createdAtMs: 1_700_000_000_000,
    attributes: {
      pool: "fast",
      cloudRunJob: `projects/${PROJECT}/locations/${LOCATION}/jobs/${JOB}`,
      cloudRunOperation: OPERATION,
      cloudRunExecution: EXECUTION,
    },
  });
  const persisted = JSON.stringify(resource);
  assert.deepStrictEqual(persisted.includes("test-access-token"), false);
  assert.deepStrictEqual(persisted.includes("environment-secret"), false);
  assert.deepStrictEqual(persisted.includes("argument-secret"), false);
  assert.deepStrictEqual(persisted.includes("control.example.test"), false);
  assert.deepStrictEqual(
    persisted.includes("OXIAN_REGISTRATION_CAPABILITY"),
    false,
  );
  assert.ok(Object.isFrozen(resource.attributes));
});

test("Cloud Run Jobs run omits the container override and timeout when they are absent", async () => {
  const fake = createFakeFetch(() =>
    jsonResponse({
      name: OPERATION,
      metadata: { name: EXECUTION },
    }),
  );
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
  });

  await provision(provider);

  assert.deepStrictEqual(JSON.parse(fake.calls[0].body), {
    overrides: {
      taskCount: 1,
    },
  });
});

test("Cloud Run Jobs rehydrates a durable resource without exposing private attribute names", () => {
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "unused",
  });

  const resource = provider.rehydrateResource({
    identity: IDENTITY,
    createdAtMs: 1_700_000_000_000,
    job: JOB,
    operationName: OPERATION,
    executionName: EXECUTION,
    attributes: {
      pool: "fast",
      cloudRunJob: "caller-cannot-overwrite-provider-state",
      cloudRunOperation: "caller-cannot-overwrite-provider-state",
      cloudRunExecution: "caller-cannot-overwrite-provider-state",
    },
  });

  assert.deepStrictEqual(resource, {
    providerId: "google-cloud-run-jobs",
    resourceId: OPERATION,
    identity: IDENTITY,
    createdAtMs: 1_700_000_000_000,
    attributes: {
      pool: "fast",
      cloudRunJob: `projects/${PROJECT}/locations/${LOCATION}/jobs/${JOB}`,
      cloudRunOperation: OPERATION,
      cloudRunExecution: EXECUTION,
    },
  });

  const error = assertThrows(
    () =>
      provider.rehydrateResource({
        identity: IDENTITY,
        createdAtMs: 1,
        job: JOB,
        operationName: OPERATION,
        executionName: `projects/other/locations/${LOCATION}/jobs/${JOB}/executions/e`,
      }),
    Error,
  );
  assertProviderErrorCode(error, "invalid_resource");
});

test("Cloud Run Jobs resolves execution identity from operation metadata or response", async () => {
  const secondOperation = `projects/${PROJECT}/locations/${LOCATION}/operations/run-operation-2`;
  const secondExecution = `projects/${PROJECT}/locations/${LOCATION}/jobs/${JOB}/executions/execution-2`;
  let launches = 0;
  const fake = createFakeFetch(() => {
    launches++;
    return launches === 1
      ? jsonResponse({
          name: OPERATION,
          metadata: { name: EXECUTION },
        })
      : jsonResponse({
          name: secondOperation,
          done: true,
          response: { name: secondExecution },
        });
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
  });

  const fromMetadata = await provision(provider);
  const fromResponse = await provider.provision({
    identity: {
      workerId: "cloud-worker-2",
      attemptId: "cloud-attempt-2",
      epoch: 1,
    },
    launch: { job: JOB },
  });

  assert.deepStrictEqual(fromMetadata.resourceId, OPERATION);
  assert.deepStrictEqual(fromMetadata.attributes.cloudRunExecution, EXECUTION);
  assert.deepStrictEqual(fromResponse.resourceId, secondOperation);
  assert.deepStrictEqual(
    fromResponse.attributes.cloudRunExecution,
    secondExecution,
  );
});

test("Cloud Run Jobs validates configuration and launch specs before authentication or I/O", async () => {
  const getAccessToken = () => "must-not-be-read";

  for (const options of [
    { project: "projects/other", location: LOCATION },
    { project: PROJECT, location: "us-central1/operations" },
    { project: "-invalid-project", location: LOCATION },
    { project: PROJECT, location: "US-CENTRAL1" },
  ]) {
    assertThrows(
      () =>
        createCloudRunJobsProvider({
          ...options,
          getAccessToken,
        }),
      TypeError,
    );
  }

  let tokenCalls = 0;
  const fake = createFakeFetch(() => {
    throw new Error("fetch must not be called");
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => {
      tokenCalls++;
      return "token";
    },
    fetcher: fake.fetcher,
  });
  const invalidLaunches = [
    { job: "Bad/Job" },
    { job: JOB, timeoutSeconds: 0 },
    {
      job: JOB,
      containerOverride: {
        env: { "INVALID=NAME": "value" },
      },
    },
    {
      job: JOB,
      containerOverride: {
        env: { VALID_NAME: "invalid\0value" },
      },
    },
    {
      job: JOB,
      containerOverride: {
        args: ["valid", 3],
      },
    },
  ] as unknown as CloudRunJobsLaunchSpec[];

  for (const launch of invalidLaunches) {
    const error = await assertRejects(() => provision(provider, launch), Error);
    assertProviderErrorCode(error, "invalid_launch_spec");
  }

  assert.deepStrictEqual(tokenCalls, 0);
  assert.deepStrictEqual(fake.calls.length, 0);
});

test("Cloud Run Jobs accepts only operation and execution names in the exact configured project and location", async () => {
  const foreignOperation = `projects/other-project/locations/${LOCATION}/operations/foreign`;
  const foreignExecution = `projects/${PROJECT}/locations/europe-west1/jobs/${JOB}/executions/foreign`;
  let response: unknown = {
    name: foreignOperation,
    metadata: { name: EXECUTION },
  };
  const fake = createFakeFetch(() => jsonResponse(response));
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
  });

  let error = await assertRejects(() => provision(provider), Error);
  assertProviderErrorCode(error, "provision_indeterminate");

  response = {
    name: OPERATION,
    metadata: { name: foreignExecution },
  };
  error = await assertRejects(() => provision(provider), Error);
  assertProviderErrorCode(error, "provision_indeterminate");
});

test("Cloud Run Jobs inspection maps pending, running, succeeded, failed, and cancelled executions", async () => {
  let operation: Record<string, unknown> = {
    name: OPERATION,
    done: false,
  };
  let execution: Record<string, unknown> = {
    name: EXECUTION,
  };
  const fake = createFakeFetch((call) => {
    if (call.url === RUN_URL && call.method === "POST") {
      return jsonResponse({
        name: OPERATION,
      });
    }
    if (call.url === OPERATION_URL && call.method === "GET") {
      return jsonResponse(operation);
    }
    if (call.url === EXECUTION_URL && call.method === "GET") {
      return jsonResponse(execution);
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
    now: () => 123,
  });
  const resource = await provision(provider);

  const pending = await provider.inspect(resource);
  assert.deepStrictEqual(pending.state, "present");
  assert.deepStrictEqual(pending.observedAtMs, 123);
  assert.deepStrictEqual(
    fake.calls.filter((call) => call.url === EXECUTION_URL).length,
    0,
  );

  operation = {
    name: OPERATION,
    metadata: { name: EXECUTION },
  };
  execution = {
    name: EXECUTION,
    runningCount: 1,
  };
  assert.deepStrictEqual((await provider.inspect(resource)).state, "present");

  execution = {
    name: EXECUTION,
    succeededCount: 1,
    completionTime: "2026-07-25T00:00:00Z",
  };
  assert.deepStrictEqual((await provider.inspect(resource)).state, "absent");

  execution = {
    name: EXECUTION,
    failedCount: 1,
  };
  assert.deepStrictEqual((await provider.inspect(resource)).state, "failed");

  execution = {
    name: EXECUTION,
    cancelledCount: 1,
    completionTime: "2026-07-25T00:01:00Z",
  };
  assert.deepStrictEqual((await provider.inspect(resource)).state, "absent");
});

test("Cloud Run Jobs inspection accepts real execution responses with short and canonical Job names", async () => {
  let responseJob = JOB;
  const fake = createFakeFetch((call) => {
    if (call.url === RUN_URL && call.method === "POST") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === OPERATION_URL && call.method === "GET") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === EXECUTION_URL && call.method === "GET") {
      return jsonResponse(realShapedExecution({ job: responseJob }));
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
    now: () => 234,
  });
  const resource = await provision(provider);

  const inspection = await provider.inspect(resource);

  assert.deepStrictEqual(inspection.state, "present");
  assert.deepStrictEqual(inspection.observedAtMs, 234);
  assert.deepStrictEqual(inspection.details.phase, "active");
  assert.deepStrictEqual(inspection.details.runningCount, 1);

  responseJob = `projects/${PROJECT}/locations/${LOCATION}/jobs/${JOB}`;
  assert.deepStrictEqual((await provider.inspect(resource)).state, "present");
});

test("Cloud Run Jobs inspection rejects execution responses naming any other Job", async () => {
  let responseJob: unknown = "another-job";
  const fake = createFakeFetch((call) => {
    if (call.url === RUN_URL && call.method === "POST") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === OPERATION_URL && call.method === "GET") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === EXECUTION_URL && call.method === "GET") {
      return jsonResponse(realShapedExecution({ job: responseJob }));
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
  });
  const resource = await provision(provider);

  for (const invalidJob of [
    "another-job",
    `projects/${PROJECT}/locations/${LOCATION}/jobs/another-job`,
    `locations/${LOCATION}/jobs/${JOB}`,
    "",
    42,
    null,
  ]) {
    responseJob = invalidJob;
    const error = await assertRejects(() => provider.inspect(resource), Error);
    assertProviderErrorCode(error, "inspection_failed");
    assert.deepStrictEqual(
      (error as Error & { cause?: unknown }).cause instanceof TypeError,
      true,
    );
  }
});

test("Cloud Run Jobs termination is confirmed, idempotent, and cancels exactly once", async () => {
  let cancelled = false;
  let cancelCalls = 0;
  const fake = createFakeFetch((call) => {
    if (call.url === RUN_URL && call.method === "POST") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === OPERATION_URL && call.method === "GET") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === EXECUTION_URL && call.method === "GET") {
      return jsonResponse(
        cancelled
          ? {
              name: EXECUTION,
              cancelledCount: 1,
              completionTime: "2026-07-25T00:00:00Z",
            }
          : {
              name: EXECUTION,
              runningCount: 1,
            },
      );
    }
    if (call.url === CANCEL_URL && call.method === "POST") {
      cancelCalls++;
      cancelled = true;
      assert.deepStrictEqual(call.body, "{}");
      return jsonResponse({
        name: CANCEL_OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
    now: () => 456,
  });
  const resource = await provision(provider);

  const first = await provider.terminate(resource);
  const repeated = await provider.terminate(resource);

  assert.deepStrictEqual(first.outcome, "terminated");
  assert.deepStrictEqual(first.observedAtMs, 456);
  assert.deepStrictEqual(first.details.cancellationOperation, CANCEL_OPERATION);
  assert.deepStrictEqual(repeated.outcome, "already_absent");
  assert.deepStrictEqual(cancelCalls, 1);
});

test("Cloud Run Jobs termination accepts real execution responses with their short Job ID", async () => {
  let executionReads = 0;
  let cancelCalls = 0;
  const fake = createFakeFetch((call) => {
    if (call.url === RUN_URL && call.method === "POST") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === OPERATION_URL && call.method === "GET") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === EXECUTION_URL && call.method === "GET") {
      executionReads++;
      return jsonResponse(
        executionReads === 1
          ? realShapedExecution()
          : realShapedExecution({
              runningCount: undefined,
              cancelledCount: 1,
              completionTime: "2026-07-28T00:00:02.000000Z",
              conditions: [
                {
                  type: "Completed",
                  state: "CONDITION_FAILED",
                  reason: "Cancelled",
                  message: "Execution cancelled.",
                  lastTransitionTime: "2026-07-28T00:00:02.000000Z",
                },
              ],
            }),
      );
    }
    if (call.url === CANCEL_URL && call.method === "POST") {
      cancelCalls++;
      assert.deepStrictEqual(call.body, "{}");
      return jsonResponse({
        name: CANCEL_OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
    now: () => 567,
  });
  const resource = await provision(provider);

  const termination = await provider.terminate(resource);

  assert.deepStrictEqual(termination.outcome, "terminated");
  assert.deepStrictEqual(termination.observedAtMs, 567);
  assert.deepStrictEqual(termination.details.phase, "cancelled");
  assert.deepStrictEqual(
    termination.details.cancellationOperation,
    CANCEL_OPERATION,
  );
  assert.deepStrictEqual(executionReads, 2);
  assert.deepStrictEqual(cancelCalls, 1);
});

test("Cloud Run Jobs pre-aborted operations perform no token lookup or HTTP I/O", async () => {
  let tokenCalls = 0;
  const fake = createFakeFetch((call) => {
    if (call.url === RUN_URL) {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => {
      tokenCalls++;
      return "token";
    },
    fetcher: fake.fetcher,
  });
  const resource = await provision(provider);
  const callsBeforeAbortChecks = fake.calls.length;
  const tokensBeforeAbortChecks = tokenCalls;

  for (const operation of [
    (signal: AbortSignal) =>
      provider.provision(
        { identity: IDENTITY, launch: { job: JOB } },
        { signal },
      ),
    (signal: AbortSignal) => provider.inspect(resource, { signal }),
    (signal: AbortSignal) => provider.terminate(resource, { signal }),
  ]) {
    const controller = new AbortController();
    controller.abort();
    await assertRejects(
      () => operation(controller.signal),
      DOMException,
      "aborted",
    );
  }

  assert.deepStrictEqual(fake.calls.length, callsBeforeAbortChecks);
  assert.deepStrictEqual(tokenCalls, tokensBeforeAbortChecks);
});

test("Cloud Run Jobs never retries an ambiguous launch and returns a typed indeterminate error", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => {
      tokenCalls++;
      return "token";
    },
    fetcher: (() => {
      fetchCalls++;
      throw new TypeError("connection reset after request upload");
    }) as typeof fetch,
  });

  const error = await assertRejects(() => provision(provider), Error);

  assertProviderErrorCode(error, "provision_indeterminate");
  assert.deepStrictEqual(tokenCalls, 1);
  assert.deepStrictEqual(fetchCalls, 1);
  assert.deepStrictEqual((error as Error).cause instanceof TypeError, true);
});

test("Cloud Run Jobs bounds API bodies while streaming", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(262_145));
    },
    cancel() {
      cancelled = true;
    },
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: (() =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch,
  });

  const error = await assertRejects(() => provision(provider), Error);

  assertProviderErrorCode(error, "provision_indeterminate");
  assert.deepStrictEqual(cancelled, true);
});

test("Cloud Run Jobs passes generic provider conformance against a deterministic fake API", async () => {
  let cancelled = false;
  let runCalls = 0;
  let cancelCalls = 0;
  let clock = 1_000;
  const fake = createFakeFetch((call) => {
    if (call.url === RUN_URL && call.method === "POST") {
      runCalls++;
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === OPERATION_URL && call.method === "GET") {
      return jsonResponse({
        name: OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    if (call.url === EXECUTION_URL && call.method === "GET") {
      return jsonResponse(
        cancelled
          ? {
              name: EXECUTION,
              cancelledCount: 1,
              completionTime: "2026-07-25T00:00:00Z",
            }
          : {
              name: EXECUTION,
              runningCount: 1,
            },
      );
    }
    if (call.url === CANCEL_URL && call.method === "POST") {
      cancelCalls++;
      cancelled = true;
      return jsonResponse({
        name: CANCEL_OPERATION,
        metadata: { name: EXECUTION },
      });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const provider = createCloudRunJobsProvider({
    project: PROJECT,
    location: LOCATION,
    getAccessToken: () => "token",
    fetcher: fake.fetcher,
    now: () => clock++,
  });

  const report = await runProviderConformance({
    provider,
    identity: IDENTITY,
    launch: {
      job: JOB,
      attributes: {
        tier: "conformance",
      },
    },
  });

  assert.deepStrictEqual(report.checks, [
    "pre-aborted provision",
    "provision",
    "resource identity",
    "session-independent resource",
    "inspect present",
    "pre-aborted inspect",
    "pre-aborted terminate",
    "terminate",
    "inspect absent",
    "idempotent terminate",
  ]);
  assert.deepStrictEqual(report.initialInspection.state, "present");
  assert.deepStrictEqual(report.termination.outcome, "terminated");
  assert.deepStrictEqual(report.finalInspection.state, "absent");
  assert.deepStrictEqual(report.repeatedTermination.outcome, "already_absent");
  assert.deepStrictEqual(report.resource.attributes.tier, "conformance");
  assert.deepStrictEqual(runCalls, 1);
  assert.deepStrictEqual(cancelCalls, 1);
});
