# `jsr:@oxian/oxian-js@0.20.0-rc.5/config`

[Back to the API reference](../api-reference.md)

The `/config` subpath defines Oxian's code-first application and gateway
configuration. It accepts data, validates exact owned boundaries, fills
defaults, normalizes values, and returns an immutable result.

```ts
import {
  DEFAULT_OXIAN_CONFIG,
  defineConfig,
  loadConfig,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/config";
```

Worker manifests, credentials, provider launch specifications, secrets, logging
policy, and durable application state are deliberately not part of this
configuration.

## Export summary

### Values

| Export                 | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `DEFAULT_OXIAN_CONFIG` | Fully normalized default application and gateway data. |
| `defineConfig`         | Validate and normalize an in-memory config value.      |
| `loadConfig`           | Import and normalize one local `.ts` config module.    |

### Types

| Input type                | Normalized type      |
| ------------------------- | -------------------- |
| `OxianConfigInput`        | `OxianConfig`        |
| `ApplicationConfigInput`  | `ApplicationConfig`  |
| `GatewayConfigInput`      | `GatewayConfig`      |
| `HttpListenerConfigInput` | `HttpListenerConfig` |
| `EdgeConfigInput`         | `EdgeConfig`         |
| `CorsConfigInput`         | `CorsConfig`         |
| `StaticConfigInput`       | `StaticConfig`       |
| `DevProxyConfigInput`     | `DevProxyConfig`     |

`LocalWorkerTransport` and `LoadConfigSource` are the remaining exported types.

## `defineConfig`

```ts
function defineConfig(input: OxianConfigInput): OxianConfig;
```

`defineConfig` validates synchronously. It does not mutate `input`; normalized
objects and arrays are new and recursively frozen.

```ts
import { defineConfig } from "jsr:@oxian/oxian-js@0.20.0-rc.5/config";

export default defineConfig({
  application: {
    routesRoot: "./routes",
    basePath: "/api",
    factory: "./application.ts",
  },
  gateway: {
    listener: {
      hostname: "127.0.0.1",
      port: 8_000,
    },
    edge: {
      cors: {
        origins: ["https://console.example"],
        credentials: true,
      },
      static: {
        root: "./public",
        prefix: "/assets",
      },
    },
  },
});
```

Relative filesystem paths remain relative when using `defineConfig` directly.
`loadConfig` resolves them against the loaded module instead.

### Exact-data validation

Every configuration boundary must be a plain object with `Object.prototype`.
Oxian rejects:

- unknown or symbol keys;
- getters, setters, and non-enumerable properties;
- class instances, arrays where objects are expected, functions, and `null`;
- sparse string arrays or arrays with custom properties;
- invalid field values and invalid relationships between Hypervisor limits.

Configuration does not merge arbitrary objects or expand environment tokens. Use
ordinary TypeScript before calling `defineConfig` when values need to be
computed.

## Top-level types

```ts
type OxianConfigInput = Readonly<{
  application?: ApplicationConfigInput;
  gateway?: GatewayConfigInput;
}>;

type OxianConfig = Readonly<{
  application: ApplicationConfig;
  gateway: GatewayConfig;
}>;
```

Both input sections are optional. An empty input is equivalent by value to
`DEFAULT_OXIAN_CONFIG`.

## Application configuration

```ts
type ApplicationConfigInput = Readonly<{
  routesRoot?: string;
  basePath?: string;
  factory?: string;
}>;

type ApplicationConfig = Readonly<{
  routesRoot: string;
  basePath: string;
  factory?: string;
}>;
```

| Field        | Default      | Normalization and validation                                       |
| ------------ | ------------ | ------------------------------------------------------------------ |
| `routesRoot` | `"./routes"` | Local filesystem path or `file:` URL string; null bytes forbidden. |
| `basePath`   | `"/"`        | Canonical application mount path.                                  |
| `factory`    | absent       | Local `.ts` filesystem path or `file:` URL string.                 |

`basePath` accepts `/` or slash-separated ASCII segments containing letters,
digits, `.`, `_`, `~`, or `-`. Empty, `.`, `..`, percent-escaped, Unicode, and
trailing-slash forms are rejected. A factory file URL must be local, and the
source must end in `.ts`.

When `loadConfig` is used, relative `routesRoot` and `factory` paths become
absolute paths based on the directory containing the config module.

## Gateway and listener configuration

```ts
type HttpListenerConfigInput = Readonly<{
  hostname?: string;
  port?: number;
}>;

type HttpListenerConfig = Readonly<{
  hostname: string;
  port: number;
}>;
```

