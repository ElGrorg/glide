import './dom-stub';
import { setCourse, getCourse, terrainHeight, solidClearance } from '../src/world';
import { COURSES } from '../src/courses';
const def = COURSES.find(c => c.id === process.argv[2])!; setCourse(def); const c = getCourse()! as any;
const p = c.byId.get(process.argv[3]); const sm = p.sm;
for (let i = 0; i < sm.n; i += 3) { const yMid = sm.y[i] + (p.kind === 'cave' ? sm.h[i] / 2 : 3);
  console.log(i, sm.x[i].toFixed(0), sm.z[i].toFixed(0), 'floor', sm.y[i].toFixed(0), 'h', sm.h[i].toFixed(0), 'surf', terrainHeight(sm.x[i], sm.z[i]).toFixed(0), 'clr@mid', solidClearance(sm.x[i], yMid, sm.z[i]).toFixed(1), 'clr@floor+1', solidClearance(sm.x[i], sm.y[i] + 1, sm.z[i]).toFixed(1)); }
