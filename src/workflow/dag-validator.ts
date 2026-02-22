import type { WorkflowDefinition } from "./types.js";
import { isSubworkflowStep } from "./types.js";

export interface ValidationError {
  stepId?: string;
  field: string;
  message: string;
}

/**
 * Validate a workflow's DAG structure.
 * Returns an array of validation errors (empty array means valid).
 */
export function validateDag(workflow: WorkflowDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const stepIds = new Set(Object.keys(workflow.steps));

  for (const [stepId, step] of Object.entries(workflow.steps)) {
    // Reference integrity: depends_on step IDs must exist
    if (step.depends_on) {
      for (const dep of step.depends_on) {
        if (!stepIds.has(dep)) {
          errors.push({
            stepId,
            field: "depends_on",
            message: `Step "${stepId}" depends on unknown step "${dep}"`,
          });
        }
      }
    }

    // Input integrity: inputs[].from must be in depends_on
    if (step.inputs) {
      const depsSet = new Set(step.depends_on ?? []);
      for (const input of step.inputs) {
        if (!depsSet.has(input.from)) {
          errors.push({
            stepId,
            field: "inputs",
            message: `Step "${stepId}" references input from "${input.from}" which is not in depends_on`,
          });
        }
      }
    }

    // Output name uniqueness within a step + path traversal validation
    if (step.outputs) {
      const seen = new Set<string>();
      for (const output of step.outputs) {
        if (seen.has(output.name)) {
          errors.push({
            stepId,
            field: "outputs",
            message: `Step "${stepId}" has duplicate output name "${output.name}"`,
          });
        }
        seen.add(output.name);

        // Reject paths that attempt traversal or are absolute
        if (output.path.includes("..") || output.path.startsWith("/")) {
          errors.push({
            stepId,
            field: "outputs",
            message: `Step "${stepId}" output "${output.name}" has unsafe path "${output.path}" (must be relative without "..")`,
          });
        }
      }
    }

    // completion_check integrity: max_iterations must be >= 2
    if (step.completion_check) {
      const maxIter = step.max_iterations;
      if (maxIter === undefined || maxIter < 2) {
        errors.push({
          stepId,
          field: "completion_check",
          message: `Step "${stepId}" has completion_check but max_iterations is ${maxIter ?? "undefined"} (must be >= 2)`,
        });
      }
    }

    // Subworkflow: exports `as` name uniqueness
    if (isSubworkflowStep(step) && step.exports) {
      const seen = new Set<string>();
      for (const exp of step.exports) {
        const name = exp.as ?? exp.artifact;
        if (seen.has(name)) {
          errors.push({
            stepId,
            field: "exports",
            message: `Step "${stepId}" has duplicate export name "${name}"`,
          });
        }
        seen.add(name);
      }
    }
  }

  // Cycle detection via topological sort (Kahn's algorithm)
  const cycleErrors = detectCycles(workflow);
  errors.push(...cycleErrors);

  return errors;
}

function detectCycles(workflow: WorkflowDefinition): ValidationError[] {
  const stepIds = Object.keys(workflow.steps);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const id of stepIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  // Build graph
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.depends_on) {
      for (const dep of step.depends_on) {
        // Only count edges to known steps (reference errors are caught separately)
        if (inDegree.has(dep)) {
          adjacency.get(dep)!.push(stepId);
          inDegree.set(stepId, (inDegree.get(stepId) ?? 0) + 1);
        }
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    const neighbors = adjacency.get(current);
    if (neighbors) {
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }
  }

  if (visited < stepIds.length) {
    // Find the steps involved in cycles
    const inCycle = stepIds.filter((id) => (inDegree.get(id) ?? 0) > 0);
    return [
      {
        field: "depends_on",
        message: `Workflow contains a cycle involving steps: ${inCycle.join(", ")}`,
      },
    ];
  }

  return [];
}
