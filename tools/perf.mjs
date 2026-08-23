import { Simulation } from '../src/sim/sim.js';
const sim = new Simulation('bram', { population: 14 });
let t0 = Date.now();
for (let i = 1; i <= 12000; i++) {
  sim.step();
  if (i % 2000 === 0) { console.log('t'+i, 'pop', sim.living.length, 'concepts', sim.ont.concepts.size, (2000/((Date.now()-t0)/1000)).toFixed(0)+' ticks/s'); t0 = Date.now(); }
}
