// src/sim/process.js
// Minimal process (crafting/invention) and structure (building) system
// Designed to be drop-in and progressively wired into the Simulation.
// Exports registries and helper functions agents and sim can call.

// NOTE: this module is intentionally dependency-light. It expects the caller
// (Simulation or agent code) to pass a deterministic RNG function (e.g.
// sim.rng.bind(sim)) when random numbers are needed so the global seed stays
// consistent. If none is provided, Math.random is used.

// Example usage (in sim/agent or sim.js):
// import * as Proc from './process.js';
// Proc.registerStructureType({ id: 'hut', name: 'Hut', buildCost: [{type:'wood',qty:6}], shelterValue:0.6, maxCondition:100 });
// Proc.registerProcess({ id: 'sharpen', name: 'Sharpen', inputs:[{type:'stone',qty:1},{type:'wood',qty:1}], baseTime:3, difficulty:0.2, outputTemplate:{ type:'knife', properties:{cutting:0.4, durability:30} } });
// Proc.tryBuildStructure(sim, agent, 'hut', footprintTiles, rng);
// const out = Proc.tryRunProcess(sim, agent, 'sharpen', providedInputs, location, rng);

export const StructureRegistry = new Map();
export const ProcessRegistry = new Map();

export function registerStructureType(spec) {
  // spec: { id, name, buildCost:[{type,qty}], shelterValue, requiredTools:[], maxCondition }
  if (!spec || !spec.id) throw new Error('invalid structure spec');
  StructureRegistry.set(spec.id, Object.assign({ requiredTools: [], maxCondition: 100 }, spec));
}

export function registerProcess(spec) {
  // spec: { id, name, inputs:[{type,qty}], baseTime, difficulty(0-1), requiredStructureType|null, outputTemplate:{type,properties}, noveltyChance }
  if (!spec || !spec.id) throw new Error('invalid process spec');
  ProcessRegistry.set(spec.id, Object.assign({ difficulty: 0.5, baseTime: 1, noveltyChance: 0.01 }, spec));
}

function defaultRng(rng) {
  return (typeof rng === 'function') ? rng : Math.random;
}

function consumeInputs(inventory, inputs) {
  // naive consumption: inventory is an array of {type, qty, ...}
  // returns removed items list if possible, otherwise null
  const invByType = new Map();
  for (const it of inventory) {
    invByType.set(it.type, (invByType.get(it.type) || 0) + (it.qty || 1));
  }
  for (const req of inputs) {
    if ((invByType.get(req.type) || 0) < (req.qty || 1)) return null;
  }
  // consume
  for (const req of inputs) {
    let remaining = req.qty || 1;
    for (let i = inventory.length - 1; i >= 0 && remaining > 0; i--) {
      const it = inventory[i];
      if (it.type !== req.type) continue;
      const take = Math.min(remaining, it.qty || 1);
      it.qty = (it.qty || 1) - take;
      remaining -= take;
      if (it.qty <= 0) inventory.splice(i, 1);
    }
  }
  return true;
}

export function tryBuildStructure(sim, agent, typeId, footprintTiles, rng) {
  // Attempt to build a structure of given type on provided footprint (array of tile indices)
  // sim: the Simulation object; agent: the actor; footprintTiles: array of tile ids/coords
  // Returns created structure or null on failure
  const rand = defaultRng(rng);
  const spec = StructureRegistry.get(typeId);
  if (!spec) throw new Error('unknown structure type ' + typeId);

  // check footprint availability (caller should ensure tiles exist)
  if (!footprintTiles || footprintTiles.length === 0) return null;
  // check resources in agent.inventory (assumed array of {type,qty})
  if (!consumeInputs(agent.inventory, spec.buildCost || [])) return null;

  // tools / skill check (if required)
  let skillOK = true;
  if (spec.requiredSkill) {
    const s = (agent.skills && agent.skills[spec.requiredSkill]) || 0;
    // require some minimal skill to build reliably
    skillOK = s > 0 || rand() > 0.5;
  }

  if (!skillOK) return null;

  const structure = {
    id: `${typeId}_#${sim.nextStructureId = (sim.nextStructureId || 0) + 1}`,
    type: typeId,
    owner: agent.id || null,
    tiles: footprintTiles.slice(),
    condition: spec.maxCondition || 100,
    createdAt: sim.now || 0,
    meta: { shelterValue: spec.shelterValue || 0 }
  };

  // attach to sim.structures (create if missing)
  sim.structures = sim.structures || new Map();
  sim.structures.set(structure.id, structure);

  // mark tiles if sim.tileIndex exists
  if (sim.tileIndex) {
    for (const t of footprintTiles) {
      const tile = sim.tileIndex.get(t) || null;
      if (tile) {
        tile.structures = tile.structures || [];
        tile.structures.push(structure.id);
      }
    }
  }

  // side-effects: reduce exposure to cold, enable processes etc. Caller/sim can read structure.meta later
  sim.events = sim.events || [];
  sim.events.push({ type: 'build', actor: agent.id, structure: structure.id, at: sim.now });
  return structure;
}

