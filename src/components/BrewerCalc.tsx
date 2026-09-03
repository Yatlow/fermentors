
import { useState } from "react";
import type { Fermentor } from "../App";

type FVType = "triple" | "double" | "6";

type OptionalNumber = number | "";

type CalcValues = {
    BoilVol: {
        label: string;
        testVol: OptionalNumber;
        testPlato: OptionalNumber;
        DesiredPlato: OptionalNumber;
        EvaporationFactor: OptionalNumber;
    };

    TankVol: {
        label: string;
        cmFromEndOfStick: OptionalNumber;
        maxStickReading: OptionalNumber;
        fvType: FVType;
        measurementFactor: OptionalNumber;
    };

    alphaCalc: {
        label: string;
        currentAlpha: OptionalNumber;
        grPerLAtCurrentAlpha: OptionalNumber;
        newAlpha: OptionalNumber;
        grPerLAtNewAlpha: OptionalNumber;
    };

    calcPacagingVol: {
        label: string;
        packagingLoss: OptionalNumber;
        packagingVol: OptionalNumber;
        tankVol: OptionalNumber;
        boxes: OptionalNumber;
        selectedTank: number;
        leftToPack: number;
        leftToPackLabel: "ארגזים" | "חביות";
    };
};

export default function BrewCalc({ brews }: { brews: Fermentor[] }) {
    const [calcValues, setCalcValues] = useState<CalcValues>({
        BoilVol: {
            label: "נפח רתיחה",
            testVol: 1200,
            testPlato: 15.7,
            DesiredPlato: 15.45,
            EvaporationFactor: 100,
        },

        TankVol: {
            label: "גובה (נפח) מיכל",
            cmFromEndOfStick: 55,
            maxStickReading: 2300,
            fvType: "triple",
            measurementFactor: 5,
        },

        alphaCalc: {
            label: "חישוב אלפא",
            currentAlpha: 5.5,
            grPerLAtCurrentAlpha: 0.634,
            newAlpha: 6.9,
            grPerLAtNewAlpha: 0.505,
        },

        calcPacagingVol: {
            label: "חישוב נפח משוער לאריזה",
            tankVol: 2217.6,
            packagingVol: 1995.84,
            packagingLoss: 10,
            boxes: 252,
            selectedTank: 0,
            leftToPack: 0,
            leftToPackLabel: "חביות",
        },
    });

    const updateField = <
        C extends keyof CalcValues,
        F extends keyof CalcValues[C]
    >(
        calculator: C,
        field: F,
        value: CalcValues[C][F]
    ) => {
        setCalcValues((prev) => ({
            ...prev,
            [calculator]: {
                ...prev[calculator],
                [field]: value,
            },
        }));
    };

    const boilVolume =
        calcValues.BoilVol.testVol !== "" &&
            calcValues.BoilVol.testPlato !== "" &&
            calcValues.BoilVol.DesiredPlato !== "" &&
            calcValues.BoilVol.EvaporationFactor !== ""
            ? (
                (calcValues.BoilVol.testVol *
                    calcValues.BoilVol.testPlato) /
                calcValues.BoilVol.DesiredPlato
            ) + calcValues.BoilVol.EvaporationFactor
            : null;

    const tankVolume =
        calcValues.TankVol.cmFromEndOfStick !== "" &&
            calcValues.TankVol.measurementFactor !== "" &&
            calcValues.TankVol.maxStickReading !== ""
            ? (
                (calcValues.TankVol.cmFromEndOfStick /
                    calcValues.TankVol.measurementFactor) * 100
            ) + calcValues.TankVol.maxStickReading
            : null;

    const alphaResult =
        calcValues.alphaCalc.grPerLAtCurrentAlpha !== "" &&
        calcValues.alphaCalc.currentAlpha !== "" &&
        calcValues.alphaCalc.newAlpha !== "" &&
        calcValues.alphaCalc.newAlpha !== 0
            ? (
                calcValues.alphaCalc.grPerLAtCurrentAlpha *
                calcValues.alphaCalc.currentAlpha
            ) / calcValues.alphaCalc.newAlpha
            : null;

    function getPackagingVolumes(packagingVol: number) {
        return {
            boxes: (packagingVol / 0.33) / 24,
            emptyBottleRows: (packagingVol / 0.33) / 361,
            fullBottleRows: (packagingVol / 0.33) / 24 / 12,
            kegs: packagingVol / 20,
        };
    }

    return (
        <div className="edit-specs-page" dir="rtl">

            <div className="edit-specs-header">
                <div>
                    <p className="editSpecsHeaderH1">
                        מחשבון למבשלן
                    </p>

                    <p className="editSpecsHeaderH2">
                        חישוב פעולות נפוצות
                    </p>
                </div>
            </div>

            <div className="specs-list">

                {/* =========================
                    נפח רתיחה
                ========================= */}

                <section className="spec-card">

                    <div className="spec-card-header">
                        <h2>{calcValues.BoilVol.label}</h2>
                    </div>

                    <div className="spec-fields">

                        <NumberField
                            label="נפח תירוש בסיר בזמן בדיקה"
                            value={calcValues.BoilVol.testVol}
                            onChange={(value) =>
                                updateField(
                                    "BoilVol",
                                    "testVol",
                                    value
                                )
                            }
                        />

                        <NumberField
                            label="פלאטו בבדיקה"
                            value={calcValues.BoilVol.testPlato}
                            onChange={(value) =>
                                updateField(
                                    "BoilVol",
                                    "testPlato",
                                    value
                                )
                            }
                        />

                        <NumberField
                            label="פלאטו רצוי"
                            value={calcValues.BoilVol.DesiredPlato}
                            onChange={(value) =>
                                updateField(
                                    "BoilVol",
                                    "DesiredPlato",
                                    value
                                )
                            }
                        />

                        <NumberField
                            label="פקטור אידוי"
                            value={calcValues.BoilVol.EvaporationFactor}
                            onChange={(value) =>
                                updateField(
                                    "BoilVol",
                                    "EvaporationFactor",
                                    value
                                )
                            }
                        />

                    </div>

                    <div className="calc-result">
                        נפח תחילת רתיחה מחושב:{" "}
                        <strong>
                            {boilVolume !== null
                                ? `${boilVolume.toFixed(1)} ליטר`
                                : "חסר נתון"}
                        </strong>
                    </div>

                </section>


                {/* =========================
                    נפח מיכל
                ========================= */}

                <section className="spec-card">

                    <div className="spec-card-header">
                        <h2>{calcValues.TankVol.label}</h2>

                        <p className="spec-card-subtitle spec-warning">
                            בעת המדידה יש לוודא כי הנשם פתוח וצינור
                            בלואו אוף לא טבול במים ושבצינור המדידה
                            אין קצף
                        </p>
                    </div>

                    <div className="spec-fields">

                        <NumberField
                            label="מדידת ס״מ מהמקל"
                            value={calcValues.TankVol.cmFromEndOfStick}
                            onChange={(value) =>
                                updateField(
                                    "TankVol",
                                    "cmFromEndOfStick",
                                    value
                                )
                            }
                        />

                        <NumberField
                            label="גובה מקסימום במקל"
                            value={calcValues.TankVol.maxStickReading}
                            onChange={(value) =>
                                updateField(
                                    "TankVol",
                                    "maxStickReading",
                                    value
                                )
                            }
                        />

                        <label className="spec-field">

                            <span className="spec-field-label">
                                סוג מיכל
                            </span>

                            <select
                                className="spec-input"
                                value={calcValues.TankVol.fvType}
                                onChange={(e) => {

                                    const fvType =
                                        e.target.value as FVType;

                                    const measurementFactor =
                                        fvType === "triple"
                                            ? 5
                                            : fvType === "double"
                                                ? 9
                                                : 7.6;

                                    const maxStickReading =
                                        fvType === "triple"
                                            ? 2300
                                            : fvType === "double"
                                                ? 1250
                                                : 1300;

                                    setCalcValues((prev) => ({
                                        ...prev,

                                        TankVol: {
                                            ...prev.TankVol,
                                            fvType,
                                            measurementFactor,
                                            maxStickReading,
                                        },
                                    }));
                                }}
                            >

                                <option value="triple">
                                    משולש
                                </option>

                                <option value="double">
                                    כפול
                                </option>

                                <option value="6">
                                    6מיכל
                                </option>

                            </select>

                        </label>

                    </div>

                    <div className="calc-result">
                        נפח מיכל מחושב:{" "}
                        <strong>
                            {tankVolume !== null
                                ? `${tankVolume.toFixed(1)} ליטר`
                                : "חסר נתון"}
                        </strong>
                    </div>

                </section>


                {/* =========================
                    חישוב אלפא
                ========================= */}

                <section className="spec-card">

                    <div className="spec-card-header">
                        <h2>{calcValues.alphaCalc.label}</h2>
                    </div>

                    <div className="spec-fields">

                        <NumberField
                            label="Alpha נוכחי"
                            value={calcValues.alphaCalc.currentAlpha}
                            onChange={(value) =>
                                updateField(
                                    "alphaCalc",
                                    "currentAlpha",
                                    value
                                )
                            }
                        />

                        <NumberField
                            label="גרם לליטר באלפא הנוכחי"
                            value={calcValues.alphaCalc.grPerLAtCurrentAlpha}
                            onChange={(value) =>
                                updateField(
                                    "alphaCalc",
                                    "grPerLAtCurrentAlpha",
                                    value
                                )
                            }
                        />

                        <NumberField
                            label="Alpha חדש"
                            value={calcValues.alphaCalc.newAlpha}
                            onChange={(value) =>
                                updateField(
                                    "alphaCalc",
                                    "newAlpha",
                                    value
                                )
                            }
                        />

                    </div>

                    <div className="calc-result">
                        גרם לליטר באלפא החדשה:{" "}
                        <strong>
                            {alphaResult !== null
                                ? alphaResult.toFixed(3)
                                : "חסר נתון"}
                        </strong>
                    </div>

                </section>


                {/* =========================
                    אריזה
                ========================= */}

                <section className="spec-card">

                    <div className="spec-card-header">
                        <h2>
                            {calcValues.calcPacagingVol.label}
                        </h2>
                    </div>

                    <div className="spec-fields">

                        <select
                            className="spec-field"
                            value={calcValues.calcPacagingVol.selectedTank}
                            onChange={(e) => {

                                const selectedBrew = brews.find(
                                    (brew) =>
                                        String(brew.batchNumber) ===
                                        e.target.value
                                );

                                if (selectedBrew) {

                                    const tankVol =
                                        Number(selectedBrew.beerVolume);

                                    const packagingVol =
                                        Number(
                                            (
                                                tankVol -
                                                (
                                                    tankVol *
                                                    Number(calcValues
                                                        .calcPacagingVol
                                                        .packagingLoss) /
                                                    100
                                                )
                                            ).toFixed(2)
                                        );

                                    const boxes =
                                        Number(
                                            (
                                                packagingVol /
                                                0.33 /
                                                24
                                            ).toFixed(1)
                                        );

                                    const leftToPack =
                                        Number(
                                            packagingVol
                                            - Number(
                                                selectedBrew
                                                    ?.currentData
                                                    ?.crates ?? 0
                                            )
                                            - Number(
                                                selectedBrew
                                                    ?.currentData
                                                    ?.kegs ?? 0
                                            )
                                        );

                                    const leftToPackLabel =
                                        Number(
                                            selectedBrew
                                                ?.currentData
                                                ?.kegs
                                        ) > 0
                                            ? "ארגזים"
                                            : "חביות";

                                    const leftToPackUnit =
                                        Number(
                                            selectedBrew
                                                ?.currentData
                                                ?.kegs
                                        ) > 0
                                            ? leftToPack /
                                            0.33 /
                                            24
                                            : leftToPack / 20;

                                    updateField(
                                        "calcPacagingVol",
                                        "selectedTank",
                                        Number(e.target.value)
                                    );

                                    updateField(
                                        "calcPacagingVol",
                                        "tankVol",
                                        tankVol
                                    );

                                    updateField(
                                        "calcPacagingVol",
                                        "packagingVol",
                                        packagingVol
                                    );

                                    updateField(
                                        "calcPacagingVol",
                                        "boxes",
                                        boxes
                                    );

                                    updateField(
                                        "calcPacagingVol",
                                        "leftToPack",
                                        leftToPackUnit
                                    );

                                    updateField(
                                        "calcPacagingVol",
                                        "leftToPackLabel",
                                        leftToPackLabel
                                    );
                                }
                            }}
                        >

                            <option value={0}>
                                בחר בירה
                            </option>

                            {brews
                                .filter((brew) => brew.action === 1)
                                .map((brew) => (
                                    <option
                                        key={brew.id}
                                        value={brew?.batchNumber ?? 0}
                                    >
                                        {`מיכל ${brew?.tankNumber}- #${brew?.batchNumber} ${brew?.beerStyle}`}
                                    </option>
                                ))}

                        </select>


                        <NumberField
                            label="נפח במיכל"
                            value={calcValues.calcPacagingVol.tankVol}
                            onChange={(value) => {

                                if (value === "") {
                                    updateField(
                                        "calcPacagingVol",
                                        "tankVol",
                                        ""
                                    );
                                    return;
                                }

                                const packagingLoss =
                                    calcValues
                                        .calcPacagingVol
                                        .packagingLoss;

                                updateField(
                                    "calcPacagingVol",
                                    "tankVol",
                                    value
                                );

                                if (packagingLoss === "") {
                                    updateField(
                                        "calcPacagingVol",
                                        "packagingVol",
                                        ""
                                    );
                                    updateField(
                                        "calcPacagingVol",
                                        "boxes",
                                        ""
                                    );
                                    return;
                                }

                                const packagingVol =
                                    Number(
                                        (
                                            value -
                                            (
                                                value *
                                                packagingLoss /
                                                100
                                            )
                                        ).toFixed(2)
                                    );

                                const boxes =
                                    Number(
                                        (
                                            packagingVol /
                                            0.33 /
                                            24
                                        ).toFixed(1)
                                    );

                                updateField(
                                    "calcPacagingVol",
                                    "packagingVol",
                                    packagingVol
                                );

                                updateField(
                                    "calcPacagingVol",
                                    "boxes",
                                    boxes
                                );
                            }}
                        />


                        <NumberField
                            label="נפח לאריזה"
                            value={calcValues.calcPacagingVol.packagingVol}
                            onChange={(value) => {

                                if (value === "") {
                                    updateField(
                                        "calcPacagingVol",
                                        "packagingVol",
                                        ""
                                    );
                                    return;
                                }

                                const packagingLoss =
                                    calcValues
                                        .calcPacagingVol
                                        .packagingLoss;

                                const boxes =
                                    Number(
                                        (
                                            value /
                                            0.33 /
                                            24
                                        ).toFixed(1)
                                    );

                                updateField(
                                    "calcPacagingVol",
                                    "packagingVol",
                                    value
                                );

                                updateField(
                                    "calcPacagingVol",
                                    "selectedTank",
                                    0
                                );

                                updateField(
                                    "calcPacagingVol",
                                    "boxes",
                                    boxes
                                );

                                // אם אחוז הפחת ריק, לא ניתן להסיק את נפח המיכל.
                                if (packagingLoss === "" || packagingLoss === 100) {
                                    updateField(
                                        "calcPacagingVol",
                                        "tankVol",
                                        ""
                                    );
                                    return;
                                }

                                const tankVol =
                                    Number(
                                        (
                                            value /
                                            (
                                                1 -
                                                packagingLoss / 100
                                            )
                                        ).toFixed(2)
                                    );

                                updateField(
                                    "calcPacagingVol",
                                    "tankVol",
                                    tankVol
                                );
                            }}
                        />


                        <NumberField
                            label="אחוז פחת"
                            value={calcValues.calcPacagingVol.packagingLoss}
                            onChange={(value) => {

                                if (value === "") {
                                    updateField(
                                        "calcPacagingVol",
                                        "packagingLoss",
                                        ""
                                    );
                                    return;
                                }

                                const tankVol =
                                    calcValues
                                        .calcPacagingVol
                                        .tankVol;

                                updateField(
                                    "calcPacagingVol",
                                    "packagingLoss",
                                    value
                                );

                                // אין מספיק נתונים לחישוב מחדש.
                                if (tankVol === "") {
                                    return;
                                }

                                const packagingVol =
                                    Number(
                                        (
                                            tankVol -
                                            (
                                                tankVol *
                                                value /
                                                100
                                            )
                                        ).toFixed(2)
                                    );

                                const boxes =
                                    Number(
                                        (
                                            packagingVol /
                                            0.33 /
                                            24
                                        ).toFixed(1)
                                    );

                                updateField(
                                    "calcPacagingVol",
                                    "packagingVol",
                                    packagingVol
                                );

                                updateField(
                                    "calcPacagingVol",
                                    "boxes",
                                    boxes
                                );
                            }}
                        />


                        <NumberField
                            label="מספר ארגזים"
                            value={calcValues.calcPacagingVol.boxes}
                            onChange={(value) => {

                                if (value === "") {
                                    updateField(
                                        "calcPacagingVol",
                                        "boxes",
                                        ""
                                    );
                                    return;
                                }

                                const packagingVol =
                                    Number(
                                        (
                                            value *
                                            24 *
                                            0.33
                                        ).toFixed(2)
                                    );

                                const packagingLoss =
                                    calcValues
                                        .calcPacagingVol
                                        .packagingLoss;

                                updateField(
                                    "calcPacagingVol",
                                    "boxes",
                                    value
                                );

                                updateField(
                                    "calcPacagingVol",
                                    "packagingVol",
                                    packagingVol
                                );

                                if (packagingLoss === "" || packagingLoss === 100) {
                                    updateField(
                                        "calcPacagingVol",
                                        "tankVol",
                                        ""
                                    );
                                    return;
                                }

                                const tankVol =
                                    Number(
                                        (
                                            packagingVol /
                                            (
                                                1 -
                                                packagingLoss / 100
                                            )
                                        ).toFixed(2)
                                    );

                                updateField(
                                    "calcPacagingVol",
                                    "tankVol",
                                    tankVol
                                );
                            }}
                        />

                    </div>

                    <div className="calc-result">
                        {calcValues.calcPacagingVol.packagingVol !== "" ? (
                            <>
                                כמות ארגזים:{" "}
                                <strong>
                                    {getPackagingVolumes(
                                        calcValues.calcPacagingVol.packagingVol
                                    ).boxes.toFixed(1)}
                                </strong>

                                {", "}קומות בקבוקים ריקים:{" "}
                                <strong>
                                    {getPackagingVolumes(
                                        calcValues.calcPacagingVol.packagingVol
                                    ).emptyBottleRows.toFixed(1)}
                                </strong>

                                {", "}קומות בקבוקים מלאים:{" "}
                                <strong>
                                    {getPackagingVolumes(
                                        calcValues.calcPacagingVol.packagingVol
                                    ).fullBottleRows.toFixed(1)}
                                </strong>

                                {", "}חביות:{" "}
                                <strong>
                                    {getPackagingVolumes(
                                        calcValues.calcPacagingVol.packagingVol
                                    ).kegs.toFixed(1)}
                                </strong>
                            </>
                        ) : (
                            <strong>חסר נתון</strong>
                        )}

                        {", "}נותר לארוז:{" "}
                        <strong>
                            {calcValues.calcPacagingVol.leftToPack.toFixed(1)}
                        </strong>{" "}
                        {calcValues.calcPacagingVol.leftToPackLabel}
                    </div>

                </section>

            </div>

        </div>
    );
}


type NumberFieldProps = {
    label: string;
    value: OptionalNumber;
    onChange: (value: OptionalNumber) => void;
};

function NumberField({
    label,
    value,
    onChange,
}: NumberFieldProps) {
    return (
        <label className="spec-field">

            <span className="spec-field-label">
                {label}
            </span>

            <input
                className="spec-input"
                type="number"
                step="any"
                value={value}
                onChange={(e) => {
                    const rawValue = e.target.value;

                    onChange(
                        rawValue === ""
                            ? ""
                            : Number(rawValue)
                    );
                }}
            />

        </label>
    );
}

