import type {
  Hypervisor,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";

export type NodeServeOptions =
  & Readonly<{
    hypervisor: Hypervisor;
  }>
  & HypervisorListenOptions;
