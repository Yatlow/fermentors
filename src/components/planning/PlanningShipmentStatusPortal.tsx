import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { weekStart, type Product, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import type { ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { shipmentMatchesForPlans } from "../../SERVICES/planning/shipmentActuals";

function selectedWeekFromPlanner(root: Element | null): string | null {
  const text = root
    ?.querySelector<HTMLButtonElement>('.bp-week-picker button[aria-pressed="true"] small')
    ?.textContent
    ?.trim() ?? "";
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

export default function PlanningShipmentStatusPortal({
  plans,
  shipments,
  products,
}: {
  plans: WeekPlan[];
  shipments: ShipmentEvent[];
  products: Product[];
}) {
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const root = document.querySelector(".bp-enhanced-weekly-planner");
    if (!root) return;

    const sync = () => {
      setSelectedWeek(selectedWeekFromPlanner(root));
      setTarget(root.querySelector<HTMLElement>(".bp-week-shipment-card .bp-saved-summary"));
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-pressed"],
    });
    return () => observer.disconnect();
  }, []);

  const status = useMemo(() => {
    if (!selectedWeek) return null;
    const actualThisWeek = shipments.filter((shipment) => weekStart(shipment.date) === selectedWeek);
    if (!actualThisWeek.length) return null;

    const matches = shipmentMatchesForPlans(plans, shipments, products)
      .filter((match) => match.week === selectedWeek);
    const pendingTrips = matches.filter((match) => match.status === "pending");
    const hasDifferent = matches.some((match) => match.status === "actual-different");

    return {
      actualCount: actualThisWeek.length,
      pendingCount: pendingTrips.length,
      hasDifferent,
    };
  }, [selectedWeek, shipments, plans, products]);

  if (!target || !status) return null;

  return createPortal(
    <span className="bp-actual-shipment-inline" role="status">
      <b>✓ {status.actualCount === 1 ? "בוצע משלוח" : `בוצעו ${status.actualCount} משלוחים`} השבוע</b>
      <span>
        {status.pendingCount > 0
          ? ` · נשאר ${status.pendingCount === 1 ? "משלוח מתוכנן נוסף" : `${status.pendingCount} משלוחים מתוכננים נוספים`}`
          : " · ההמלצה חושבה מחדש אחרי מה שכבר נשלח"}
      </span>
      {status.hasDifferent && <small>לפחות משלוח אחד בוצע בהרכב שונה מההחלטה.</small>}
    </span>,
    target,
  );
}
