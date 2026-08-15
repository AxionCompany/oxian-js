import type {
  Hypervisor,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";

export type DenoServeOptions =
  & Readonly<{
    hypervisor: Hypervisor;
  }>
  & HypervisorListenOptions;
