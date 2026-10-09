/* ==========================================================================
 * Rack inventory model (simulated stock - not connected to any live Lowe's
 * inventory system).
 *
 * Loads frontend/data/inventory/<store>.json, applies the visitor's local
 * edits from localStorage and answers queries. No DOM or map code here.
 * ========================================================================== */

const InventoryModel = (() => {
    const STORAGE_PREFIX = "lowes-inventory:v1:";

    // Occupancy bands: green > 70%, yellow 30-70%, red < 30%, grey = vacant.
    const BANDS = {
        high: { label: "Occupied", detail: "More than 70% occupied", color: "#16a34a" },
        partial: { label: "Partial", detail: "30-70% occupied", color: "#eab308" },
        low: { label: "Low", detail: "Less than 30% occupied", color: "#dc2626" },
        vacant: { label: "Vacant", detail: "Completely vacant", color: "#9ca3af" },
    };

    function occupancyBand(occupied, capacity) {
        if (occupied <= 0 || capacity <= 0) return "vacant";
        const ratio = occupied / capacity;
        if (ratio > 0.7) return "high";
        if (ratio >= 0.3) return "partial";
        return "low";
    }

    // Physical occupancy (slots) and stock (units) are separate figures; this
    // only refreshes the values derived from them.
    function derive(record) {
        const capacity = record.storage_capacity;
        const occupied = Math.min(capacity, Math.max(0, record.occupied_capacity));
        const stock = record.products.reduce((sum, product) => sum + product.stock_quantity, 0);
        const reorder = record.products.reduce((sum, product) => sum + product.reorder_point, 0);
        return {
            ...record,
            occupied_capacity: occupied,
            available_capacity: capacity - occupied,
            occupancy_percentage: Math.round((occupied / capacity) * 1000) / 10,
            occupancy_band: occupancyBand(occupied, capacity),
            stock_quantity: stock,
            product_name: record.products[0]?.product_name || "",
            sku: record.products[0]?.sku || "",
            inventory_status: stock === 0 ? "Out of Stock" : stock <= reorder ? "Low Stock" : "In Stock",
        };
    }

    const clone = (value) => JSON.parse(JSON.stringify(value));
    const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

    class StoreInventory {
        constructor(storeId, payload) {
            if (!payload || !Array.isArray(payload.racks)) throw new Error("Malformed inventory file");
            this.storeId = storeId;
            this.notice = payload.notice || "";
            this.base = new Map(payload.racks.map((rack) => [rack.rack_id, clone(rack)]));
            this.storageAvailable = true;
            this.overrides = this.readOverrides();
            this.records = new Map();
            this.listeners = new Set();
            for (const id of this.base.keys()) this.rebuild(id);
        }

        // Other modules (order picking) are told about stock edits and resets.
        subscribe(listener) {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
        }

        emit(event) {
            for (const listener of this.listeners) {
                try { listener(event); } catch (error) { console.error("Inventory listener failed:", error); }
            }
        }

        /* -- persistence ------------------------------------------------- */

        get storageKey() {
            return STORAGE_PREFIX + this.storeId;
        }

        readOverrides() {
            try {
                const saved = JSON.parse(localStorage.getItem(this.storageKey) || "{}");
                return saved && typeof saved === "object" ? saved : {};
            } catch (error) {
                this.storageAvailable = false;
                console.warn("Saved inventory changes unavailable:", error);
                return {};
            }
        }

        writeOverrides() {
            try {
                if (Object.keys(this.overrides).length) localStorage.setItem(this.storageKey, JSON.stringify(this.overrides));
                else localStorage.removeItem(this.storageKey);
                this.storageAvailable = true;
            } catch (error) {
                this.storageAvailable = false;
                console.warn("Could not save inventory changes:", error);
            }
        }

        rebuild(id) {
            const record = clone(this.base.get(id));
            const override = this.overrides[id];
            if (override) {
                if (Number.isInteger(override.occupied_capacity)) record.occupied_capacity = override.occupied_capacity;
                for (const product of record.products) {
                    const quantity = override.stock?.[product.sku];
                    if (Number.isInteger(quantity) && quantity >= 0) product.stock_quantity = quantity;
                }
                if (override.last_updated) record.last_updated = override.last_updated;
            }
            this.records.set(id, derive(record));
        }

        commit(id, record) {
            this.overrides[id] = {
                occupied_capacity: record.occupied_capacity,
                stock: Object.fromEntries(record.products.map((product) => [product.sku, product.stock_quantity])),
                last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            };
            this.writeOverrides();
            this.rebuild(id);
            this.emit({ type: "edit", rackId: id });
            return this.records.get(id);
        }

        /* -- reads -------------------------------------------------------- */

        list() {
            return [...this.records.values()].sort((a, b) => naturalCompare(a.rack_id, b.rack_id));
        }

        get(id) {
            return this.records.get(id) || null;
        }

        isModified(id) {
            return Boolean(this.overrides[id]);
        }

        stats() {
            const racks = this.list();
            const count = (band) => racks.filter((rack) => rack.occupancy_band === band).length;
            const capacity = racks.reduce((sum, rack) => sum + rack.storage_capacity, 0);
            const occupied = racks.reduce((sum, rack) => sum + rack.occupied_capacity, 0);
            return {
                total: racks.length,
                occupied: count("high"),
                partial: count("partial") + count("low"),
                vacant: count("vacant"),
                capacity,
                occupiedCapacity: occupied,
                available: capacity - occupied,
                utilization: capacity ? Math.round((occupied / capacity) * 1000) / 10 : 0,
            };
        }

        facets() {
            const racks = this.list();
            const unique = (values) => [...new Set(values.filter(Boolean))].sort(naturalCompare);
            return {
                departments: unique(racks.map((rack) => rack.department)),
                categories: unique(racks.map((rack) => rack.product_category)),
                aisles: unique(racks.map((rack) => rack.aisle_id)),
            };
        }

        matchesFilters(rack, filters) {
            return (!filters.department || rack.department === filters.department)
                && (!filters.category || rack.product_category === filters.category)
                && (!filters.band || rack.occupancy_band === filters.band)
                && (!filters.aisle || rack.aisle_id === filters.aisle);
        }

        // Finds racks by rack ID, aisle, department, category, product or SKU.
        search(query, limit = 8) {
            const text = String(query || "").trim().toLowerCase();
            if (!text) return [];
            const compact = text.replace(/[\s-]/g, "");
            const aisleQuery = text.replace(/^aisle\s*/, "");
            const results = [];
            for (const rack of this.list()) {
                const number = rack.rack_id.replace(/\D/g, "");
                let score = 0;
                let reason = "";
                const consider = (value, label, points) => {
                    if (points > score) { score = points; reason = label ? `${label}: ${value}` : ""; }
                };
                if (rack.rack_id.toLowerCase().replace("-", "") === compact || (/^\d+$/.test(compact) && Number(number) === Number(compact))) consider(rack.rack_id, "", 100);
                else if (rack.rack_id.toLowerCase().replace("-", "").includes(compact) && /^r/.test(compact)) consider(rack.rack_id, "", 60);
                if (rack.aisle_id && rack.aisle_id.toLowerCase() === aisleQuery) consider(rack.aisle_id, "Aisle", 90);
                if (rack.department.toLowerCase().includes(text)) consider(rack.department, "Department", 50);
                if (rack.product_category.toLowerCase().includes(text)) consider(rack.product_category, "Category", 45);
                for (const product of rack.products) {
                    if (product.sku.toLowerCase() === text) consider(product.sku, "SKU", 95);
                    else if (product.sku.toLowerCase().includes(text)) consider(product.sku, "SKU", 55);
                    if (product.product_name.toLowerCase().includes(text)) consider(product.product_name, "Product", 40);
                }
                if (score) results.push({ rack, score, reason });
            }
            return results.sort((a, b) => b.score - a.score || naturalCompare(a.rack.rack_id, b.rack.rack_id)).slice(0, limit);
        }

        /* -- edits -------------------------------------------------------- */

        editable(id) {
            const record = this.records.get(id);
            if (!record) throw new Error(`Unknown rack ${id}`);
            return clone(record);
        }

        // Stock changes move occupied slots by each product's pack size
        // (units per slot); occupancy can still be set directly afterwards.
        changeStock(id, sku, delta) {
            if (!Number.isInteger(delta) || delta === 0) return { ok: false, message: "Enter a whole number of units." };
            const record = this.editable(id);
            const product = record.products.find((item) => item.sku === sku);
            if (!product) return { ok: false, message: "Choose a product on this rack." };
            const before = product.stock_quantity;
            const after = before + delta;
            if (after < 0) return { ok: false, message: `Only ${before} units of this product are in stock.` };
            const slots = (units) => Math.ceil(units / product.units_per_slot);
            const slotChange = slots(after) - slots(before);
            if (slotChange > record.storage_capacity - record.occupied_capacity) {
                return { ok: false, message: `Needs ${slotChange} free slots; only ${record.storage_capacity - record.occupied_capacity} available.` };
            }
            product.stock_quantity = after;
            record.occupied_capacity = Math.max(0, record.occupied_capacity + slotChange);
            const saved = this.commit(id, record);
            return { ok: true, record: saved, message: `${delta > 0 ? "Added" : "Removed"} ${Math.abs(delta)} units of ${product.product_name}.` };
        }

        setOccupied(id, value) {
            const record = this.editable(id);
            if (!Number.isInteger(value) || value < 0 || value > record.storage_capacity) {
                return { ok: false, message: `Occupied slots must be a whole number from 0 to ${record.storage_capacity}.` };
            }
            record.occupied_capacity = value;
            const saved = this.commit(id, record);
            return { ok: true, record: saved, message: `Occupied capacity set to ${value} of ${record.storage_capacity} slots.` };
        }

        markVacant(id) {
            const record = this.editable(id);
            record.occupied_capacity = 0;
            record.products.forEach((product) => { product.stock_quantity = 0; });
            const saved = this.commit(id, record);
            return { ok: true, record: saved, message: `${id} marked as vacant.` };
        }

        resetRack(id) {
            delete this.overrides[id];
            this.writeOverrides();
            this.rebuild(id);
            this.emit({ type: "reset", rackId: id });
            return { ok: true, record: this.records.get(id), message: `${id} reset to its default stock levels.` };
        }

        resetAll() {
            this.overrides = {};
            this.writeOverrides();
            for (const id of this.base.keys()) this.rebuild(id);
            this.emit({ type: "reset", rackId: null });
            return { ok: true, message: "All racks reset to their default stock levels." };
        }
    }

    async function load(storeId) {
        const response = await fetch(`data/inventory/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return new StoreInventory(storeId, await response.json());
    }

    return { BANDS, occupancyBand, load, StoreInventory };
})();
