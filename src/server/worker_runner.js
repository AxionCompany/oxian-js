self.onmessage = async (e) => {
  const { port, cfgPath, source } = e.data;
  const { loadConfig } = await import("../config/load.ts");
  const { startServer } = await import("./server.ts");
  const cfg = await loadConfig({ configPath: cfgPath });
  cfg.server = cfg.server ?? {};
  cfg.server.port = port;
  await startServer({ config: cfg, source });
}; 