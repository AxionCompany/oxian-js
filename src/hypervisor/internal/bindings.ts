import type { Hypervisor } from "../types.ts";
import type {
  InProcessExecution,
  InProcessWorker,
  InProcessWorkerInput,
} from "./in-process-types.ts";

const executions = new WeakMap<Hypervisor, InProcessExecution>();

export function registerInProcessExecution(
  hypervisor: Hypervisor,
  execution: InProcessExecution,
): void {
  executions.set(hypervisor, execution);
}

export function connectInProcessWorker(
  hypervisor: Hypervisor,
  worker: InProcessWorkerInput,
): InProcessWorker {
  const execution = executions.get(hypervisor);
  if (execution === undefined) {
    throw new TypeError("transport.hypervisor is not an Oxian Hypervisor");
  }
  return execution.attach(worker);
}
