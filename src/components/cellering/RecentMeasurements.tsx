import { useState } from "react";
import { ListChevronsUpDown } from "lucide-react";
import type { Fermentor } from "../../App";
import type { Measurement } from "../../SERVICES/cellering/calculateCelleringRecomendations";
import { getMeasurementsByBatch } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import BeerLoader from "../general/Loading";
import "./RecentMeasurements.css";

type Mode = "pressure" | "warm";

type Props = {
  tank: Fermentor;
  mode: Mode;
};

function formatMeasurementDate(id: unknown): string {
  const raw = String(id ?? "");
  const [datePart, timePart] = raw.split("_");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart || "");
  if (!match) return raw || "—";
  const date = `${match[3]}/${match[2]}`;
  if (!timePart || timePart.length < 4) return date;
  return `${date} ${timePart.slice(0, 2)}:${timePart.slice(2, 4)}`;
}

function value(value: unknown, suffix = ""): string {
  return value === undefined || value === null || value === "" ? "—" : `${value}${suffix}`;
}

export default function RecentMeasurements({ tank, mode }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Measurement[]>([]);
  const [error, setError] = useState("");

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }

    setOpen(true);
    if (rows.length || loading) return;

    const batch = String(tank.batchNumber ?? "").replace("#", "").trim();
    if (!batch) return;

    setLoading(true);
    setError("");
    try {
      const measurements = await getMeasurementsByBatch(batch);
      const newestFive = [...measurements]
        .sort((a, b) => String(b.id ?? "").localeCompare(String(a.id ?? "")))
        .slice(0, 5);
      setRows(newestFive.reverse());
    } catch (err) {
      console.error("Failed loading recent measurements", tank.tankNumber, err);
      setError("לא ניתן לטעון מדידות קודמות");
    } finally {
      setLoading(false);
    }
  }

  if (Number(tank.action) !== 1 || !tank.batchNumber) return null;

  return (
    <div className="recentMeasurements">
      <button
        type="button"
        className="recentMeasurementsToggle"
        onClick={() => void toggle()}
        aria-expanded={open}
        title="הצג 5 מדידות אחרונות"
      >
        <ListChevronsUpDown size={16} aria-hidden="true" />
        <span>{open ? "הסתר מדידות" : "5 מדידות אחרונות"}</span>
      </button>

      {open && (
        <div className="recentMeasurementsPanel">
          {loading && <BeerLoader size="spinner" message="" />}
          {!loading && error && <small className="recentMeasurementsError">{error}</small>}
          {!loading && !error && rows.length === 0 && <small>אין עדיין מדידות קודמות</small>}
          {!loading && !error && rows.map((measurement) => (
            <div className="recentMeasurementsRow" key={String(measurement.id)}>
              <span className="recentMeasurementsDate">{formatMeasurementDate(measurement.id)}</span>
              {mode === "pressure" ? (
                <>
                  <span>טמפ׳ <strong>{value(measurement.temp, "°")}</strong></span>
                  <span>לחץ <strong>{value(measurement.pressure)}</strong></span>
                </>
              ) : (
                <>
                  <span>Plato <strong>{value(measurement.plato, "°")}</strong></span>
                  <span>pH <strong>{value(measurement.pH)}</strong></span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