`hostname` defaults to `"127.0.0.1"` and must be a bare hostname or IP address,
without whitespace, a scheme, user information, path, query, or fragment. `port`
defaults to `8000` and must be a safe integer from `0` through `65535`; zero
permits ephemeral binding.

```ts
type GatewayConfigInput = Readonly<{
  listener?: HttpListenerConfigInput;
  workerTransport?: LocalWorkerTransport;
  hypervisor?: Partial<HypervisorConfig>;
  edge?: EdgeConfigInput;
}>;

type GatewayConfig = Readonly<{
  listener: HttpListenerConfig;
  workerTransport: LocalWorkerTransport;
  hypervisor: HypervisorConfig;
  edge?: EdgeConfig;
}>;
```

```ts
type LocalWorkerTransport = "in-process" | "worker-websocket";
```

`workerTransport` controls the local worker created by `oxian dev`,
`oxian start`, and `createLocalRuntime`. It defaults to `"in-process"`, which
attaches the HTTP workload directly to an embeddable `WorkerHost` without a
loopback socket. `"worker-websocket"` preserves the previous outbound loopback
worker topology for wire-protocol integration testing. This setting does not
change separately deployed manifest workers, which continue to use WSS.

`HypervisorConfig` is defined by the `/hypervisor` subpath. The input accepts a
partial value, fills every omitted field from the Hypervisor defaults, and
applies the same bounds and cross-field validation as `createHypervisorConfig`.
Explicit `null` is never treated as omission.

## Edge configuration

`EdgeConfigInput` is the data-only counterpart of the code-defined adapters in
the `/edge` subpath. Predicates and metadata callbacks stay in application
composition rather than serialized configuration.

```ts
type EdgeConfigInput = Readonly<{
  cors?: CorsConfigInput;
  static?: StaticConfigInput;
  devProxy?: DevProxyConfigInput;
}>;

type EdgeConfig = Readonly<{
  cors?: CorsConfig;
  static?: StaticConfig;
  devProxy?: DevProxyConfig;
}>;
```

If `gateway.edge` is absent, normalized `GatewayConfig.edge` is absent. If an
empty edge object is supplied, it remains a present, frozen empty object.

### CORS

```ts
type CorsConfigInput = Readonly<{
  origins: "*" | readonly string[];
  methods?: readonly string[];
  headers?: readonly string[];
  exposeHeaders?: readonly string[];
  credentials?: boolean;
  maxAgeSeconds?: number;
}>;

type CorsConfig = Readonly<{
  origins: "*" | readonly string[];
  methods: readonly string[];
  headers: readonly string[];
  exposeHeaders: readonly string[];
  credentials: boolean;
  maxAgeSeconds?: number;
}>;
```

`origins` is required. It accepts `*`, exact serialized HTTP(S) origins such as
`https://example.com`, or the serialized opaque origin `"null"`. Paths, queries,
and fragments are not origins. Duplicate entries are removed.

| Field           | Default                                        | Normalization                          |
| --------------- | ---------------------------------------------- | -------------------------------------- |
| `methods`       | `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS` | Valid HTTP tokens, uppercase, deduped. |
| `headers`       | `[]`                                           | Valid HTTP tokens, lowercase, deduped. |
| `exposeHeaders` | `[]`                                           | Valid HTTP tokens, lowercase, deduped. |
| `credentials`   | `false`                                        | Must be boolean.                       |
| `maxAgeSeconds` | absent                                         | Non-negative safe integer.             |

Wildcard origins cannot be combined with credentials.

### Static files

```ts
type StaticConfigInput = Readonly<{
  root: string;
  prefix?: string;
  index?: string | readonly string[] | false;
  cacheControl?: string;
  fallthrough?: boolean;
}>;

type StaticConfig = Readonly<{
  root: string;
  prefix: string;
  index: readonly string[];
  cacheControl?: string;
  fallthrough: boolean;
}>;
```

`root` is required and accepts a local filesystem path or `file:` URL string.
Relative roots are resolved against the module directory by `loadConfig`.
Existence and directory access are checked later when the static adapter is
created.

| Field          | Default          | Normalization and validation                            |
| -------------- | ---------------- | ------------------------------------------------------- |
| `prefix`       | `"/"`            | Absolute URL path; trailing slashes removed.            |
| `index`        | `["index.html"]` | String becomes one item; `false` becomes `[]`; deduped. |
| `cacheControl` | absent           | Non-empty string without CR or LF.                      |
| `fallthrough`  | `true`           | Must be boolean.                                        |

