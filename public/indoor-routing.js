/* ==========================================================================
 * Indoor walking network and picking-route optimisation.
 *
 * Loads frontend/data/routing/<store>.json (built by
 * scripts/build_routing_network.py): a walkable grid in the store's source
 * coordinates. Walking distances come from Dijkstra on that grid (8-way
 * moves, no cutting past shelf corners); drawn paths are smoothed only where
 * a straight line stays on walkable cells. No DOM or map code here.
 * ========================================================================== */

const IndoorRouting = (() => {
    const EXACT_STOP_LIMIT = 8;       // exhaustive stop ordering up to this many stops
    const DENSIFY_METERS = 3;         // keeps drawn legs on the floor under non-linear alignment

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
            this.pickup = payload.pickup && Number.isInteger(payload.pickup.cell) ? payload.pickup : null;
            this.rackAccess = payload.rack_access || {};
            this.stats = payload.stats || {};
            const bytes = Uint8Array.from(atob(grid.mask), (c) => c.charCodeAt(0));
            const count = this.cols * this.rows;
            this.walkable = new Uint8Array(count);
            for (let i = 0; i < count; i += 1) this.walkable[i] = (bytes[i >> 3] >> (i & 7)) & 1;
            this.component = this.labelComponents();
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

        // Shortest walking distance (metres, source frame) from one cell to all
        // cells until every target is settled.
        dijkstra(source, targets) {
            const dist = new Float64Array(this.walkable.length).fill(Infinity);
            const prev = new Int32Array(this.walkable.length).fill(-1);
            const remaining = new Set(targets);
            remaining.delete(source);
            dist[source] = 0;
            const heap = new MinHeap();
            heap.push(0, source);
            while (heap.size && remaining.size) {
                const [cost, cell] = heap.pop();
                if (cost > dist[cell]) continue;
                remaining.delete(cell);
                for (const [next, step] of this.neighbours(cell)) {
                    const candidate = cost + step * this.cell;
                    if (candidate < dist[next]) {
                        dist[next] = candidate;
                        prev[next] = cell;
                        heap.push(candidate, next);
                    }
                }
            }
            return { dist, prev };
        }

        static pathFrom(prev, source, target) {
            const cells = [target];
            for (let cell = target; cell !== source; ) {
                cell = prev[cell];
                if (cell === -1) return null;
                cells.push(cell);
            }
            return cells.reverse();
        }

        // Straight line between two cell centres stays on walkable cells.
        lineOfSight(a, b) {
            const { cols } = this;
            const ar = Math.floor(a / cols), ac = a - ar * cols, br = Math.floor(b / cols), bc = b - br * cols;
            const steps = Math.ceil(Math.max(Math.abs(br - ar), Math.abs(bc - ac)) * 4);
            for (let i = 1; i < steps; i += 1) {
                const t = i / steps;
                const r = Math.round(ar + (br - ar) * t), c = Math.round(ac + (bc - ac) * t);
                if (!this.walkable[r * cols + c]) return false;
                // Exactly between two cells: both must be free so the line cannot slip past a corner.
                const rf = ar + (br - ar) * t, cf = ac + (bc - ac) * t;
                if (Math.abs(rf - Math.floor(rf) - 0.5) < 1e-9 && !this.walkable[Math.floor(rf) * cols + c]) return false;
                if (Math.abs(cf - Math.floor(cf) - 0.5) < 1e-9 && !this.walkable[r * cols + Math.floor(cf)]) return false;
            }
            return true;
        }

        smooth(cells) {
            if (cells.length <= 2) return cells.slice();
            const out = [cells[0]];
            let anchor = 0;
            while (anchor < cells.length - 1) {
                let next = anchor + 1;
                for (let j = cells.length - 1; j > next; j -= 1) {
                    if (this.lineOfSight(cells[anchor], cells[j])) { next = j; break; }
                }
                out.push(cells[next]);
                anchor = next;
            }
            return out;
        }

        // Cell centre in source lon/lat.
        cellToSource(cell) {
            const r = Math.floor(cell / this.cols), c = cell - r * this.cols;
            const x = this.x0 + (c + 0.5) * this.cell, y = this.y0 + (r + 0.5) * this.cell;
            const p = this.projection;
            return [p.lon0 + x / p.kx, p.lat0 + y / p.ky];
        }

        // Smoothed walking line for a cell path, in map coordinates.
        lineToMap(cells, toMap) {
            const corners = this.smooth(cells).map((cell) => this.cellToSource(cell));
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

    function exactOrder(matrix, stops, end) {
        let best = null, bestCost = Infinity;
        const current = [], used = new Array(stops.length).fill(false);
        const visit = (cost, at) => {
            if (cost >= bestCost) return;
            if (current.length === stops.length) {
                const total = end != null ? cost + matrix[at][end] : cost;
                if (total < bestCost) { bestCost = total; best = current.slice(); }
                return;
            }
            stops.forEach((stop, i) => {
                if (used[i]) return;
                used[i] = true; current.push(stop);
                visit(cost + matrix[at][stop], stop);
                current.pop(); used[i] = false;
            });
        };
        visit(0, 0);
        return best || [];
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
        const runs = nodes.slice(0, endIndex ?? nodes.length).map((cell) => network.dijkstra(cell, nodes));
        const matrix = runs.map(({ dist }) => nodes.map((cell) => dist[cell]));
        const stopIndexes = reachable.map((_, i) => i + 1);
        const exact = stopIndexes.length <= EXACT_STOP_LIMIT;
        const order = exact ? exactOrder(matrix, stopIndexes, endIndex) : heuristicOrder(matrix, stopIndexes, endIndex);
        const sequence = [0, ...order, ...(endIndex != null ? [endIndex] : [])];
        const legs = [];
        for (let i = 0; i < sequence.length - 1; i += 1) {
            const from = sequence[i], to = sequence[i + 1];
            legs.push(nodes[from] === nodes[to] ? [nodes[from]] : Network.pathFrom(runs[from].prev, nodes[from], nodes[to]));
        }
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
