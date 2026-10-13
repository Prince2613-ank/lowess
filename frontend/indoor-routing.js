/* ==========================================================================
 * Indoor walking network and picking-route optimisation.
 *
 * Loads frontend/data/routing/<store>.json (built by
 * scripts/build_routing_network.py): a walkable grid in the store's source
 * coordinates. Routes follow the aisles and stay close to the shortest walk:
 * Dijkstra on that grid with straight moves inside aisles (the drawings are
 * aligned with the grid) and diagonal moves only across open floor at least
 * 2 m from shelving, a light cost per turn so paths run straight with clean
 * corners, and a light cost for hugging shelving so routes keep to the middle
 * of an aisle. No DOM or map code here.
 * ========================================================================== */

const IndoorRouting = (() => {
    const EXACT_STOP_LIMIT = 15;      // guaranteed-best stop order (Held-Karp) up to this many stops
    const DENSIFY_METERS = 3;         // keeps drawn legs on the floor under non-linear alignment
    const TURN_COST = 1;              // m added per 90 degrees of turning: fewer, cleaner corners
    const CENTRE_WEIGHT = 0.4;        // extra step cost = weight / cells from the nearest shelving or wall
    const OPEN_CELLS = 4;             // cells (2 m) from shelving on every side before diagonal moves are allowed
    const MAX_CLEARANCE = 80;         // cells (40 m): clearance is measured up to this far
    const LANE_SNAP = 4;              // cells (2 m): parallel stretches this close share one drawn line
    const LANE_BIAS = 0.02;           // tie-break: of two equally central rows, every route takes the same one
    const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // Moves [dc, dr]: four straight, then four diagonal (open floor only), with headings in degrees.
    const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const HEADINGS = MOVES.map(([dc, dr]) => Math.atan2(dr, dc) * 180 / Math.PI);
    const TURNS = HEADINGS.map((a) => HEADINGS.map((b) => {
        const angle = Math.abs(a - b) % 360;
        return TURN_COST * Math.min(angle, 360 - angle) / 90;
    }));

    /* -- binary heap of (cost, node) for Dijkstra ------------------------- */
    class MinHeap {
        constructor() { this.costs = []; this.nodes = []; }
        get size() { return this.costs.length; }
        push(cost, node) {
            const { costs, nodes } = this;
            let i = costs.length;
            costs.push(cost); nodes.push(node);
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (costs[parent] <= cost) break;
                costs[i] = costs[parent]; nodes[i] = nodes[parent];
                i = parent;
            }
            costs[i] = cost; nodes[i] = node;
        }
        pop() {
            const { costs, nodes } = this;
            const node = nodes[0], cost = costs[0];
            const lastCost = costs.pop(), lastNode = nodes.pop();
            if (costs.length) {
                let i = 0;
                const n = costs.length;
                while (true) {
                    let child = 2 * i + 1;
                    if (child >= n) break;
                    if (child + 1 < n && costs[child + 1] < costs[child]) child += 1;
                    if (costs[child] >= lastCost) break;
                    costs[i] = costs[child]; nodes[i] = nodes[child];
                    i = child;
                }
                costs[i] = lastCost; nodes[i] = lastNode;
            }
            return [cost, node];
        }
    }

    class Network {
        constructor(payload) {
            const grid = payload?.grid;
            if (!grid || !grid.mask || !(grid.cols > 0) || !(grid.rows > 0)) throw new Error("Malformed routing network");
            Object.assign(this, { cols: grid.cols, rows: grid.rows, cell: grid.cell, x0: grid.x0, y0: grid.y0 });
            this.projection = payload.projection;
            this.dispatch = payload.dispatch && Number.isInteger(payload.dispatch.cell) ? payload.dispatch : null;
            this.rackAccess = payload.rack_access || {};
            this.stats = payload.stats || {};
            const bytes = Uint8Array.from(atob(grid.mask), (c) => c.charCodeAt(0));
            const count = this.cols * this.rows;
            this.walkable = new Uint8Array(count);
            for (let i = 0; i < count; i += 1) this.walkable[i] = (bytes[i >> 3] >> (i & 7)) & 1;
            this.component = this.labelComponents();
            this.stepCost = this.centreCosts();
        }

        // Cost (metres) of stepping onto each cell: one cell length, plus a
        // little more the closer it is to shelving or walls. The cheapest line
        // through any corridor is then its centre line, however wide, so every
        // route through a corridor shares one lane.
        centreCosts() {
            const { cols, rows, walkable } = this;
            const clearance = new Uint8Array(walkable.length).fill(MAX_CLEARANCE);
            this.clearance = clearance;
            let frontier = [];
            for (let i = 0; i < walkable.length; i += 1) {
                const r = Math.floor(i / cols), c = i - r * cols;
                if (!walkable[i]) { clearance[i] = 0; frontier.push(i); }
                else if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) clearance[i] = 1;
            }
            for (let level = 1; level < MAX_CLEARANCE && frontier.length; level += 1) {
                const next = [];
                for (const cell of frontier) {
                    const r = Math.floor(cell / cols), c = cell - r * cols;
                    for (const [dc, dr] of DIRECTIONS) {
                        const nc = c + dc, nr = r + dr;
                        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                        const n = nr * cols + nc;
                        if (clearance[n] > level) { clearance[n] = level; next.push(n); }
                    }
                }
                frontier = next;
            }
            const cost = new Float32Array(walkable.length);
            for (let i = 0; i < cost.length; i += 1) cost[i] = this.cell * (1 + CENTRE_WEIGHT / Math.max(1, clearance[i]));
            return cost;
        }

        // Neighbour moves: [dc, dr, cost]; diagonals need both side cells free.
        *neighbours(cell) {
            const { cols, rows, walkable } = this;
            const r = Math.floor(cell / cols), c = cell - r * cols;
            for (const [dc, dr, cost] of Network.MOVES) {
                const nc = c + dc, nr = r + dr;
                if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                const next = nr * cols + nc;
                if (!walkable[next]) continue;
                if (dc && dr && (!walkable[r * cols + nc] || !walkable[nr * cols + c])) continue;
                yield [next, cost];
            }
        }

        labelComponents() {
            const labels = new Int32Array(this.walkable.length).fill(-1);
            let label = 0;
            for (let start = 0; start < labels.length; start += 1) {
                if (!this.walkable[start] || labels[start] !== -1) continue;
                const stack = [start];
                labels[start] = label;
                while (stack.length) {
                    const cell = stack.pop();
                    for (const [next] of this.neighbours(cell)) {
                        if (labels[next] === -1) { labels[next] = label; stack.push(next); }
                    }
                }
                label += 1;
            }
            return labels;
        }

        connected(a, b) {
            return a != null && b != null && this.component[a] !== -1 && this.component[a] === this.component[b];
        }

        // Cheapest walk from one cell to every target, over (cell, heading)
        // states: straight moves, diagonal ones across open floor, a cost per
        // turn and per step near shelving. Stops once every target is reached.
        route(source, targets) {
            const { cols, rows, walkable, stepCost, clearance } = this;
            const states = walkable.length * 8;
            const cost = new Float64Array(states).fill(Infinity);
            const prev = new Int32Array(states).fill(-1);
            const best = new Map();
            const remaining = new Set(targets);
            remaining.delete(source);
            best.set(source, { cost: 0, state: -1 });
            const heap = new MinHeap();
            for (let d = 0; d < 8; d += 1) { cost[source * 8 + d] = 0; heap.push(0, source * 8 + d); }
            while (heap.size && remaining.size) {
                const [total, state] = heap.pop();
                if (total > cost[state]) continue;
                const cell = state >> 3, heading = state & 7;
                if (remaining.has(cell)) { remaining.delete(cell); best.set(cell, { cost: total, state }); }
                const r = Math.floor(cell / cols), c = cell - r * cols;
                for (let d = 0; d < 8; d += 1) {
                    const nc = c + MOVES[d][0], nr = r + MOVES[d][1];
                    if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                    const next = nr * cols + nc;
                    if (!walkable[next]) continue;
                    const diagonal = d >= 4;
                    // Diagonals only across open floor, never past a shelf corner.
                    if (diagonal && (clearance[cell] < OPEN_CELLS || clearance[next] < OPEN_CELLS
                        || !walkable[r * cols + nc] || !walkable[nr * cols + c])) continue;
                    // Moving along a row (d < 2) prefers even rows, along a column even columns,
                    // so routes sharing a corridor share one lane instead of running side by side.
                    const lane = diagonal ? 0 : d < 2 ? nr & 1 : nc & 1;
                    const step = diagonal ? stepCost[next] * Math.SQRT2 : stepCost[next];
                    const candidate = total + step + lane * LANE_BIAS + (cell !== source ? TURNS[heading][d] : 0);
                    const nextState = next * 8 + d;
                    if (candidate < cost[nextState]) {
                        cost[nextState] = candidate;
                        prev[nextState] = state;
                        heap.push(candidate, nextState);
                    }
                }
            }
            return { source, prev, best };
        }

        // Cost from the run's source to a cell (Infinity if not reached).
        static costTo(run, cell) {
            return run.best.get(cell)?.cost ?? Infinity;
        }

        static pathFrom(run, target) {
            if (target === run.source) return [target];
            const found = run.best.get(target);
            if (!found) return null;
            const cells = [];
            for (let state = found.state; state !== -1; state = run.prev[state]) cells.push(state >> 3);
            if (cells[cells.length - 1] !== run.source) return null;
            return cells.reverse();
        }

        // Corner cells of a straight-move path (where the heading changes).
        corners(cells) {
            if (cells.length <= 2) return cells.slice();
            const out = [cells[0]];
            for (let i = 1; i < cells.length - 1; i += 1) {
                if (cells[i] - cells[i - 1] !== cells[i + 1] - cells[i]) out.push(cells[i]);
            }
            out.push(cells[cells.length - 1]);
            return out;
        }

        // Cell centre in source lon/lat.
        cellToSource(cell) {
            const r = Math.floor(cell / this.cols), c = cell - r * this.cols;
            const x = this.x0 + (c + 0.5) * this.cell, y = this.y0 + (r + 0.5) * this.cell;
            const p = this.projection;
            return [p.lon0 + x / p.kx, p.lat0 + y / p.ky];
        }

        // Corner lists for a route's legs, with parallel stretches of different
        // legs that run within LANE_SNAP cells of each other moved onto one
        // line wherever the floor along it is clear - so walking out and back
        // along a corridor is drawn as a single line, not two side by side.
        alignLanes(legs) {
            const { cols } = this;
            const paths = legs.map((cells) => (cells && cells.length > 1 ? this.corners(cells).map((cell) => [Math.floor(cell / cols), cell % cols]) : null));
            const clear = (a, b) => {
                const axis = a[0] === b[0] ? 0 : 1, along = 1 - axis;
                const step = Math.sign(b[along] - a[along]);
                for (let v = a[along]; ; v += step) {
                    const rc = axis === 0 ? [a[0], v] : [v, a[1]];
                    if (!this.walkable[rc[0] * cols + rc[1]]) return false;
                    if (v === b[along]) return true;
                }
            };
            // Move the stretch a-b of `pts` onto line `pos` of `axis` (0: same row, 1: same column).
            const move = (pts, a, b, axis, pos) => {
                const i = pts.indexOf(a);
                if (i < 0 || pts[i + 1] !== b) return false;
                const na = a.slice(), nb = b.slice();
                na[axis] = pos; nb[axis] = pos;
                const before = i === 0 ? a : pts[i - 1], after = i + 1 === pts.length - 1 ? b : pts[i + 2];
                const across = (p, q) => p[1 - axis] === q[1 - axis] && p[axis] !== q[axis];
                if ((i > 0 && !across(before, a)) || (i + 1 < pts.length - 1 && !across(b, after))) return false;
                if (!clear(na, nb) || !clear(before, na) || !clear(nb, after)) return false;
                if (i + 1 === pts.length - 1) pts.splice(i + 1, 0, nb); else nb.forEach((v, k) => { b[k] = v; });
                if (i === 0) pts.splice(1, 0, na); else na.forEach((v, k) => { a[k] = v; });
                return true;
            };
            for (const axis of [0, 1]) {
                const along = 1 - axis;
                const stretches = [];
                for (const pts of paths) {
                    if (!pts) continue;
                    for (let k = 0; k < pts.length - 1; k += 1) {
                        if (pts[k][axis] === pts[k + 1][axis] && pts[k][along] !== pts[k + 1][along]) stretches.push([pts, pts[k], pts[k + 1]]);
                    }
                }
                stretches.sort((s, u) => Math.abs(u[2][along] - u[1][along]) - Math.abs(s[2][along] - s[1][along]));
                const lanes = [];
                for (const [pts, a, b] of stretches) {
                    const lo = Math.min(a[along], b[along]), hi = Math.max(a[along], b[along]);
                    const lane = lanes.find((l) => l.pos !== a[axis] && Math.abs(l.pos - a[axis]) <= LANE_SNAP && l.lo < hi && lo < l.hi);
                    if (!lane || !move(pts, a, b, axis, lane.pos)) lanes.push({ pos: a[axis], lo, hi });
                }
            }
            return paths.map((pts) => {
                if (!pts) return null;
                const cells = pts.map(([r, c]) => r * cols + c).filter((cell, i, all) => i === 0 || cell !== all[i - 1]);
                const heading = (a, b) => `${Math.sign(Math.floor(b / cols) - Math.floor(a / cols))},${Math.sign((b % cols) - (a % cols))}`;
                return cells.filter((cell, i) => i === 0 || i === cells.length - 1 || heading(cells[i - 1], cell) !== heading(cell, cells[i + 1]));
            });
        }

        // Walking line through corner cells, in map coordinates.
        lineToMap(cells, toMap) {
            return this.cornersToMap(this.corners(cells), toMap);
        }

        cornersToMap(cornerCells, toMap) {
            const corners = cornerCells.map((cell) => this.cellToSource(cell));
            const p = this.projection;
            const coords = [];
            corners.forEach((point, i) => {
                if (i === 0) { coords.push(toMap(point)); return; }
                const [x0, y0] = corners[i - 1];
                const meters = Math.hypot((point[0] - x0) * p.kx, (point[1] - y0) * p.ky);
                const pieces = Math.max(1, Math.ceil(meters / DENSIFY_METERS));
                for (let k = 1; k <= pieces; k += 1) {
                    coords.push(toMap([x0 + (point[0] - x0) * (k / pieces), y0 + (point[1] - y0) * (k / pieces)]));
                }
            });
            return coords;
        }
    }
    Network.MOVES = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

    /* -- stop ordering ------------------------------------------------------ */

    // Cost of visiting stops in `order` (indices into the matrix, 0 = start, last = end if any).
    function pathCost(matrix, order, end) {
        let cost = 0, at = 0;
        for (const stop of order) { cost += matrix[at][stop]; at = stop; }
        if (end != null) cost += matrix[at][end];
        return cost;
    }

    // Best visiting order by dynamic programming over subsets (Held-Karp):
    // cost[set][j] = cheapest walk from the start through every stop in `set`,
    // ending at stop j. Guaranteed optimal; fast up to EXACT_STOP_LIMIT stops.
    function exactOrder(matrix, stops, end) {
        const n = stops.length;
        if (!n) return [];
        const full = (1 << n) - 1;
        const cost = new Float64Array((full + 1) * n).fill(Infinity);
        const parent = new Int8Array((full + 1) * n).fill(-1);
        for (let j = 0; j < n; j += 1) cost[(1 << j) * n + j] = matrix[0][stops[j]];
        for (let set = 1; set <= full; set += 1) {
            for (let j = 0; j < n; j += 1) {
                const here = cost[set * n + j];
                if (!(set & (1 << j)) || here === Infinity) continue;
                for (let k = 0; k < n; k += 1) {
                    if (set & (1 << k)) continue;
                    const next = set | (1 << k), candidate = here + matrix[stops[j]][stops[k]];
                    if (candidate < cost[next * n + k]) { cost[next * n + k] = candidate; parent[next * n + k] = j; }
                }
            }
        }
        let last = -1, bestCost = Infinity;
        for (let j = 0; j < n; j += 1) {
            const total = cost[full * n + j] + (end != null ? matrix[stops[j]][end] : 0);
            if (total < bestCost) { bestCost = total; last = j; }
        }
        if (last < 0) return [];
        const order = [];
        for (let set = full, j = last; j >= 0; ) {
            order.push(stops[j]);
            const previous = parent[set * n + j];
            set &= ~(1 << j);
            j = previous;
        }
        return order.reverse();
    }

    function heuristicOrder(matrix, stops, end) {
        const order = [];
        const left = new Set(stops);
        let at = 0;
        while (left.size) {
            let best = null;
            for (const stop of left) if (best == null || matrix[at][stop] < matrix[at][best]) best = stop;
            order.push(best); left.delete(best); at = best;
        }
        // 2-opt on the open path (start and end stay fixed).
        let improved = true;
        while (improved) {
            improved = false;
            for (let i = 0; i < order.length - 1; i += 1) {
                for (let j = i + 1; j < order.length; j += 1) {
                    const candidate = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
                    if (pathCost(matrix, candidate, end) + 1e-9 < pathCost(matrix, order, end)) {
                        order.splice(0, order.length, ...candidate);
                        improved = true;
                    }
                }
            }
        }
        return order;
    }

    /**
     * Plan a picking route.
     *   start: cell where the cart is now; end: drop-off cell or null;
     *   stops: [{ key, cell }] (one per rack).
     * Returns visiting order, per-leg cell paths, unreachable stops and whether
     * the stop order is exact or heuristic.
     */
    function planRoute(network, { start, end, stops }) {
        const warnings = [];
        if (start == null || !network.walkable[start]) {
            return { order: [], legs: [], unreachable: stops.map((s) => s.key), method: "none", gridDistance: 0, warnings: ["The cart's start point is not on the walking network."] };
        }
        const reachable = stops.filter((stop) => network.connected(start, stop.cell));
        const unreachable = stops.filter((stop) => !network.connected(start, stop.cell)).map((stop) => stop.key);
        let endCell = end;
        if (endCell != null && !network.connected(start, endCell)) {
            warnings.push("The drop-off point is not connected to the cart's position on the walking network.");
            endCell = null;
        }
        // Matrix nodes: 0 = start, 1..n = stops, n + 1 = end.
        const nodes = [start, ...reachable.map((stop) => stop.cell)];
        if (endCell != null) nodes.push(endCell);
        const endIndex = endCell != null ? nodes.length - 1 : null;
        const runs = nodes.slice(0, endIndex ?? nodes.length).map((cell) => network.route(cell, nodes));
        const matrix = runs.map((run) => nodes.map((cell) => Network.costTo(run, cell)));
        const stopIndexes = reachable.map((_, i) => i + 1);
        const exact = stopIndexes.length <= EXACT_STOP_LIMIT;
        const order = exact ? exactOrder(matrix, stopIndexes, endIndex) : heuristicOrder(matrix, stopIndexes, endIndex);
        const sequence = [0, ...order, ...(endIndex != null ? [endIndex] : [])];
        // Each pair of nodes uses one grid path whichever way it is walked, so
        // going to a rack and back along the same aisle draws a single line.
        const legPath = (from, to) => {
            if (nodes[from] === nodes[to]) return [nodes[from]];
            const lo = Math.min(from, to), hi = Math.max(from, to);
            const path = Network.pathFrom(runs[lo], nodes[hi]);
            return path && lo !== from ? path.reverse() : path;
        };
        const legs = [];
        for (let i = 0; i < sequence.length - 1; i += 1) legs.push(legPath(sequence[i], sequence[i + 1]));
        return {
            order: order.map((index) => reachable[index - 1].key),
            legs,
            unreachable,
            method: stopIndexes.length <= 1 ? "direct" : exact ? "exact" : "heuristic",
            gridDistance: pathCost(matrix, order, endIndex),
            warnings,
        };
    }

    async function load(storeId) {
        const response = await fetch(`data/routing/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return new Network(await response.json());
    }

    return { Network, planRoute, load, EXACT_STOP_LIMIT };
})();
