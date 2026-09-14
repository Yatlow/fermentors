import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { weekStart, type Product, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import type { ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { shipmentMatchesForPlans } from "../../SERVICES/planning/shipmentActuals";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";

function selectedWeekFromPlanner(root: Element | null): string | null {
  const text = root
    ?.querySelector<HTMLButtonElement>('.bp-week-picker button[aria-pressed="true"] small')
    ?.textContent
    ?.trim() ?? "";
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function annotateShipmentFeedback(
  root: Element,
  selectedWeek: string | null,
  plans: WeekPlan[],
  products: Product[],
) {
  if (!selectedWeek) return;
  const feedback = root.querySelector<HTMLElement>(".bp-shipment-feedback");
  if (!feedback?.textContent) return;

  const week = plans.find((item) => item.id === selectedWeek);
  if (!week) return;

  const plannedProductIds = new Set(
    (week.deliveries ?? []).filter((delivery) => delivery.quantity > 0).map((delivery) => delivery.productId),
  );
  const relevant = products.filter((product) => plannedProductIds.has(product.id));

  let text = feedback.textContent;
  for (const product of relevant) {
    const style = displayStyle(product.style);
    const packageType = product.type === "crates" ? "בקבוקים" : "חביות";
    const plainPrefix = `${style}:`;
    const labeledPrefix = `${style} (${packageType}):`;

    if (text.includes(labeledPrefix)) continue;
    const index = text.indexOf(plainPrefix);
    if (index >= 0) {
      text = `${text.slice(0, index)}${labeledPrefix}${text.slice(index + plainPrefix.length)}`;
    }
  }

  if (feedback.textContent !== text) feedback.textContent = text;
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

  useEffect(() => {
    const root = document.querySelector(".bp-enhanced-weekly-planner");
    if (!root) return;

    const annotate = () => annotateShipmentFeedback(root, selectedWeek, plans, products);
    annotate();
    const observer = new MutationObserver(annotate);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [selectedWeek, plans, products]);

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
