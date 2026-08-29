import { useMemo, useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import type { Fermentor } from "../App";
import {
  checkBatchAssignment,
  findNextBatchForTank,
  extractBatchFromFilename,
  type BatchCheckResult,
  type NextBatchResult,
} from "../SERVICES/manualBatch";
import { openSheetsPicker, type PickedFile } from "../SERVICES/googleDrivePicker";
import { refreshSingleTank } from "../SERVICES/refreshSingleTank";

type Step =
  | "select"
  | "confirmWarning1"
  | "checking"
  | "confirmIssues"
  | "chooseStatus"
  | "submitting"
  | "done"
  | "error";

type StatusOption = { label: string; action: number; tankStatus: boolean };

const STATUS_OPTIONS: StatusOption[] = [
  { label: "בישול חדש", action: 0, tankStatus: false },
  { label: "מלא (יוצג כ'בתסיסה'/'קר' לפי טמפ' בפועל)", action: 1, tankStatus: false },
  { label: "מלוכלך", action: 3, tankStatus: true },
  { label: "נקי", action: 4, tankStatus: true },
  { label: "מחוטא", action: 5, tankStatus: true },
];

type Props = {
  brews: Fermentor[];
};

export default function ManualBatchAssignment({ brews }: Props) {
  const [selectedTankId, setSelectedTankId] = useState<string>("");
  const [step, setStep] = useState<Step>("select");
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [checkResult, setCheckResult] = useState<BatchCheckResult | null>(null);
  const [betterBatch, setBetterBatch] = useState<NextBatchResult>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [pickerBusy, setPickerBusy] = useState(false);

  const tanks = useMemo(
    () => brews.filter((tank) => Number(tank.tankNumber) !== 1),
    [brews]
  );

  const selectedTank = tanks.find((tank) => tank.id === selectedTankId) || null;

  function resetFlow() {
    setStep("select");
    setPicked(null);
    setCheckResult(null);
    setBetterBatch(null);
    setErrorMsg("");
  }

  function handleSelectTank(id: string) {
    setSelectedTankId(id);
    resetFlow();
  }

  async function handlePickFile() {
    try {
      setPickerBusy(true);
      const file = await openSheetsPicker();
      setPickerBusy(false);
      if (!file) return;

      const batch = extractBatchFromFilename(file.name);
      if (batch === null) {
        setErrorMsg(
          `לא זוהה מספר אצווה בשם הקובץ "${file.name}". יש לבחור קובץ ששמו כולל # ולפחות 4 ספרות (למשל 1578#).`
        );
        setStep("error");
        return;
      }

      setPicked(file);
      setStep("confirmWarning1");
    } catch (error: any) {
      setPickerBusy(false);
      setErrorMsg(error?.message || "שגיאה בפתיחת הדרייב");
      setStep("error");
    }
  }

  async function handleConfirmWarning1() {
    if (!selectedTank || !picked) return;

    const batch = extractBatchFromFilename(picked.name);
    if (batch === null) return;

    setStep("checking");
    setErrorMsg("");

    try {
      const tankNumber = String(selectedTank.tankNumber ?? selectedTank.id);

      const result = await checkBatchAssignment(tankNumber, batch);

      if (result.reason === "Batch not found") {
        setErrorMsg(`האצווה ${batch} לא נמצאה בכלל בתיקיית הבישולים.`);
        setStep("error");
        return;
      }
      if (result.reason === "Could not read batch sheet") {
        setErrorMsg(`לא ניתן לקרוא את גיליון האצווה ${batch}.`);
        setStep("error");
        return;
      }

      setCheckResult(result);

      const better = await findNextBatchForTank(tankNumber, batch);

      const hasTankMismatch = result.reason === "Batch belongs to a different tank";
      const hasBetterBatch = Boolean(better && better.found);

      if (hasBetterBatch) {
        setBetterBatch(better);
      }

      if (hasTankMismatch || hasBetterBatch) {
        setStep("confirmIssues");
      } else {
        setStep("chooseStatus");
      }
    } catch (error: any) {
      setErrorMsg(error?.message || "שגיאה בבדיקת האצווה");
      setStep("error");
    }
  }

  async function handleChooseStatus(option: StatusOption) {
    if (!selectedTank || !checkResult?.sheetUrl) return;

    setStep("submitting");
    setErrorMsg("");

    try {
      const tankNumber = String(selectedTank.tankNumber ?? selectedTank.id);
      const tankRef = doc(db, "fermentors", selectedTank.id);

      await updateDoc(tankRef, {
        sheetUrl: checkResult.sheetUrl,
        action: option.action,
        tankStatus: option.tankStatus,
      });

      await refreshSingleTank(tankNumber, checkResult.sheetUrl);

      setStep("done");
    } catch (error: any) {
      setErrorMsg(error?.message || "שגיאה בעדכון המיכל");
      setStep("error");
    }
  }

  const displayedBatchNumber = checkResult?.batchNumber ?? checkResult?.requestedBatch;

  return (
    <div className="edit-specs-page">
      <div className="edit-specs-header">
        <h1 className="editSpecsHeaderH1">שיבוץ אצווה ידני במיכל</h1>
        <p className="editSpecsHeaderH2">
          פעולה זו מיועדת למקרי קצה בלבד. בדרך כלל השיבוץ קורה אוטומטית ברגע
          שנוצר טופס בישול חדש עם מספר המיכל הרשום בו, כאשר המיכל מסומן
          כ"מחוטא".
        </p>
      </div>

      <div className="spec-card">
        <div className="spec-card-header">
          <div>
            <h2>בחירת מיכל</h2>
            <p>בחר את המיכל שברצונך לשבץ אליו אצווה ידנית</p>
          </div>
        </div>
        <div className="spec-fields" style={{ gridTemplateColumns: "1fr" }}>
          <div className="spec-field">
            <label className="spec-field-label">מיכל</label>
            <select
              className="quickReportSelect"
              value={selectedTankId}
              onChange={(event) => handleSelectTank(event.target.value)}
            >
              <option value="">בחר מיכל...</option>
              {tanks.map((tank) => (
                <option key={tank.id} value={tank.id}>
                  מיכל {String(tank.tankNumber)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {selectedTank && (
        <div className="spec-card" style={{ marginTop: 14 }}>
          <div className="spec-card-header">
            <div>
              <h2>מצב נוכחי במיכל {String(selectedTank.tankNumber)}</h2>
            </div>
          </div>
          <div className="spec-fields">
            <div className="spec-field">
              <span className="spec-field-label">אצווה נוכחית</span>
              <span>#{selectedTank.batchNumber ?? "—"}</span>
            </div>
            <div className="spec-field">
              <span className="spec-field-label">סגנון</span>
              <span>{selectedTank.beerStyle ?? "—"}</span>
            </div>
            <div className="spec-field">
              <span className="spec-field-label">תאריך בישול</span>
              <span>{selectedTank.brewDate ?? "—"}</span>
            </div>
          </div>
        </div>
      )}

      {selectedTank && step === "select" && (
        <div className="spec-card" style={{ marginTop: 14 }}>
          <div className="spec-card-header">
            <div>
              <h2>בחירת טופס בישול מהדרייב</h2>
              <p>מספר האצווה ייקבע אוטומטית משם הקובץ שתבחר, ויאומת מול השרת</p>
            </div>
          </div>
          <div style={{ padding: "0 16px 16px" }}>
            <button className="btn-primary" onClick={handlePickFile} disabled={pickerBusy}>
              {pickerBusy ? "פותח דרייב..." : "בחר טופס מהדרייב"}
            </button>
          </div>
        </div>
      )}

      {step === "confirmWarning1" && picked && (
        <div
          className="write-warning-banner"
          style={{ marginTop: 14, flexDirection: "column", alignItems: "stretch" }}
        >
          <p>
            <strong>שים לב: שיבוץ ידני של אצווה הוא פעולה חריגה מאוד.</strong>{" "}
            שימוש בכלי זה עוקף את הבדיקה האוטומטית ועלול לגרום לשיבוץ שגוי אם
            לא מוודאים היטב.
          </p>
          <p>
            הקובץ שנבחר: <strong>{picked.name}</strong>
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn-primary" onClick={handleConfirmWarning1}>
              אני מבין, המשך בכל זאת
            </button>
            <button className="btn-secondary" onClick={resetFlow}>
              ביטול
            </button>
          </div>
        </div>
      )}

      {step === "checking" && (
        <div className="edit-specs-status">בודק את האצווה מול השרת...</div>
      )}

      {step === "confirmIssues" && checkResult && (
        <div
          className="write-warning-banner"
          style={{ marginTop: 14, flexDirection: "column", alignItems: "stretch" }}
        >
          {checkResult.reason === "Batch belongs to a different tank" && (
            <p>
              <strong>שים לב:</strong> לפי הנתונים בטופס, אצווה #
              {displayedBatchNumber} שייכת למיכל {checkResult.actualTank}, ולא
              למיכל {String(selectedTank?.tankNumber)} שבחרת.
            </p>
          )}

          {betterBatch && betterBatch.found && (
            <>
              <p>
                <strong>נמצאה אצווה מתאימה יותר למיכל זה!</strong> קיים טופס
                בישול עם מספר אצווה גבוה יותר ששייך גם הוא למיכל{" "}
                {String(selectedTank?.tankNumber)}. סביר שזו האצווה הנוכחית
                האמיתית של המיכל.
              </p>
              <p>
                <strong>האצווה שבחרת:</strong> #{displayedBatchNumber} —{" "}
                {checkResult.beerStyle ?? "—"}, {checkResult.brewDate ?? "—"}
              </p>
              <p>
                <strong>האצווה המתאימה יותר:</strong> #{betterBatch.batchNumber}{" "}
                — {betterBatch.beerStyle ?? "—"}, {betterBatch.brewDate ?? "—"}
              </p>
              <p>
                מומלץ לבדוק ולתקן את מספרי המיכל בטפסים בגוגל שיטס — המערכת
                מתעדכנת אוטומטית מול הדרייב כל כ-10 דקות, כך שתיקון שם יגרום
                לשיבוץ הנכון לבד, בלי צורך בפעולה ידנית.
              </p>
            </>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn-primary" onClick={() => setStep("chooseStatus")}>
              אני מבין, המשך עם השיבוץ הידני בכל זאת
            </button>
            <button className="btn-secondary" onClick={resetFlow}>
              ביטול, אבדוק בגיליונות קודם
            </button>
          </div>
        </div>
      )}

      {step === "chooseStatus" && checkResult && (
        <div className="spec-card" style={{ marginTop: 14 }}>
          <div className="spec-card-header">
            <div>
              <h2>לאיזה סטטוס לשים את המיכל?</h2>
              <p>
                אצווה #{displayedBatchNumber} תשובץ למיכל{" "}
                {String(selectedTank?.tankNumber)}
              </p>
            </div>
          </div>
          <div
            style={{
              padding: "0 16px 16px",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.label}
                className="status-filter-button"
                onClick={() => handleChooseStatus(option)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "submitting" && (
        <div className="edit-specs-status">משבץ ומרענן נתוני מיכל...</div>
      )}

      {step === "done" && (
        <div className="edit-specs-message success" style={{ marginTop: 14 }}>
          המיכל שובץ בהצלחה לאצווה החדשה.
          <div style={{ marginTop: 10 }}>
            <button className="btn-secondary" onClick={resetFlow}>
              שיבוץ נוסף
            </button>
          </div>
        </div>
      )}

      {step === "error" && (
        <div className="edit-specs-message error" style={{ marginTop: 14 }}>
          {errorMsg || "אירעה שגיאה"}
          <div style={{ marginTop: 10 }}>
            <button className="btn-secondary" onClick={resetFlow}>
              נסה שוב
            </button>
          </div>
        </div>
      )}
    </div>
  );
}