import type { CourseDef, Gate } from './race';

// Placeholder courses until the real ones (src/courses.ts) land: the endless mountainside on a fixed seed,
// with straight split lines across it. Delete this file once COURSES is wired in.
const line = (z: number): Gate => ({ x: 0, y: 0, z, nx: 0, nz: -1, halfW: 1e5, halfH: 1e5 });
const stub = (id: string, name: string, seed: number): CourseDef & { seed: number } => ({
  id: `stub-${id}`, version: 1, name, blurb: 'Placeholder course (the real one is being built)', seed,
  start: { x: 0, y: 0, z: 0, heading: 0 }, startGate: line(-40),
  splits: [line(-1500), line(-3000), line(-4500)], finish: line(-6000),
  sections: ['The top', 'Middle run', 'Lower slopes', 'Run to the line'],
});
export const STUB_COURSES = [stub('a', 'Test Run A', 101), stub('b', 'Test Run B', 202), stub('c', 'Test Run C', 303)];
