// src/sim/process-defaults.js
// Registers a small set of example structures and processes and helps
// initialize sim containers. Keep this separate so you can adapt and
// extend without touching the main simulation core.

import * as Proc from './process.js';

export function initProcessSubsystem(sim) {
  // ensure sim containers exist
  sim.structures = sim.structures || new Map();
  sim.tileIndex = sim.tileIndex || sim.tileIndex || null; // don't clobber if present
  sim.ont = sim.ont || { concepts: new Map() };
  sim.nextStructureId = sim.nextStructureId || 0;

  // register a few structure types if not present
  if (!Proc.listStructures().some(s => s.id === 'hut')) {
    Proc.registerStructureType({
      id: 'hut',
      name: 'Hut',
      buildCost: [{ type: 'wood', qty: 6 }, { type: 'thatch', qty: 4 }],
      shelterValue: 0.6,
      requiredSkill: 'carpentry',
      maxCondition: 100,
    });
  }

  if (!Proc.listStructures().some(s => s.id === 'kiln')) {
    Proc.registerStructureType({
      id: 'kiln',
      name: 'Kiln',
      buildCost: [{ type: 'stone', qty: 12 }],
      shelterValue: 0.0,
      requiredSkill: 'masonry',
      maxCondition: 200,
    });
  }

  // register simple processes
  if (!Proc.listProcesses().some(p => p.id === 'sharpen_stone')) {
    Proc.registerProcess({
      id: 'sharpen_stone',
      name: 'Sharpen stone',
      inputs: [{ type: 'stone', qty: 1 }, { type: 'wood', qty: 1 }],
      baseTime: 3,
      difficulty: 0.25,
      outputTemplate: { type: 'knife', properties: { cutting: 0.35, durability: 30, weight: 1 } },
      noveltyChance: 0.02,
      requiredStructureType: null,
    });
  }

  if (!Proc.listProcesses().some(p => p.id === 'fire_craft')) {
    Proc.registerProcess({
      id: 'fire_craft',
      name: 'Fire craft (ceramic)',
      inputs: [{ type: 'clay', qty: 2 }],
      baseTime: 8,
      difficulty: 0.45,
      outputTemplate: { type: 'pottery', properties: { warmth: 0.05, durability: 20, weight: 2 } },
      noveltyChance: 0.05,
      requiredStructureType: 'kiln',
    });
  }

  // convenience helpers attached to sim for quick calls from agent code
  sim.actions = sim.actions || {};
  sim.actions.buildStructure = function (agent, typeId, footprintTiles) {
    // returns structure or null
    return Proc.tryBuildStructure(sim, agent, typeId, footprintTiles, sim.rng);
  };

  sim.actions.runProcess = function (agent, processId, providedInputs, location) {
    return Proc.tryRunProcess(sim, agent, processId, providedInputs, location, sim.rng);
  };

  // expose registries on sim for easy inspection
  sim.processRegistry = Proc.listProcesses();
  sim.structureRegistry = Proc.listStructures();

  return sim;
}

export default initProcessSubsystem;
