import type { OwnerHost } from "../../host/types.ts";
import type {
  Hypervisor,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";

export type NodeServeOptions = Readonly<{
  hypervisor: Hypervisor;
  /** Each accepted upgrade takes one connection from this host. */
  budget?: OwnerHost;
}> &
  HypervisorListenOptions;
