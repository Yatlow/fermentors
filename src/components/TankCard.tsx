import {
  useEffect,
  useState,
  useRef,
  memo,
  type ChangeEvent,
} from "react";
import { ClipboardPlus, ListClock, ChartNoAxesCombined } from "lucide-react";
import { updateTankStatus } from "../SERVICES/updateTank";
import { isCarbonationOutOfRange, isPressureOutOfRange } from "../SERVICES/calculateCelleringRecomendations";

import type {
  Fermentor,
  FirestoreTimestamp,
} from "../App";

import FermentorInfoBox from "./FermentorInfoBox";
import type { SpecChart } from "../SERVICES/getSpecsFromFb";
import QuickTankReportBox from "./QuickTankReportBox";
import BatchHistoryChart from "./Batchhistorychart";
import { Pencil, MessageCirclePlus, SaveCheck } from 'lucide-react';
import { updateSpecficNote } from "../SERVICES/updateSpecficNote";


type TankCardProps = {
  tank: Fermentor;

  onUpdatePasivation?: (
    tankId: string,
    newDate: string
  ) => Promise<void>;
  specs: SpecChart
};


type TankState = {
  action: string | number;

  pasivationDate: string;

  editPasivationDate: boolean;
};


export function getBrewAge(
  brewDate:
    | string
    | null
    | undefined
): number | null {

  if (!brewDate) {
    return null;
  }

  const parts =
    String(
      brewDate
    ).split("/");

  if (
    parts.length !== 3
  ) {
    return null;
  }

  const day =
    Number(parts[0]);

  const month =
    Number(parts[1]) - 1;

  let year =
    Number(parts[2]);

  if (year < 100) {
    year += 2000;
  }

  const brew =
    new Date(
      year,
      month,
      day
    );

  if (
    Number.isNaN(
      brew.getTime()
    )
  ) {
    return null;
  }

  const today =
    new Date();

  brew.setHours(
    0,
    0,
    0,
    0
  );

  today.setHours(
    0,
    0,
    0,
    0
  );

  const diff =
    today.getTime() -
    brew.getTime();

  return Math.floor(
    diff /
    (1000 * 60 * 60 * 24)
  );
}


