// Backward-compatible facade.
// The single source of truth for truck-capacity calculation lives in Palletservice.
export {
    calcTruckSlots,
    MAX_TRUCK_SLOTS,
    MAX_TRUCK_HEIGHT_CM,
} from "./Palletservice";
