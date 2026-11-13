// Race wave role schedule. Index i is the request slot, the client slot and the
// packet slot of roles[i], so every consumer must read the same array.
// Upstream's indices for the filler roles are filler0 7, filler1 8, release 9, guard0 10.
const BASE_ROLES = Object.freeze(['commit', 'hole', 'tail0', 'tail1', 'tail2', 'tail3', 'canary',
  'release', 'guard1', 'trigger']);
const FILLER_ROLES = Object.freeze(['commit', 'hole', 'tail0', 'tail1', 'tail2', 'tail3', 'canary',
  'filler0', 'filler1', 'release', 'guard0', 'guard1', 'trigger']);

function waveRoles(fillerRoles = false) {
  return [...(fillerRoles ? FILLER_ROLES : BASE_ROLES)];
}

// DIAGNOSTIC (off by default): NS2_DIAG_FILLER_ROLES=1 restores the filler0, filler1 and
// guard0 roles that the compact setup dropped. Tested on Layout A only.
function diagnosticFillerRoles(value, layoutC) {
  if (value === undefined || value === '' || value === '0') return false;
  if (value !== '1') throw Error('Unsupported filler-roles value ' + value);
  if (layoutC) throw Error('Filler roles are tested on Layout A only');
  return true;
}

module.exports = {waveRoles, diagnosticFillerRoles, BASE_ROLES, FILLER_ROLES};