function TankCard({
  tank,
  onUpdatePasivation,
  specs
}: TankCardProps) {


  function normalizePasivationDate(
    value:
      | string
      | Date
      | FirestoreTimestamp
      | null
      | undefined
  ): string {

    if (!value) {
      return "";
    }

    if (value instanceof Date) {

      if (
        Number.isNaN(
          value.getTime()
        )
      ) {
        return "";
      }

      const year =
        value.getFullYear();

      const month =
        String(
          value.getMonth() + 1
        ).padStart(2, "0");

      const day =
        String(
          value.getDate()
        ).padStart(2, "0");

      return `${year}-${month}-${day}`;
    }


    // --------------------------------------------------------
    // Firestore Timestamp with toDate()
    // --------------------------------------------------------

    if (
      typeof value === "object" &&
      value !== null &&
      "toDate" in value &&
      typeof value.toDate ===
      "function"
    ) {

      const date =
        value.toDate();

      if (
        Number.isNaN(
          date.getTime()
        )
      ) {
        return "";
      }

      const year =
        date.getFullYear();

      const month =
        String(
          date.getMonth() + 1
        ).padStart(2, "0");

      const day =
        String(
          date.getDate()
        ).padStart(2, "0");

      return `${year}-${month}-${day}`;
    }


    // --------------------------------------------------------
    // Firestore raw timestamp
    // --------------------------------------------------------

    if (
      typeof value === "object" &&
      value !== null &&
      "seconds" in value &&
      value.seconds !== undefined
    ) {

      const date =
        new Date(
          Number(value.seconds) *
          1000
        );

      if (
        Number.isNaN(
          date.getTime()
        )
      ) {
        return "";
      }

      const year =
        date.getFullYear();

      const month =
        String(
          date.getMonth() + 1
        ).padStart(2, "0");

      const day =
        String(
          date.getDate()
        ).padStart(2, "0");

      return `${year}-${month}-${day}`;
    }


    // --------------------------------------------------------
    // String
    // --------------------------------------------------------

    const stringValue =
      String(value).trim();

    if (!stringValue) {
      return "";
    }


    // YYYY-MM-DD

    if (
      /^\d{4}-\d{2}-\d{2}$/.test(
        stringValue
      )
    ) {
      return stringValue;
    }


    // DD/MM/YYYY

    const israelMatch =
      stringValue.match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/
      );

    if (israelMatch) {

      let year =
        Number(
          israelMatch[3]
        );

      if (year < 100) {
        year += 2000;
      }

      return (
        `${year}-` +
        `${String(
          israelMatch[2]
        ).padStart(2, "0")}-` +
        `${String(
          israelMatch[1]
        ).padStart(2, "0")}`
      );
    }


    // ISO / normal date

    const parsed =
      new Date(stringValue);

    if (
      !Number.isNaN(
        parsed.getTime()
      )
    ) {

      const year =
        parsed.getFullYear();

      const month =
        String(
          parsed.getMonth() + 1
        ).padStart(2, "0");

      const day =
        String(
          parsed.getDate()
        ).padStart(2, "0");

      return `${year}-${month}-${day}`;
    }

    return "";
  }


  // ==========================================================
  // LOCAL STATE
  // ==========================================================
  const [showInfo, setShowInfo] = useState(false);
  const [state, setState] =
    useState<TankState>({
      action:
        tank.action ?? "",

      pasivationDate:
        normalizePasivationDate(
          tank.pasivationDate
        ),

      editPasivationDate:
        false,
    });
  const [infoPosition, setInfoPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const infoButtonRef = useRef<HTMLButtonElement | null>(null);
  const [showQuickReport, setShowQuickReport] = useState(false);
  const [quickReportPosition, setQuickReportPosition] = useState<{ top: number; left: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [specificTankNote, setSpecificTankNote] = useState({ note: "", edit: false })


  function computePopupPosition(rect: DOMRect): { top: number; left: number } {
    const popupWidth = 330;
    const gap = 10;
    const margin = 12;

    let left = rect.left - popupWidth - gap;
    if (left < margin) left = rect.right + gap;
    if (left + popupWidth > window.innerWidth - margin) {
      left = window.innerWidth - popupWidth - margin;
    }

    let top = rect.top - 10;
    const estimatedHeight = 420;
    if (top + estimatedHeight > window.innerHeight - margin) {
      top = window.innerHeight - estimatedHeight - margin;
    }
    if (top < margin) top = margin;

    return { top, left };
  }
  // ==========================================================
  // SYNC FIREBASE
  // ==========================================================

  useEffect(() => {

    setState({
      action:
        tank.action ?? "",

      pasivationDate:
        normalizePasivationDate(
          tank.pasivationDate
        ),

      editPasivationDate:
        false,
    });

    setSpecificTankNote({ note: tank.specificTankNote ?? "", edit: false })

  }, [
    tank.action,
    tank.pasivationDate,
    tank.specificTankNote,
  ]);


  const isCLT = Number(tank.tankNumber) === 1;


  /*
   * getTankStage has its own internal Tank type.
   * We intentionally use that function's parameter type here
   * rather than creating a second competing Tank definition.
   */

  const stageInfo = isCLT
    ? {
      name: "CLT",
      icon: "🧼",
      className: "clt",
    }
    : { ...tank.stage };

  // ==========================================================
  // TANK ID
  // ==========================================================

  const fermentorID =
    String(
      tank.tankNumber ??
      tank.uid ??
      tank.id
    );


  const handleOpenInfo = (
    event: React.MouseEvent<HTMLButtonElement>
  ) => {

    event.stopPropagation();

    const rect =
      event.currentTarget.getBoundingClientRect();

    const popupWidth = 330;
    const gap = 10;
    const margin = 12;

    let left =
      rect.left - popupWidth - gap;

    // אין מקום משמאל → עבור לימין
    if (left < margin) {

      left =
        rect.right + gap;
    }

    // עדיין אין מקום מימין → הצמד לצד המסך
    if (
      left + popupWidth >
      window.innerWidth - margin
    ) {

      left =
        window.innerWidth -
        popupWidth -
        margin;
    }

    /*
     * נתחיל בגובה של כפתור ה-info.
     * כלומר החלון יהיה ממש ליד המיכל.
     */
    let top =
      rect.top - 10;

    /*
     * הגנה מלמטה.
     * אנחנו לא מניחים גובה קבוע מדויק,
     * אלא משתמשים בגובה משוער.
     */
    const estimatedHeight = 420;

    if (
      top + estimatedHeight >
      window.innerHeight - margin
    ) {

      top =
        window.innerHeight -
        estimatedHeight -
        margin;
    }

    /*
     * הגנה מלמעלה.
     */
    if (top < margin) {
      top = margin;
    }

    setInfoPosition({
      top,
      left,
    });

    setShowInfo(true);
  };
  async function handleStageChange(
    event: ChangeEvent<HTMLSelectElement>
  ): Promise<void> {

    event.stopPropagation();

    const newAction =
      Number(
        event.target.value
      );

    const previousState = {
      ...state,
    };


    // Immediate UI update

    setState((prev) => ({
      ...prev,
      action: newAction,
    }));


    try {

      await updateTankStatus(
        fermentorID,

        newAction,

        new Date(),

        state.pasivationDate ||
        null
      );



    } catch (error) {

      console.error(
        "Failed to update tank status:",
        error
      );

      setState(
        previousState
      );
    }
  };

  async function handlePasivationDateChange(
    event: ChangeEvent<HTMLInputElement>
  ): Promise<void> {

    event.stopPropagation();

    const newPasivationDate =
      event.target.value;

    const previousState = {
      ...state,
    };


    setState((prev) => ({
      ...prev,
      pasivationDate:
        newPasivationDate,
    }));


    try {

      await updateTankStatus(
        fermentorID,

        Number(
          state.action
        ),

        new Date(),

        newPasivationDate ||
        null
      );


      /*
       * Keep App's local Firebase state
       * synchronized as well.
       */

      if (
        onUpdatePasivation
      ) {

        await onUpdatePasivation(
          tank.id,
          newPasivationDate
        );
      }




    } catch (error) {

      console.error(
        "Failed to update pasivation date:",
        error
      );

      setState(
        previousState
      );
    }
  };

  const handleOpenQuickReport = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setQuickReportPosition(computePopupPosition(rect));
    setShowQuickReport(true);
  };


  const handleOpenHistory = (
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    event.stopPropagation();
    setShowHistory(true);
  };

  function parsePasivationDate(
    value:
      | string
      | Date
      | FirestoreTimestamp
      | null
      | undefined
  ): Date | null {

    if (!value) {
      return null;
    }


    // Date

    if (
      value instanceof Date
    ) {

      return Number.isNaN(
        value.getTime()
      )
        ? null
        : value;
    }


    // Firestore Timestamp

    if (
      typeof value === "object" &&
      value !== null &&
      "toDate" in value &&
      typeof value.toDate ===
      "function"
    ) {

      const date =
        value.toDate();

      return Number.isNaN(
        date.getTime()
      )
        ? null
        : date;
    }


    // Firestore raw timestamp

    if (
      typeof value === "object" &&
      value !== null &&
      "seconds" in value &&
      value.seconds !== undefined
    ) {

      const milliseconds =
        Number(value.seconds) *
        1000 +
        Math.floor(
          Number(
            value.nanoseconds ??
            0
          ) / 1000000
        );

      const date =
        new Date(
          milliseconds
        );

      return Number.isNaN(
        date.getTime()
      )
        ? null
        : date;
    }


    const text =
      String(value).trim();

    if (!text) {
      return null;
    }


    // YYYY-MM-DD

    if (
      /^\d{4}-\d{2}-\d{2}$/.test(
        text
      )
    ) {

      const parts =
        text.split("-");

      const year =
        Number(parts[0]);

      const month =
        Number(parts[1]) - 1;

      const day =
        Number(parts[2]);

      const date =
        new Date(
          year,
          month,
          day
        );

      if (
        date.getFullYear() ===
        year &&
        date.getMonth() ===
        month &&
        date.getDate() ===
        day
      ) {
        return date;
      }

      return null;
    }


    // DD/MM/YYYY

    const israelMatch =
      text.match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/
      );

    if (israelMatch) {

      const day =
        Number(
          israelMatch[1]
        );

      const month =
        Number(
          israelMatch[2]
        ) - 1;

      let year =
        Number(
          israelMatch[3]
        );

      if (year < 100) {
        year += 2000;
      }

      const date =
        new Date(
          year,
          month,
          day
        );

      if (
        date.getFullYear() ===
        year &&
        date.getMonth() ===
        month &&
        date.getDate() ===
        day
      ) {
        return date;
      }

      return null;
    }


    // Normal JS date

    const normalDate =
      new Date(text);

    if (
      !Number.isNaN(
        normalDate.getTime()
      )
    ) {
      return normalDate;
    }

    return null;
  }


  function getDaysSinceDate(
    date: Date | null
  ): number | null {

    if (!date) {
      return null;
    }

    const start =
      new Date(date);

    const today =
      new Date();

    start.setHours(
      0,
      0,
      0,
      0
    );

    today.setHours(
      0,
      0,
      0,
      0
    );

    const diff =
      today.getTime() -
      start.getTime();

    return Math.floor(
      diff /
      (1000 * 60 * 60 * 24)
    );
  }



  const brewAge =
    getBrewAge(
      tank.brewDate
    );

  const pasivationDate =
    parsePasivationDate(
      state.pasivationDate
    );

  const daysSincePasivation =
    getDaysSinceDate(
      pasivationDate
    );

  const daysRemaining =
    daysSincePasivation !== null
      ? (tank.tankNumber === "1" ? 180 : 90) -
      daysSincePasivation
      : null;

  let pasivationClass =
    "pasivation-none";

  let pasivationText =
    "אין תאריך פסיבציה";


  if (
    daysRemaining !== null
  ) {

    if (
      daysRemaining > 30
    ) {

      pasivationClass =
        "pasivation-safe";

      pasivationText =
        `${daysRemaining} ימים נותרו ל${tank.tankNumber === "1" ? "CIP" : "חומצה ניטרית"}`;

    } else if (
      daysRemaining > 1
    ) {

      pasivationClass =
        "pasivation-warning";

      pasivationText =
        `${daysRemaining} ימים נותרו ל${tank.tankNumber === "1" ? "CIP" : "חומצה ניטרית"}`;

    } else if (
      daysRemaining === 1
    ) {

      pasivationClass =
        "pasivation-warning";

      pasivationText =
        `יום אחד נותר ל ${tank.tankNumber === "1" ? "CIP" : "חומצה ניטרית"}`;

    } else if (
      daysRemaining === 0
    ) {

      pasivationClass =
        "pasivation-today";

      pasivationText =
        `היום יש לבצע ${tank.tankNumber === "1" ? "CIP" : "חומצה ניטרית"}`;

    } else {

      pasivationClass =
        "pasivation-overdue";

      const overdueDays =
        Math.abs(
          daysRemaining
        );

      if (
        overdueDays === 1
      ) {

        pasivationText =
          `יום אחד עבר ממועד ה${tank.tankNumber === "1" ? "CIP" : "חומצה ניטרית"}`;

      } else {

        pasivationText =
          `${overdueDays} ימים עברו ממועד ה${tank.tankNumber === "1" ? "CIP" : "חומצה ניטרית"}`;
      }
    }
  }


  const showEmptyTankSelect =
    !isCLT &&
    (
      stageInfo.name === "מלוכלך" ||
      stageInfo.name === "נקי" ||
      stageInfo.name === "מחוטא"
    );

  const pressureIsOk =
    specs && tank.currentData?.pressure != null
      ? isPressureOutOfRange(
        tank.currentData.pressure,
        tank.beerStyle ?? null,
        specs
      )
      : {
        onSpec: false,
        howBad: 0,
      };
  if (Number(tank.currentData?.temp) > 9) {

  }
  const CarbIsOk =
    specs && tank.currentData?.carbonation != null
      ? isCarbonationOutOfRange(
        tank.currentData.carbonation,
        tank.beerStyle ?? "",
        specs
      )
      : {
        outOfSpec: false,
        importance: 1,
      };
  const crates = tank.currentData?.crates;
  const kegs = tank.currentData?.kegs;
  const totalLiters = tank.currentData?.totalLiters;
  const shrinkagePercent = tank.currentData?.shrinkagePercent;


  return (
    <>
      {(showInfo && Number(tank.tankNumber) !== 1) && (
        <FermentorInfoBox
          specs={specs}
          tank={tank}
          onClose={() => {
            setShowInfo(false);
            setInfoPosition(null);
          }}
          position={infoPosition}
        />
      )}

      {showQuickReport && Number(tank.tankNumber) !== 1 && (
        <QuickTankReportBox
          tank={tank}
          specs={specs}
          position={quickReportPosition}
          onClose={() => { setShowQuickReport(false); setQuickReportPosition(null); }}
        />
      )}

      {showHistory && Number(tank.tankNumber) !== 1 && (
        <BatchHistoryChart
          tank={tank}
          onClose={() => setShowHistory(false)}
        />
      )}

      <div
        className={`tank-card ${isCLT
          ? "clt"
          : stageInfo.className
          }`}
        onClick={() => {
          if (tank.sheetUrl) {
            const url = String(tank.sheetUrl);

            const isMobile =
              /Android|iPhone|iPad|iPod/i.test(
                navigator.userAgent
              );

            if (isMobile) {
              window.location.href = url;
            } else {
              window.open(url, "_blank");
            }
          }
        }}

      >

        {/* ==================================================== */}
        {/* HEADER */}
        {/* ==================================================== */}

        <div className="tank-header">

          <span className="tank-number">
            מיכל
            {tank.id === "1" ? " 1- CLT" : `  ${tank.tankNumber}-`}

            {" "}

            {Number(tank.tankNumber) === 1
              ? ""
              : Number(tank.tankNumber) < 5
                ? "בודד"
                : Number(tank.tankNumber) < 9
                  ? "כפול"
                  : "משולש"}

          </span>

          {Number(tank.tankNumber) > 1 && (
            <span className="stage-info-name">
              {stageInfo.icon}
              {"  "}
              {stageInfo.name}
            </span>
          )}



        </div>
        {Number(tank.tankNumber) > 1 && (stageInfo.name === "בתסיסה" || stageInfo.name === "קר") && (
          <div className="tank-actions-row">

            <button type="button" className="tankInfo" aria-label="היסטוריית אצווה" onClick={handleOpenHistory}>
              <ChartNoAxesCombined size={16} />
            </button>

            <button type="button" className="tankInfo tankQuickReport" aria-label="דיווח מהיר" onClick={handleOpenQuickReport}>
              <ClipboardPlus size={16} />
            </button>

            <button
              ref={infoButtonRef}
              type="button"
              className="tankInfo"
              aria-label="הצגת המלצות סלרינג"
              onClick={handleOpenInfo}
            >
              <ListClock size={16} />
            </button>

          </div>
        )}

        {/* ==================================================== */}
        {/* BATCH */}
        {/* ==================================================== */}

        {Number(tank.tankNumber) > 1 && <div className="batch-number">

          #
          {tank.batchNumber ??
            "—"}

          {" "}

          {tank.beerStyle ??
            ""}

        </div>}


        {/* ==================================================== */}
        {/* BREW DATE */}
        {/* ==================================================== */}

        {Number(tank.tankNumber) > 1 && stageInfo.name === "בישול חדש" && (
          <div className={`brew-progress${tank?.brewProgress?.stageName ? "" : " brew-progress-idle"}`}>

            {tank?.brewProgress?.stageName && (
              <span className="brew-progress-live" aria-hidden="true">
                <span className="brew-progress-live-dot" />
              </span>
            )}
            <span className="brew-proces-brew">
                {tank?.brewProgress?.blockIndex &&
              <span className="brew-progress-text">
                  בישול
              </span>
                  }
              {tank?.brewProgress?.blockIndex &&
                <span className="brew-progress-block">
              {`${String.fromCharCode(64 + tank.brewProgress.blockIndex)}`}
                </span>
              }
            </span>

            <span className="brew-progress-text">
              <span className="brew-progress-stage">
                {tank?.brewProgress?.stageName ?? "עדיין לא בבישול"}
              </span>

              {tank?.brewProgress?.stageStartTimeText && (
                <span className="brew-progress-time">
                  {tank.brewProgress.stageStartTimeText}
                  {tank?.brewProgress?.stageEndTimeText
                    ? ` – ${tank.brewProgress.stageEndTimeText}`
                    : ""}
                </span>
              )}
            </span>

          </div>
        )}


        {Number(tank.tankNumber) > 1 && stageInfo.name !==
          "בישול חדש" && (

            <div>

              בישול:{" "}

              {tank.brewDate ??
                "—"}

              {brewAge !== null
                ? ` - ${brewAge} ימים`
                : ""}

            </div>

          )}

        {Number(tank.tankNumber) > 1 && (stageInfo.name === "בתסיסה" || stageInfo.name === "קר") && (

          <div className="tank-data">

            <div>

              <span>
                טמפ':
              </span>{" "}

              {
                tank.currentData
                  ?.temp ?? "—"
              }

              °C

            </div>


            <div>

              <span>
                סוכר:
              </span>{" "}

              {
                tank.currentData
                  ?.plato ?? "—"
              }

              °P

            </div>


            <div>

              <span>
                pH:
              </span>{" "}

              {
                tank.currentData
                  ?.pH ?? "—"
              }

            </div>


            <div>

              <span>
                נפח:
              </span>{" "}

              {
                tank.beerVolume ??
                "—"
              }

              {" "}ל'

            </div>


            {stageInfo.name ===
              "קר" && (

                <div>

                  <span>
                    גיזוז:
                  </span>{" "}

                  <span className={`carbPressureDisplay-${CarbIsOk.importance}`}>
                    {
                      tank.currentData
                        ?.carbonation ??
                      "—"
                    }
                  </span>

                </div>

              )}
            <div>
              <span>
                לחץ:
              </span>{" "}

              {
                stageInfo.name === "בתסיסה" && tank?.currentData?.pressure ? (<span className={`carbPressureDisplay-${pressureIsOk.howBad}`}>{tank.currentData?.pressure ??
                  "—"}</span>) :
                  tank.currentData?.pressure ??
                  "—"
              }

              {" "}bar

            </div>
          </div>


        )}

        {Number(tank.tankNumber) > 1 && showEmptyTankSelect && (

          <div
            className="tank-stage-control"

            onClick={(event) =>
              event.stopPropagation()
            }
          >

            <label>
              סטטוס:
            </label>


            <select
              className={`stage-select ${stageInfo.className}`}

              value={String(
                state.action
              )}

              onChange={
                handleStageChange
              }
            >

              <option value="3">
                ⚪ מלוכלך
              </option>

              <option value="4">
                🟢 נקי
              </option>

              <option value="5">
                🟡 מחוטא
              </option>

            </select>

          </div>

        )}

        {Number(tank.tankNumber) > 1 && (stageInfo.name === "מלוכלך" || stageInfo.name === "נקי" || stageInfo.name === "מחוטא") && (

          <div className="tank-data">

            <div>
              <span>
                ארגזים שנארזו:
              </span>{" "}

              {(Number.isFinite(crates) && crates)
                ? Math.round(crates / 0.33 / 24)
                : "—"}
            </div>


            <div>
              <span>
                חביות שנארזו:
              </span>{" "}

              {(Number.isFinite(kegs) && kegs)
                ? Math.round(kegs / 20)
                : "—"}
            </div>


            <div>
              <span>
                סה"כ ליטר שנארז:
              </span>{" "}

              {(Number.isFinite(totalLiters) && totalLiters)
                ? totalLiters.toFixed(2)
                : "—"}{" ל'"}
            </div>


            <div>
              <span>
                פחת:
              </span>{" "}

              {(Number.isFinite(shrinkagePercent) && shrinkagePercent)
                ? (shrinkagePercent / -1).toFixed(2)
                : "—"} {" %"}
            </div>
          </div>
        )}


        {specificTankNote.note && !specificTankNote.edit && (
          <div className="Tank-note-row">

            <span>הערה למיכל: </span>
            <span>
              {specificTankNote.note}{" "}
              <button
                type="button"

                className="pasivation-edit-button"

                title="עריכת הערה"

                onClick={(event) => {

                  event.stopPropagation();

                  setSpecificTankNote(
                    (prev) => ({
                      ...prev,
                      edit:
                        true,
                    })
                  );

                }}
              >

                <Pencil size={16} />

              </button>
            </span>
          </div>

        )}
        {specificTankNote.edit && (
          <div className="Tank-note-row">

            <input
              value={specificTankNote.note ?? ""}
              onClick={(event) => {
                event.stopPropagation();
              }}
              onChange={(e) => {
                setSpecificTankNote(
                  (prev) => ({
                    ...prev,
                    note:
                      e.target.value,
                  })
                );
              }}
            ></input>
            <span>
              <button
                type="button"

                className="pasivation-edit-button"

                title="שמירת הערה"

                onClick={async (event) => {

                  event.stopPropagation();

                  setSpecificTankNote(
                    (prev) => ({
                      ...prev,
                      edit:
                        true,
                    })
                  );
                  await updateSpecficNote(specificTankNote.note, tank.id)
                  setSpecificTankNote(
                    (prev) => ({
                      ...prev,
                      edit:
                        false,
                    })
                  );
                }}
              >

                <SaveCheck size={16} />

              </button>
            </span>
          </div>

        )}
        {!specificTankNote.note && !specificTankNote.edit && (
          <div className="Tank-note-row">
            <span>הוספת הערה למיכל: </span>
            <span>
              <button
                type="button"

                className="pasivation-edit-button"

                title="הוספת הערה"

                onClick={async (event) => {

                  event.stopPropagation();

                  setSpecificTankNote(
                    (prev) => ({
                      ...prev,
                      edit:
                        true,
                    })
                  );
                }}
              >

                <MessageCirclePlus size={16} />

              </button>
            </span>
          </div>

        )}





        {/* ==================================================== */}
        {/* PASIVATION DATE */}
        {/* ==================================================== */}

        <div className="pasivation-date-row">

          <span className="pasivation-date-label">
            {Number(tank.tankNumber) > 1 ? `תאריך חומצה ניטרית:` : "תאריך CIP + ניטרית"}
          </span>


          {/* EMPTY / CLEAN / SANITIZED */}

          {showEmptyTankSelect && (

            <input
              type="date"

              className="tank-status-input"

              value={
                state.pasivationDate
              }

              onChange={
                handlePasivationDateChange
              }

              onClick={(event) =>
                event.stopPropagation()
              }
            />

          )}


          {/* FULL TANK */}

          {!showEmptyTankSelect && (

            <>

              {!state.editPasivationDate ? (

                <div className="pasivation-display">

                  <span className="pasivation-date-value">

                    {state.pasivationDate
                      ? state.pasivationDate
                        .split("-")
                        .reverse()
                        .join("/")
                      : "אין תאריך"}
                    {" "}
                  </span>


                  <button
                    type="button"

                    className="pasivation-edit-button"

                    title="עריכת תאריך"

                    onClick={(event) => {

                      event.stopPropagation();

                      setState(
                        (prev) => ({
                          ...prev,

                          editPasivationDate:
                            true,
                        })
                      );

                    }}
                  >

                    <Pencil size={16} />

                  </button>

                </div>

              ) : (

                <input
                  type="date"

                  className="tank-status-input"

                  value={
                    state.pasivationDate
                  }

                  onChange={
                    handlePasivationDateChange
                  }

                  onClick={(event) =>
                    event.stopPropagation()
                  }

                  onBlur={() => {

                    setState(
                      (prev) => ({
                        ...prev,

                        editPasivationDate:
                          false,
                      })
                    );

                  }}

                  autoFocus
                />

              )}

            </>

          )}

        </div>


        {/* ==================================================== */}
        {/* PASIVATION STATUS */}
        {/* ==================================================== */}

        <div
          className={`pasivation-status ${pasivationClass}`}
        >
          {pasivationText}
        </div>

      </div>
    </>
  );
}

export default memo(TankCard);