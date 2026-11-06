import type { ConnectionBudget } from "./connection-budget.ts";
import type {
  HypervisorHost,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";

export type NodeServeOptions = Readonly<{
  /** A Hypervisor, or a front whose `prepare` may resolve asynchronously. */
  hypervisor: HypervisorHost;
  /** Each accepted upgrade takes one connection from this shared budget. */
  budget?: ConnectionBudget;
}> &
  HypervisorListenOptions;
