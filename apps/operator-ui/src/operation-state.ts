import type { Operation, Resource } from './contracts.js';

export function conflicts(operations: Operation[], resources: Resource[]): boolean {
  return operations.some(
    (operation) =>
      operation.state === 'pending' &&
      operation.resources.some((resource) => resources.includes(resource)),
  );
}

export function replaceOperation(operations: Operation[], update: Operation): Operation[] {
  return [...operations.filter((operation) => operation.id !== update.id), update];
}
