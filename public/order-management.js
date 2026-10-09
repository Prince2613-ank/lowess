/* ==========================================================================
 * Online orders and picking carts (sample data) for the order-picking module.
 *
 * Loads frontend/data/orders/<store>.json and keeps the working state (orders,
 * cart assignments, picks) in localStorage per store. Stock is never stored
 * here: picks deduct from, and undo restores to, the Rack Inventory model
 * (InventoryModel), and a ledger records which picks deducted stock so each
 * deduction happens once. No DOM or map code here.
 * ========================================================================== */

const OrderManagement = (() => {
    const STORAGE_PREFIX = "lowes-order-picking:v1:";
    const STATUSES = ["Pending", "Assigned", "Picking", "Ready", "Completed"];
    const PRIORITIES = ["High", "Normal", "Low"];
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const lineKey = (orderId, lineNo) => `${orderId}#${lineNo}`;
    const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    class PickingStore {
        constructor(storeId, sample) {
            if (!sample || !Array.isArray(sample.orders) || !Array.isArray(sample.carts)) throw new Error("Malformed order data");
            this.storeId = storeId;
            this.sample = clone(sample);
            this.storageAvailable = true;
            this.state = this.read() || this.initialState();
        }

        initialState() {
            const orders = clone(this.sample.orders);
            return {
                orders,
                carts: this.sample.carts.map((cart) => ({ ...clone(cart), started: false, location: null })),
                picks: {},              // lineKey -> { picked_at, rack_id, sku, quantity, deducted }
                completed: {},          // order_id -> completed_at
                nextOrderNumber: Math.max(1000, ...orders.map((o) => Number(o.order_id.replace(/\D/g, "")) || 0)) + 1,
                settings: { walkSpeed: 1.0, showAllRoutes: false, selectedCart: this.sample.carts[0]?.cart_id || null },
            };
        }

        get storageKey() {
            return STORAGE_PREFIX + this.storeId;
        }

        read() {
            try {
                const saved = JSON.parse(localStorage.getItem(this.storageKey) || "null");
                return saved && Array.isArray(saved.orders) && Array.isArray(saved.carts) ? saved : null;
            } catch (error) {
                this.storageAvailable = false;
                console.warn("Saved picking state unavailable:", error);
                return null;
            }
        }

        save() {
            try {
                localStorage.setItem(this.storageKey, JSON.stringify(this.state));
                this.storageAvailable = true;
            } catch (error) {
                this.storageAvailable = false;
                console.warn("Could not save picking state:", error);
            }
        }

        /* -- reads -------------------------------------------------------- */

        get orders() { return this.state.orders; }
        get carts() { return this.state.carts; }
        get settings() { return this.state.settings; }

        order(id) { return this.state.orders.find((order) => order.order_id === id) || null; }
        cart(id) { return this.state.carts.find((cart) => cart.cart_id === id) || null; }
        cartOf(orderId) { return this.state.carts.find((cart) => cart.orders.includes(orderId)) || null; }
        pick(orderId, lineNo) { return this.state.picks[lineKey(orderId, lineNo)] || null; }
        isCompleted(orderId) { return Boolean(this.state.completed[orderId]); }

        progress(order) {
            const total = order.lines.reduce((sum, line) => sum + line.quantity, 0);
            const picked = order.lines.reduce((sum, line) => sum + (this.pick(order.order_id, line.line_no) ? line.quantity : 0), 0);
            return { total, picked, percent: total ? Math.round((picked / total) * 100) : 0, lines: order.lines.length,
                pickedLines: order.lines.filter((line) => this.pick(order.order_id, line.line_no)).length };
        }

        status(order) {
            if (this.isCompleted(order.order_id)) return "Completed";
            const cart = this.cartOf(order.order_id);
            if (!cart) return "Pending";
            const { pickedLines, lines } = this.progress(order);
            if (pickedLines === lines) return "Ready";
            return cart.started || pickedLines ? "Picking" : "Assigned";
        }

        cartSummary(cart) {
            const orders = cart.orders.map((id) => this.order(id)).filter(Boolean);
            const totals = orders.map((order) => this.progress(order));
            const total = totals.reduce((sum, p) => sum + p.total, 0);
            const picked = totals.reduce((sum, p) => sum + p.picked, 0);
            const status = !orders.length ? "Idle" : picked === total ? "Returning" : cart.started || picked ? "Picking" : "Assigned";
            return { orders, total, picked, percent: total ? Math.round((picked / total) * 100) : 0, status };
        }

        stats() {
            const statuses = this.state.orders.map((order) => this.status(order));
            const count = (...names) => statuses.filter((s) => names.includes(s)).length;
            return {
                total: statuses.length,
                pending: count("Pending"),
                inProgress: count("Assigned", "Picking", "Ready"),
                completed: count("Completed"),
                activeCarts: this.state.carts.filter((cart) => cart.orders.length).length,
            };
        }

        // Rack stops for a cart: every rack holding a line of its orders, with
        // the order lines (one per order, so shared SKUs stay separate).
        stops(cartId) {
            const cart = this.cart(cartId);
            if (!cart) return [];
            const byRack = new Map();
            for (const orderId of cart.orders) {
                const order = this.order(orderId);
                if (!order) continue;
                for (const line of order.lines) {
                    if (!byRack.has(line.rack_id)) byRack.set(line.rack_id, { rack_id: line.rack_id, aisle_id: line.aisle_id, department: line.department, lines: [] });
                    byRack.get(line.rack_id).lines.push({ order_id: orderId, line, key: lineKey(orderId, line.line_no), picked: this.pick(orderId, line.line_no) });
                }
            }
            for (const stop of byRack.values()) stop.done = stop.lines.every((entry) => entry.picked);
            return [...byRack.values()];
        }

        search(query, filters = {}) {
            const text = String(query || "").trim().toLowerCase();
            return this.state.orders.filter((order) => {
                const status = this.status(order);
                if (filters.status && status !== filters.status) return false;
                if (filters.priority && order.priority !== filters.priority) return false;
                if (!text) return true;
                const haystack = [order.order_id, order.customer_ref, this.cartOf(order.order_id)?.name || "", status,
                    ...order.lines.flatMap((line) => [line.product_name, line.type, line.sku, line.rack_id])].join(" ").toLowerCase();
                return haystack.includes(text);
            });
        }

        /* -- cart assignment ------------------------------------------------ */

        assign(orderIds, cartId) {
            const cart = this.cart(cartId);
            if (!cart) return { ok: false, message: "Choose a cart." };
            const moved = [], skipped = [];
            for (const id of orderIds) {
                const order = this.order(id);
                if (!order || this.isCompleted(id)) { skipped.push(`${id} is completed`); continue; }
                const current = this.cartOf(id);
                if (current?.cart_id === cartId) continue;
                if (current && this.progress(order).pickedLines) { skipped.push(`${id} is already being picked on ${current.name}`); continue; }
                if (current) current.orders = current.orders.filter((other) => other !== id);
                cart.orders.push(id);
                moved.push(id);
                if (current && !current.orders.length) Object.assign(current, { started: false, location: null });
            }
            if (moved.length) this.save();
            const parts = [];
            if (moved.length) parts.push(`${moved.join(", ")} assigned to ${cart.name}.`);
            if (skipped.length) parts.push(`Not moved: ${skipped.join("; ")}.`);
            return { ok: moved.length > 0, message: parts.join(" ") || "Nothing to assign." };
        }

        unassign(orderId) {
            const cart = this.cartOf(orderId);
            const order = this.order(orderId);
            if (!cart || !order) return { ok: false, message: "Order is not on a cart." };
            if (this.progress(order).pickedLines) return { ok: false, message: `Undo the picked items of ${orderId} before removing it from ${cart.name}.` };
            cart.orders = cart.orders.filter((id) => id !== orderId);
            if (!cart.orders.length) Object.assign(cart, { started: false, location: null });
            this.save();
            return { ok: true, message: `${orderId} returned to the queue.` };
        }

        startPicking(cartId) {
            const cart = this.cart(cartId);
            if (!cart?.orders.length) return { ok: false, message: "Assign orders to this cart first." };
            cart.started = true;
            this.save();
            return { ok: true, message: `${cart.name} started picking.` };
        }

        /* -- picking (stock lives in the inventory model) ------------------- */

        available(inventory, line) {
            const product = inventory?.get(line.rack_id)?.products.find((item) => item.sku === line.sku);
            return product ? product.stock_quantity : null;
        }

        pickLine(orderId, lineNo, inventory) {
            const order = this.order(orderId);
            const line = order?.lines.find((item) => item.line_no === lineNo);
            const cart = this.cartOf(orderId);
            if (!line || !cart) return { ok: false, message: "Assign the order to a cart before picking." };
            if (this.isCompleted(orderId)) return { ok: false, message: `${orderId} is already completed.` };
            if (this.pick(orderId, lineNo)) return { ok: false, message: "This item is already picked." };
            const stock = this.available(inventory, line);
            if (stock == null) return { ok: false, message: `${line.sku} is not stocked on ${line.rack_id}.` };
            if (stock < line.quantity) return { ok: false, message: `Insufficient stock: ${line.quantity} needed, ${stock} on ${line.rack_id}.` };
            const result = inventory.changeStock(line.rack_id, line.sku, -line.quantity);
            if (!result.ok) return { ok: false, message: result.message };
            this.state.picks[lineKey(orderId, lineNo)] = { picked_at: now(), rack_id: line.rack_id, sku: line.sku, quantity: line.quantity, deducted: true };
            Object.assign(cart, { started: true, location: line.rack_id });
            this.save();
            return { ok: true, message: `Picked ${line.quantity} × ${line.product_name} for ${orderId}.` };
        }

        undoLine(orderId, lineNo, inventory) {
            const key = lineKey(orderId, lineNo);
            const pick = this.state.picks[key];
            if (!pick) return { ok: false, message: "This item is not picked." };
            if (this.isCompleted(orderId)) return { ok: false, message: `${orderId} is completed; its items have left the floor.` };
            if (pick.deducted) {
                const result = inventory?.changeStock(pick.rack_id, pick.sku, pick.quantity);
                if (!result?.ok) return { ok: false, message: result?.message || "Stock could not be restored." };
            }
            delete this.state.picks[key];
            const cart = this.cartOf(orderId);
            if (cart && cart.location === pick.rack_id) {
                // Fall back to the most recent remaining pick on this cart.
                const latest = Object.entries(this.state.picks)
                    .filter(([k]) => cart.orders.includes(k.split("#")[0]))
                    .sort((a, b) => b[1].picked_at.localeCompare(a[1].picked_at))[0];
                cart.location = latest ? latest[1].rack_id : null;
            }
            this.save();
            return { ok: true, message: `Returned ${pick.quantity} × ${pick.sku} to ${pick.rack_id}.` };
        }

        complete(orderId) {
            const order = this.order(orderId);
            if (!order) return { ok: false, message: "Unknown order." };
            const { pickedLines, lines } = this.progress(order);
            if (pickedLines < lines) return { ok: false, message: `${orderId} still has ${lines - pickedLines} item(s) to pick.` };
            const cart = this.cartOf(orderId);
            this.state.completed[orderId] = now();
            if (cart) {
                cart.orders = cart.orders.filter((id) => id !== orderId);
                if (!cart.orders.length) Object.assign(cart, { started: false, location: null });
            }
            this.save();
            return { ok: true, message: `${orderId} completed and staged at pick-up.` };
        }

        // The inventory panel reset racks to their default stock: those
        // picks no longer hold a deduction to give back.
        inventoryReset(rackId = null) {
            let changed = false;
            for (const pick of Object.values(this.state.picks)) {
                if (pick.deducted && (rackId == null || pick.rack_id === rackId)) { pick.deducted = false; changed = true; }
            }
            if (changed) this.save();
        }

        /* -- sample data ----------------------------------------------------- */

        generateOrder(random = Math.random) {
            const pool = this.sample.product_pool || [];
            if (pool.length < 2) return { ok: false, message: "No product locations available for new orders." };
            const shuffled = pool.slice().sort(() => random() - 0.5);
            const items = shuffled.slice(0, 2 + Math.floor(random() * Math.min(7, pool.length - 1)));
            const id = `ORD-${this.state.nextOrderNumber++}`;
            const order = {
                order_id: id,
                customer_ref: `CUST-${10000 + Math.floor(random() * 90000)}`,
                order_time: now(),
                priority: PRIORITIES[Math.floor(random() * PRIORITIES.length)],
                lines: items.map((item, i) => ({
                    line_no: i + 1, type: item.type, product_name: item.product_name, sku: item.sku,
                    quantity: 1 + Math.floor(random() * Math.max(1, item.max_quantity || 3)),
                    rack_id: item.rack_id, aisle_id: item.aisle_id, department: item.department,
                })),
            };
            this.state.orders.push(order);
            this.save();
            return { ok: true, order, message: `${id} received with ${order.lines.length} items.` };
        }

        // Give back every stock deduction still held, then restore the sample state.
        reset(inventory) {
            const failures = [];
            for (const pick of Object.values(this.state.picks)) {
                if (!pick.deducted) continue;
                const result = inventory?.changeStock(pick.rack_id, pick.sku, pick.quantity);
                if (!result?.ok) failures.push(`${pick.sku} on ${pick.rack_id}`);
            }
            const settings = this.state.settings;
            this.state = this.initialState();
            this.state.settings = { ...this.state.settings, walkSpeed: settings.walkSpeed };
            this.save();
            return { ok: true, message: failures.length ? `Orders reset; stock could not be returned for ${failures.join(", ")}.` : "Orders, carts and picked stock restored to the starting sample." };
        }
    }

    async function load(storeId) {
        const response = await fetch(`data/orders/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return new PickingStore(storeId, await response.json());
    }

    return { PickingStore, load, STATUSES, PRIORITIES, lineKey };
})();
