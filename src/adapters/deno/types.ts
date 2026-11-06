import type { ConnectionBudget } from "../../http/connection-budget.ts";
import type {
  HypervisorHost,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";

export type DenoServeOptions = Readonly<{
  /** A Hypervisor, or a front whose `prepare` may resolve asynchronously. */
  hypervisor: HypervisorHost;
  budget?: ConnectionBudget;
}> &
  HypervisorListenOptions;