export function tryRunProcess(sim, agent, processId, providedInputs, location, rng) {
  // Run a process. providedInputs is an array of items pulled from agent.inventory (or null to use agent.inventory directly)
  // Returns { success, outputs:[], novelty:boolean, conceptId } or null if preconditions failed
  const rand = defaultRng(rng);
  const proc = ProcessRegistry.get(processId);
  if (!proc) throw new Error('unknown process ' + processId);

  // check required structure presence
  if (proc.requiredStructureType) {
    // look in location or nearby structures on sim.tileIndex
    const nearby = (location && sim.tileIndex && sim.tileIndex.get(location)) || null;
    const has = (nearby && nearby.structures && nearby.structures.some(id=>{
      const s = sim.structures && sim.structures.get(id);
      return s && s.type === proc.requiredStructureType;
    })) || false;
    if (!has) return null;
  }

  // use providedInputs or agent.inventory
  const inputsSource = providedInputs || agent.inventory || [];
  if (!consumeInputs(inputsSource, proc.inputs || [])) return null;

  // success roll: difficulty is base failure chance; skill reduces difficulty
  const skillLevel = (proc.skill || proc.id) && ((agent.skills && agent.skills[proc.id]) || 0);
  const effectiveDifficulty = Math.max(0, (proc.difficulty || 0.5) - (skillLevel * 0.06));
  const success = rand() > effectiveDifficulty;

  const outputs = [];
  if (success) {
    // derive properties from inputs in a simple compositional way
    const out = Object.assign({ type: proc.outputTemplate.type, qty: 1 }, { properties: {} });
    const props = out.properties;
    // mix ingredient properties if present
    for (const it of inputsSource) {
      if (!it || !it.properties) continue;
      for (const k of Object.keys(it.properties)) {
        props[k] = (props[k] || 0) + (it.properties[k] * ((it.qty || 1)));
      }
    }
    // normalize and apply process modifiers
    if (proc.outputTemplate.properties) {
      for (const k of Object.keys(proc.outputTemplate.properties)) {
        props[k] = (props[k] || 0) + proc.outputTemplate.properties[k];
      }
    }
    // small normalization to keep properties bounded
    for (const k of Object.keys(props)) props[k] = Number(props[k].toFixed(3));

    outputs.push(out);

    // novelty: small chance based on proc.noveltyChance and agent's experimentation skill
    const noveltyBase = proc.noveltyChance || 0.01;
    const experimentFactor = ((agent.traits && agent.traits.curiosity) || 0) * 0.02;
    const isNovel = rand() < (noveltyBase + experimentFactor);

    // if novel, register a new concept in sim.ont (if present)
    if (isNovel && sim.ont) {
      const word = `x_${Date.now().toString(36)}_${Math.floor(rand()*1000)}`;
      const concept = { id: word, name: word, process: proc.id, sampleOutput: out, holders: new Set([agent.id]) };
      sim.ont = sim.ont || { concepts: new Map() };
      sim.ont.concepts.set(concept.id, concept);
    }

    // emit event
    sim.events = sim.events || [];
    sim.events.push({ type: 'process:success', actor: agent.id, process: proc.id, outputs, at: sim.now });

  } else {
    // failure: maybe produce a broken output or nothing
    sim.events = sim.events || [];
    sim.events.push({ type: 'process:failure', actor: agent.id, process: proc.id, at: sim.now });
  }

  return { success, outputs, novelty: null };
}

// Lightweight helper: evaluate an item's usefulness for a given need
export function evaluateItemForNeed(item, need) {
  // need is a string like 'cutting', 'warmth', 'carry'
  if (!item || !item.properties) return 0;
  const v = item.properties[need] || 0;
  // penalize weight if present
  const weight = item.properties.weight || 0;
  return Math.max(0, v - weight * 0.02);
}

// Small utilities for debugging
export function listProcesses() { return Array.from(ProcessRegistry.values()); }
export function listStructures() { return Array.from(StructureRegistry.values()); }

// End of file
