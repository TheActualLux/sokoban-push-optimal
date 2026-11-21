import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_EXPANDED = 180_000;
const MAX_STATES = 240_000;

type Dir = { dx: number; dy: number; letter: string };
type Walk = { prev: Int32Array; prevDir: Int8Array };
type Room = { cells: Set<number>; boxes: number[]; goals: Set<number>; door: number; hall: number; first: number };
type SearchState = { boxes: number[]; player: number; parent: number; segment: string };

function solve(text: string): string {
  const rows = text.split(/\r?\n/);
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  const width = Math.max(0, ...rows.map((row) => row.length));
  const height = rows.length;
  const size = width * height;
  const floor = new Uint8Array(size);
  const boxes: number[] = [];
  const goals = new Set<number>();
  let player = -1;
  let hallwayY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < rows[y]!.length; x++) {
      const ch = rows[y]![x]!;
      const cell = y * width + x;
      if (ch === '#') continue;
      if (ch !== ' ' && ch !== '.' && ch !== '$' && ch !== '*' && ch !== '@' && ch !== '+') continue;
      floor[cell] = 1;
      if (ch === '$' || ch === '*') boxes.push(cell);
      if (ch === '.' || ch === '*' || ch === '+') goals.add(cell);
      if (ch === '@' || ch === '+') {
        player = cell;
        hallwayY = y;
      }
    }
  }
  if (width === 0 || player < 0) return '';

  const dirs: Dir[] = [
    { dx: 0, dy: -1, letter: 'u' },
    { dx: 0, dy: 1, letter: 'd' },
    { dx: -1, dy: 0, letter: 'l' },
    { dx: 1, dy: 0, letter: 'r' },
  ];
  const next = (cell: number, dir: Dir): number => {
    const x = cell % width;
    const y = Math.floor(cell / width);
    const nx = x + dir.dx;
    const ny = y + dir.dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return -1;
    return ny * width + nx;
  };
  const walk = (allowed: Set<number>, start: number, occupied: Set<number>): Walk => {
    const prev = new Int32Array(size);
    prev.fill(-2);
    const prevDir = new Int8Array(size);
    prevDir.fill(-1);
    if (!allowed.has(start) || occupied.has(start)) return { prev, prevDir };
    const queue = new Int32Array(size);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    prev[start] = -1;
    while (head < tail) {
      const at = queue[head++]!;
      for (let di = 0; di < dirs.length; di++) {
        const to = next(at, dirs[di]!);
        if (to < 0 || !allowed.has(to) || occupied.has(to) || prev[to] !== -2) continue;
        prev[to] = at;
        prevDir[to] = di;
        queue[tail++] = to;
      }
    }
    return { prev, prevDir };
  };
  const pathTo = (walked: Walk, start: number, target: number): string | null => {
    if (target < 0 || target >= size || walked.prev[target] === -2) return null;
    const reverse: string[] = [];
    let at = target;
    while (at !== start) {
      const di = walked.prevDir[at]!;
      if (di < 0) return null;
      reverse.push(dirs[di]!.letter);
      at = walked.prev[at]!;
    }
    reverse.reverse();
    return reverse.join('');
  };

  // Components are formed after removing the hallway row, so each room can be searched independently.
  const seen = new Uint8Array(size);
  const rooms: Room[] = [];
  for (let cell = 0; cell < size; cell++) {
    if (!floor[cell] || Math.floor(cell / width) === hallwayY || seen[cell]) continue;
    const component: number[] = [];
    const queue = [cell];
    seen[cell] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const at = queue[qi]!;
      component.push(at);
      for (const dir of dirs) {
        const to = next(at, dir);
        if (to < 0 || !floor[to] || Math.floor(to / width) === hallwayY || seen[to]) continue;
        seen[to] = 1;
        queue.push(to);
      }
    }
    component.sort((a, b) => a - b);
    const cells = new Set(component);
    const roomBoxes = boxes.filter((b) => cells.has(b)).sort((a, b) => a - b);
    const roomGoals = new Set([...goals].filter((g) => cells.has(g)));
    const doors: { inside: number; hall: number }[] = [];
    for (const inside of component) {
      for (const dir of dirs) {
        const hall = next(inside, dir);
        if (hall >= 0 && floor[hall] && Math.floor(hall / width) === hallwayY) doors.push({ inside, hall });
      }
    }
    doors.sort((a, b) => a.hall - b.hall || a.inside - b.inside);
    if (roomBoxes.length || roomGoals.size) {
      if (!doors.length) return '';
      rooms.push({ cells, boxes: roomBoxes, goals: roomGoals, door: doors[0]!.inside, hall: doors[0]!.hall, first: component[0]! });
    }
  }
  rooms.sort((a, b) => a.hall - b.hall || a.first - b.first);

  const hallway = new Set<number>();
  for (let cell = hallwayY * width; cell < (hallwayY + 1) * width && cell < size; cell++) {
    if (floor[cell]) hallway.add(cell);
  }

  const solveRoom = (room: Room): { moves: string; end: number; boxes: number[] } | null => {
    if (room.boxes.length !== room.goals.size || !room.cells.has(room.door)) return null;
    const searchCells = new Set(room.cells);
    for (const cell of hallway) searchCells.add(cell);
    const states: SearchState[] = [{ boxes: room.boxes, player: room.hall, parent: -1, segment: '' }];
    const initialReach = walk(searchCells, room.hall, new Set(room.boxes));
    let canonical = room.hall;
    for (const cell of searchCells) if (initialReach.prev[cell] !== -2 && cell < canonical) canonical = cell;
    const keyOf = (bs: number[], p: number): string => `${bs.join(',')}|${p}`;
    const keys = new Set<string>([keyOf(room.boxes, canonical)]);
    let expanded = 0;

    for (let head = 0; head < states.length && expanded < MAX_EXPANDED; head++) {
      const state = states[head]!;
      const occupied = new Set(state.boxes);
      const reachable = walk(searchCells, state.player, occupied);
      const canExit = reachable.prev[room.hall] !== -2;
      if (state.boxes.every((b) => room.goals.has(b)) && canExit) {
        const fragments: string[] = [];
        for (let at = head; at > 0; at = states[at]!.parent) fragments.push(states[at]!.segment);
        fragments.reverse();
        return { moves: fragments.join(''), end: state.player, boxes: state.boxes };
      }
      expanded++;

      for (let bi = 0; bi < state.boxes.length; bi++) {
        const box = state.boxes[bi]!;
        for (const dir of dirs) {
          const stand = next(box, { dx: -dir.dx, dy: -dir.dy, letter: '' });
          const dest = next(box, dir);
          if (stand < 0 || dest < 0 || reachable.prev[stand] === -2 || !room.cells.has(dest) || occupied.has(dest)) continue;
          const walking = pathTo(reachable, state.player, stand);
          if (walking === null) continue;
          const nextBoxes = state.boxes.slice();
          nextBoxes[bi] = dest;
          nextBoxes.sort((a, b) => a - b);
          const nextPlayer = box;
          const nextReach = walk(searchCells, nextPlayer, new Set(nextBoxes));
          let nextCanonical = -1;
          for (const cell of searchCells) {
            if (nextReach.prev[cell] !== -2 && (nextCanonical < 0 || cell < nextCanonical)) nextCanonical = cell;
          }
          if (nextCanonical < 0) continue;
          const key = keyOf(nextBoxes, nextCanonical);
          if (keys.has(key)) continue;
          if (states.length >= MAX_STATES) return null;
          keys.add(key);
          states.push({ boxes: nextBoxes, player: nextPlayer, parent: head, segment: walking + dir.letter });
        }
      }
    }
    return null;
  };

  let answer = '';
  for (const room of rooms) {
    const plan = solveRoom(room);
    if (!plan) break;
    const corridorPath = pathTo(walk(hallway, player, new Set(boxes)), player, room.hall);
    if (corridorPath === null) break;
    const searchCells = new Set(room.cells);
    for (const cell of hallway) searchCells.add(cell);
    const exitWalk = walk(searchCells, plan.end, new Set(plan.boxes));
    const toHall = pathTo(exitWalk, plan.end, room.hall);
    if (toHall === null) break;

    answer += corridorPath + plan.moves + toHall;
    player = room.hall;
    for (const box of room.boxes) {
      const idx = boxes.indexOf(box);
      if (idx >= 0) boxes.splice(idx, 1);
    }
    boxes.push(...plan.boxes);
  }
  return answer;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
