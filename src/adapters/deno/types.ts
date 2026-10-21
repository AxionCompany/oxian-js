import type { ConnectionBudget } from "../../http/connection-budget.ts";
import type {
  Hypervisor,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";

export type DenoServeOptions = Readonly<{
  hypervisor: Hypervisor;
  budget?: ConnectionBudget;
}> &
  HypervisorListenOptions;
