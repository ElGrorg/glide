// Floor profile of one course path: npx tsx scripts/prof.ts <course> <path> [from] [to]
import './dom-stub';
import { setCourse, getCourse, terrainHeight } from '../src/world';
import { COURSES } from '../src/courses';
const [id, pid, a, b] = process.argv.slice(2);
setCourse(COURSES.find((c) => c.id === id)!);
const c = getCourse()!; const p = c.byId.get(pid)!; const sm = p.sm;
const i0 = Math.round(Number(a ?? 0) * (sm.n - 1)), i1 = Math.round(Number(b ?? 1) * (sm.n - 1));
for (let i = i0; i <= i1; i += 3) console.log(`${(i / (sm.n - 1)).toFixed(3)} x ${sm.x[i].toFixed(0)} z ${sm.z[i].toFixed(0)} fy ${sm.y[i].toFixed(1)} ground ${terrainHeight(sm.x[i], sm.z[i]).toFixed(1)} w ${sm.w[i].toFixed(0)}`);
