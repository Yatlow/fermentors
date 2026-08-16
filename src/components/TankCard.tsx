import {
  useEffect,
  useState,
  type ChangeEvent,
} from "react";

import { getTankStage } from "../tankstage";
import { updateTankStatus } from "../updateTank";

import type {
  Fermentor,
  FirestoreTimestamp,
} from "../App";

// ============================================================
// PROPS
// ============================================================

type TankCardProps = {
  tank: Fermentor;

  onUpdatePasivation?: (
    tankId: string,
    newDate: string
  ) => Promise<void>;
};


// ============================================================
// STATE
// ============================================================

type TankState = {
  action: string | number;

  pasivationDate: string;

  editPasivationDate: boolean;
};


// ============================================================
// COMPONENT
// ============================================================

export default function TankCard({
  tank,
  onUpdatePasivation,
}: TankCardProps) {

  // ==========================================================
  // NORMALIZE PASIVATION DATE
  // ==========================================================

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


    // --------------------------------------------------------
    // JavaScript Date
    // --------------------------------------------------------

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

  }, [
    tank.action,
    tank.pasivationDate,
  ]);


  // ==========================================================
  // DISPLAY TANK
  // ==========================================================

  const displayTank = {
    ...tank,

    action:
      state.action,

    pasivationDate:
      state.pasivationDate,
  };
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
    : getTankStage(
      displayTank as Parameters<
        typeof getTankStage
      >[0]
    );

  // ==========================================================
  // TANK ID
  // ==========================================================

  const fermentorID =
    String(
      tank.tankNumber ??
      tank.uid ??
      tank.id
    );


  // ==========================================================
  // STATUS SELECT
  //
  // ONLY:
  // 3 = ריק
  // 4 = נקי
  // 5 = מחוטא
  // ==========================================================

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

      console.log(
        "Tank status updated:",
        fermentorID,
        newAction
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
  }


  // ==========================================================
  // PASIVATION DATE CHANGE
  // ==========================================================

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


      console.log(
        "Pasivation date updated:",
        fermentorID,
        newPasivationDate
      );

    } catch (error) {

      console.error(
        "Failed to update pasivation date:",
        error
      );

      setState(
        previousState
      );
    }
  }


  // ==========================================================
  // BREW AGE
  // ==========================================================

  function getBrewAge(
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


  // ==========================================================
  // PARSE PASIVATION DATE
  // ==========================================================

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


  // ==========================================================
  // DAYS SINCE PASIVATION
  // ==========================================================

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


  // ==========================================================
  // CALCULATIONS
  // ==========================================================

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


  // ==========================================================
  // PASIVATION STATUS
  // ==========================================================

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
          `${overdueDays} ימים עברו ממועד ה ${tank.tankNumber === "1" ? "CIP" : "חומצה ניטרית"}`;
      }
    }
  }


  // ==========================================================
  // EMPTY TANK SELECT
  //
  // ONLY:
  // ריק
  // נקי
  // מחוטא
  // ==========================================================

  const showEmptyTankSelect =
    !isCLT &&
    (
      stageInfo.name === "מלוכלך" ||
      stageInfo.name === "נקי" ||
      stageInfo.name === "מחוטא"
    );


  // ==========================================================
  // RENDER
  // ==========================================================
  return (

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


        {Number(tank.tankNumber) > 1 && <span className="stage-info-name">

          {stageInfo.icon}

          {stageInfo.name}

        </span>}

      </div>


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


      {/* ==================================================== */}
      {/* DATA */}
      {/* ==================================================== */}

      {Number(tank.tankNumber) > 1 && stageInfo.name !==
        "בישול חדש" && (

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

                  {
                    tank.currentData
                      ?.carbonation ??
                    "—"
                  }

                </div>

              )}

          </div>

        )}


      {/* ==================================================== */}
      {/* STATUS SELECT */}
      {/* ONLY EMPTY / CLEAN / SANITIZED */}
      {/* ==================================================== */}

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

            <option disabled value="3">
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

                  {state.pasivationDate ||
                    "אין תאריך"}

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

                  ✎

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
  );
}