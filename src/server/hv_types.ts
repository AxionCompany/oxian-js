export type HvProvider = {
  pickProject: (req: Request) => Promise<{ project: string; stripPathPrefix?: string } | { project: string }> | { project: string; stripPathPrefix?: string } | { project: string };
  getProjectConfig?: (name: string) => Promise<Partial<ProjectRuntime>> | Partial<ProjectRuntime>;
  admission?: (req: Request, project: string) => Promise<void> | void; // throw to reject
};

export type ProjectRuntime = {
  name: string;
  source?: string; // future: support per-project source
  config?: Record<string, unknown>; // shallow overrides merged with root config
  worker?: {
    kind?: "process" | "thread"; // future: "isolate"
    pool?: { min?: number; max?: number; idleTtlMs?: number };
  };
}; 