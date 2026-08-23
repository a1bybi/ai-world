import { Simulation } from '../src/sim/sim.js';
const seeds = (process.argv[3]||'aurorae,delta,harrow,ember').split(',');
const N = Number(process.argv[2] || 20000);
let alive = 0, tot = 0, peak = 0;
for (const s of seeds) {
  const sim = new Simulation(s, { population: 14 });
  let mx = 0, extinctAt = null;
  for (let i = 0; i < N; i++) {
    sim.step();
    mx = Math.max(mx, sim.living.length);
    if (!sim.living.length && extinctAt === null) { extinctAt = i; break; }
  }
  const p = sim.living.length;
  if (p) alive++;
  tot += p; peak = Math.max(peak, mx);
  console.log([...sim.chronicle.causes.entries()].map(c=>c[0]+':'+c[1]).join(' '));console.log(s.padEnd(8), 'final', String(p).padStart(3), 'peak', String(mx).padStart(3), 'births', String(sim.counters.births).padStart(3), 'concepts', String(sim.ont.concepts.size).padStart(4), 'struct', String(sim.world.structures.length).padStart(3), extinctAt !== null ? 'EXTINCT t'+extinctAt : '');
}
console.log(`survived ${alive}/${seeds.length}, mean final pop ${(tot/seeds.length).toFixed(1)}, peak ${peak}`);
