import type {
  Hypervisor,
  HypervisorListener,
  HypervisorListenOptions,
  HypervisorOptions,
} from "../../hypervisor/types.ts";

export type DenoHypervisorOptions = HypervisorOptions;

export type DenoHypervisor =
  & Hypervisor
  & Readonly<{
    fetch(request: Request): Response | Promise<Response>;
    listen(options?: HypervisorListenOptions): HypervisorListener;
  }>;
