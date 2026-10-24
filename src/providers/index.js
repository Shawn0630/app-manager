// Provider registry: look up a deployment provider by name.
// v1 ships only builtin; register a Jenkins provider here when adding
// one (see the header comment in builtin.js).
import * as builtin from './builtin.js';

const registry = {
  builtin,
};

export function getProvider(name) {
  return registry[name] || builtin;
}
