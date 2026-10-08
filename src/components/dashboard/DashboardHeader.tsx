import { ArrowDown, ArrowUp } from "lucide-react";
import type {
    Dispatch,
    SetStateAction
} from "react";

type StatusCounts = Record<string, number>;

export type DashboardProps = {
    statusCounts: StatusCounts;
    setSelectedStatuses:
    Dispatch<SetStateAction<string[]>>;
    selectedStatuses: string[];
    totalTanks: number;
    statuses: string[];

    sortByAge: "tank" | "oldest" | "newest";
    setSortByAge:
    Dispatch<SetStateAction<"tank" | "oldest" | "newest">>;
};

export default function DashboardHeader({
    statusCounts,
    setSelectedStatuses,
    selectedStatuses,
    totalTanks,
    statuses,
    sortByAge,
    setSortByAge
}: DashboardProps) {

    const handleStatusToggle = (
        status: string
    ): void => {
        if (status === "הכל") {
            setSelectedStatuses(["הכל"]);
            return;
        }

        setSelectedStatuses((prev) => {
            let nextState =
                prev.includes("הכל")
                    ? []
                    : [...prev];

            if (
                nextState.includes(status)
            ) {
                nextState =
                    nextState.filter(
                        (s) => s !== status
                    );
            } else {
                nextState.push(status);
            }

            return nextState.length === 0
                ? ["הכל"]
                : nextState;
        });
    };

    return (
        <>
            <div className="status-filter">

                <button
                    type="button"
                    className={`status-filter-button ${selectedStatuses.includes(
                        "הכל"
                    )
                        ? "active"
                        : ""
                        }`}
                    onClick={() =>
                        handleStatusToggle(
                            "הכל"
                        )
                    }
                >

                    <span>
                        הכל
                    </span>

                    <span className="status-filter-count">
                        {totalTanks}
                    </span>

                </button>


                {statuses.map(
                    (status) => (

                        <button
                            key={status}
                            type="button"
                            className={`status-filter-button ${selectedStatuses.includes(
                                status
                            )
                                ? "active"
                                : ""
                                }`}
                            onClick={() =>
                                handleStatusToggle(
                                    status
                                )
                            }
                        >

                            <span>
                                {status}
                            </span>

                            <span className="status-filter-count">
                                {
                                    statusCounts[
                                    status
                                    ]
                                }
                            </span>

                        </button>

                    )
                )}

            </div>
            <div className="sort-filter">
                <div>מיין לפי:</div>
                <button
                    type="button"
                    className={`status-filter-button ${sortByAge === "tank"
                            ? "active"
                            : ""
                        }`}
                    onClick={() =>
                        setSortByAge("tank")
                    }
                >
                    סדר מיכלים
                </button>

                <button
                    type="button"
                    className={`status-filter-button ${sortByAge !== "tank"
                            ? "active"
                            : ""
                        }`}
                    onClick={() =>
                        setSortByAge((previous) => previous === "oldest" ? "newest" : "oldest")
                    }
                >
                    גיל בירה {sortByAge === "newest" ? <ArrowUp size={16} aria-hidden="true" /> : <ArrowDown size={16} aria-hidden="true" />}
                </button>

            </div></>
    )
}