Index entries must be non-empty relative paths with no backslashes, empty
segments, `.` segments, or `..` segments. Prefixes must not contain queries,
fragments, backslashes, null bytes, or traversal segments.

### Development proxy

```ts
type DevProxyConfigInput = Readonly<{
  upstream: string;
  prefix?: string;
  stripPrefix?: boolean;
  forwardHost?: boolean;
}>;

type DevProxyConfig = Readonly<{
  upstream: string;
  prefix: string;
  stripPrefix: boolean;
  forwardHost: boolean;
}>;
```

`upstream` is required. It must be an absolute `http:` or `https:` URL with no
credentials, query, or fragment. It is normalized through `URL`, so
`http://127.0.0.1:5173` becomes `http://127.0.0.1:5173/`.

`prefix` defaults to `/` and follows the same URL-path validation described for
static files. `stripPrefix` and `forwardHost` both default to `false`.

## `DEFAULT_OXIAN_CONFIG`

```ts
const DEFAULT_OXIAN_CONFIG: OxianConfig;
```

The constant is deeply frozen. Its application, listener, and edge defaults are:

```ts
{
  application: {
    routesRoot: "./routes",
    basePath: "/",
  },
  gateway: {
    listener: {
      hostname: "127.0.0.1",
      port: 8_000,
    },
    workerTransport: "in-process",
    // `hypervisor` contains every default listed below.
    // `edge` is absent.
  },
}
```

Its normalized Hypervisor fields are:

| Field                                  | Default                     |
| -------------------------------------- | --------------------------- |
| `workerPath`                           | `"/_oxian/workers/connect"` |
| `handshakeTimeoutMs`                   | `10_000`                    |
| `readyTimeoutMs`                       | `300_000`                   |
| `heartbeatIntervalMs`                  | `10_000`                    |
| `leaseTimeoutMs`                       | `30_000`                    |
| `leaseSweepIntervalMs`                 | `1_000`                     |
| `shutdownTimeoutMs`                    | `30_000`                    |
| `cancellationAckTimeoutMs`             | `10_000`                    |
| `maxConnectionAgeMs`                   | `3_000_000`                 |
| `proactiveDrainMarginMs`               | `60_000`                    |
| `maxConnections`                       | `10_000`                    |
| `maxUnauthenticatedConnections`        | `128`                       |
| `maxAuthenticatedConnections`          | `10_000`                    |
| `maxPendingAcceptanceCommits`          | `1_024`                     |
| `maxPendingAcceptanceCommitsPerWorker` | `64`                        |
| `maxInboundMessages`                   | `256`                       |
| `maxInboundBytes`                      | `16_777_216`                |
| `maxBufferedAmountBytes`               | `4_194_304`                 |
| `maxWorkerCapacity`                    | `1_024`                     |
| `maxLifetimeStreams`                   | `65_536`                    |
| `maxDataPayloadBytes`                  | `1_048_576`                 |
| `maxReceiveCreditBytes`                | `16_777_216`                |

The `/hypervisor` reference defines the bounds and relationships among those
fields.

## `loadConfig`

```ts
type LoadConfigSource = string | URL;

function loadConfig(
  source?: LoadConfigSource,
): Promise<OxianConfig>;
```

`source` defaults to `"./oxian.config.ts"`. A source must resolve to a local
`file:` TypeScript module ending in `.ts`, without a query or fragment.

The module must have exactly one runtime export:

```ts
// oxian.config.ts
import { defineConfig } from "jsr:@oxian/oxian-js@0.20.0-rc.5/config";

export default defineConfig({
  application: { routesRoot: "./routes" },
});
```

The named form is equivalent:

```ts
// oxian.config.ts
import { defineConfig } from "jsr:@oxian/oxian-js@0.20.0-rc.5/config";

export const config = defineConfig({
  application: { routesRoot: "./routes" },
});
```

The module may export `default` or named `config`, never both, and may not have
another runtime export. Its selected value must be configuration data, not a
factory function. Type-only exports do not exist at runtime and therefore do not
conflict with this rule.

After import, `loadConfig` performs the full `defineConfig` normalization with
the config module's directory as the path base. Specifically,
`application.routesRoot`, `application.factory`, and `gateway.edge.static.root`
resolve from that directory. No directory search, config inheritance,
environment substitution, or merge occurs.

Invalid source selection, export shape, or configuration rejects with
`TypeError`. Filesystem, dynamic-import, parse, and module-evaluation failures
reject unchanged.
