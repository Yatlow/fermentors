import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../cooler/truckCapacity";
import { weeklyDemand, type Product, type Settings } from "./planningEngine";
import { isCoreStyle } from "./planningPresentation";
import { projectedPallets } from "./truckPlanner";

function manifestForQuantities(products: Product[], quantities: Map<string, number>, key: string) {
  return products.flatMap((p) =>
    projectedPallets(p, quantities.get(p.id) ?? 0, `${key}:${p.id}`).map((x) => x.pallet),
  );
}

export function buildShipmentRecommendation(settings: Settings, rows: Map<string, { breweryUnits: number; tempoUnits: number | null }>) {
  const products = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const quantities = new Map<string, number>();
  const palletSize = (p: Product) => (p.type === "crates" ? 84 : 20);
  const available = new Map<string, number>();

  for (const p of products) {
    const units = Math.max(0, rows.get(p.id)?.breweryUnits ?? 0);
    // The weekly decision is made in pallet slots. A physical partial pallet still
    // occupies one pallet position, so when it is the last stock available we let
    // it represent one planned pallet instead of making the planner enter fractions.
    available.set(p.id, units > 0 ? Math.ceil(units / palletSize(p)) : 0);
  }

  const coverAfter = (p: Product) => {
    const state = rows.get(p.id);
    const demand = weeklyDemand(p);
    if (!state || state.tempoUnits === null || demand <= 0) return Infinity;
    return (state.tempoUnits + (quantities.get(p.id) ?? 0)) / demand;
  };

  while (true) {
    const candidates = products
      .filter((p) => ((quantities.get(p.id) ?? 0) / palletSize(p)) < (available.get(p.id) ?? 0))
      .sort((a, b) => coverAfter(a) - coverAfter(b) || a.id.localeCompare(b.id));

    let added = false;
    for (const p of candidates) {
      const next = new Map(quantities);
      next.set(p.id, (next.get(p.id) ?? 0) + palletSize(p));
      let slots = Infinity;
      try {
        slots = calcTruckSlots(manifestForQuantities(products, next, "weekly-truck"));
      } catch {
        slots = Infinity;
      }
      if (slots > MAX_TRUCK_SLOTS) continue;
      quantities.clear();
      next.forEach((value, key) => quantities.set(key, value));
      added = true;
      break;
    }
    if (!added) break;
    // Even with all floor positions occupied, another pallet may fit on a stack.
    // Stop only when no available pallet can be added.
  }

  const manifest = manifestForQuantities(products, quantities, "weekly-truck-final");
  const slots = manifest.length ? calcTruckSlots(manifest) : 0;
  const recommendation = products.flatMap((p) => {
    const quantity = quantities.get(p.id) ?? 0;
    if (!quantity) return [];
    const pallets = projectedPallets(p, quantity, `weekly-rec:${p.id}`).length;
    const rowManifest = projectedPallets(p, quantity, `weekly-rec-slots:${p.id}`).map((x) => x.pallet);
    return [{
      productId: p.id,
      quantity,
      pallets,
      slots: rowManifest.length ? calcTruckSlots(rowManifest) : 0,
    }];
  });

  return { recommendation, slots, full: slots === MAX_TRUCK_SLOTS };
}
