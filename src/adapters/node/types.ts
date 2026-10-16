import type { ConnectionBudget } from "./connection-budget.ts";
import type {
  Hypervisor,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";

export type NodeServeOptions = Readonly<{
  hypervisor: Hypervisor;
  /** Each accepted upgrade takes one connection from this shared budget. */
  budget?: ConnectionBudget;
}> &
  HypervisorListenOptions;
