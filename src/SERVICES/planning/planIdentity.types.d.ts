import "./planningEngine";

declare module "./planningEngine" {
  interface Plan {
    /** Stable logical relation to a planned brew; legacy rows may omit it. */
    brewId?: string;
  }
}
