## Using Oxian with Vite

This guide shows how to run Oxian alongside a Vite frontend in both development and production.

### Goals

- Keep a single public port exposed by Oxian in dev and prod
- Route API traffic under `/api` (configurable)
- In dev: proxy non-API requests to the Vite dev server
- In prod: serve static files from `dist/` when no API route matches

---

### Development

1) Start Vite (default `http://localhost:5173`):

```bash
npm run dev
```

2) Configure Oxian to serve APIs on `/api` and proxy everything else to Vite:

```json
// oxian.config.json
{
  "server": { "port": 8080 },
  "basePath": "/api",
  "routing": { "routesDir": "routes", "discovery": "lazy" },
  "runtime": {
    "hv": {
      "web": {
        "devProxyTarget": "http://localhost:5173"
      }
    }
  }
}
```

- Your frontend can fetch the API at `/api/...` (same-origin).
- Navigations and assets are served by Vite via the proxy.

---

### Production

1) Build your frontend:

```bash
npm run build
```

2) Configure Oxian to serve static files from the build output as fallback for non-API routes:

```json
// oxian.config.json
{
  "server": { "port": 8080 },
  "basePath": "/api",
  "runtime": {
    "hv": {
      "web": {
        "staticDir": "dist",
        "staticCacheControl": "public, max-age=31536000, immutable"
      }
    }
  }
}
```

Behavior:
- API requests under `/api` hit Oxian routes.
- Other paths attempt to resolve from `dist/`.
- If a file isn’t found (and no `staticDir` is configured), Oxian returns 404.

---

### Recommended project layout

```
my-app/
├── oxian.config.json
├── routes/                 # your Oxian API
│   ├── dependencies.ts
│   ├── middleware.ts
│   └── api/
│       └── users/
│           └── [id].ts
├── index.html              # Vite app
├── src/
│   └── main.ts
└── dist/                   # Vite build output (prod)
```

---

### Notes

- The hypervisor supports blue/green restarts and a short in-memory queue to reduce downtime during worker restarts.
- For monorepos, you can run Oxian in the workspace root and point `routing.routesDir` to your API folder.
- If you prefer to keep Vite as the primary dev server, you can also set up Vite’s proxy to forward `/api` → Oxian. The approach above keeps Oxian as the single entry point instead.


