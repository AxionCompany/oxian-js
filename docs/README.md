# 📚 Oxian Documentation

Welcome to the Oxian-js documentation. This guide will help you master every aspect of building enterprise-grade APIs with Oxian.

## 🚀 Getting Started

- [**Getting Started**](./getting-started.md) - Installation, first project, and quick setup

### Init command

Initialize configuration and helper files with interactive prompts:

```bash
deno -A jsr:@oxian/oxian-js init
```

Creates or updates:
- `oxian.config.json` (prompts for port, routesDir, logging level)
- `deno.json` (with `dev`, `start`, `routes` tasks)
- `llm.txt`

For existing files, choose per-file: [a]ppend (merge for JSON, append for text), [o]verwrite, or [c]ancel.

## 🏗️ Core Concepts

- [**Routing**](./routing.md) - File-based routing, dynamic routes, catch-all patterns
- [**Handlers**](./handlers.md) - Handler signatures, data/context, response patterns
- [**Dependency Injection**](./dependency-injection.md) - File-based DI, composition, patterns
- [**Middleware**](./middleware.md) - Request/response processing, authentication
- [**Interceptors**](./interceptors.md) - Before/after hooks, cross-cutting concerns

## 🌊 Advanced Features

- [**Streaming & SSE**](./streaming-and-sse.md) - Real-time data, streaming responses
- [**Hypervisor**](./hypervisor.md) - Multi-process scaling, load balancing
- [**Loaders**](./loaders.md) - Local and remote execution, GitHub integration
- [**Error Handling**](./error-handling.md) - Error patterns, HTTP errors, global handling

## ⚙️ Configuration & Deployment

- [**Configuration**](./configuration.md) - Config files, environment variables
- [**CLI**](./cli.md) - Command line interface, development tools
- [**Deployment**](./deployment.md) - Production deployment, Docker, scaling

## 📖 Reference & Best Practices

- [**API Reference**](./api-reference.md) - Complete TypeScript API documentation
- [**Best Practices**](./best-practices.md) - Patterns, performance, security

## 🎯 Examples

- [**Example Projects**](../examples/) - Complete example applications

---

## Quick Links

- 🏠 [Main README](../README.md)
- 📦 [JSR Package](https://jsr.io/@oxian/oxian-js)
- 🐛 [Issues & Bugs](https://github.com/oxian-org/oxian-js/issues)
- 💬 [Discussions](https://github.com/oxian-org/oxian-js/discussions)
- 🆘 [Support](https://discord.gg/oxian)

---

*Need help? Check our [troubleshooting guide](./troubleshooting.md) or join our [Discord community](https://discord.gg/oxian).*
