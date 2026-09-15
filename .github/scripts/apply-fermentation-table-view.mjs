import fs from "node:fs";

const path = "src/components/dashboard/Batchhistorychart.tsx";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Could not find ${label}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
  'import type { Fermentor } from "../../App";\n',
  'import type { Fermentor } from "../../App";\nimport FermentationTable from "./FermentationTable";\n',
  "Fermentor import"
);

replaceOnce(
  'type ViewMode = "tabs" | "combined";',
  'type ViewMode = "table" | "tabs" | "combined";',
  "ViewMode type"
);

replaceOnce(
  'const [viewMode, setViewMode] = useState<ViewMode>("combined");',
  'const [viewMode, setViewMode] = useState<ViewMode>("table");',
  "default view mode"
);

replaceOnce(
`    function toggleCombined() {
        setViewMode((v) => (v === "combined" ? "tabs" : "combined"));
    }
`,
`    function showTable() {
        setViewMode("table");
    }

    function toggleCombined() {
        setViewMode("combined");
    }
`,
  "combined toggle"
);

const oldTabs = `                        <div className="chart-metric-tabs">
                            {METRICS.map((metric) => (
                                <button
                                    key={metric.key}
                                    type="button"
                                    className={\`chart-metric-tab \${viewMode === "tabs" && activeMetric === metric.key ? "active" : ""
                                        }\`}
                                    onClick={() => selectMetric(metric.key)}
                                >
                                    {metric.label}
                                </button>
                            ))}
                            <button
                                type="button"
                                className={\`chart-metric-tab \${viewMode === "tabs" && activeMetric === "yeast" ? "active" : ""
                                    }\`}
                                onClick={() => selectMetric("yeast")}
                            >
                                שמרים
                            </button>
                            <button
                                type="button"
                                className={\`chart-metric-tab \${viewMode === "combined" ? "active" : ""}\`}
                                onClick={toggleCombined}
                            >
                                הכל ביחד
                            </button>
                        </div>
`;

const newTabs = `                        <div className="chart-metric-tabs">
                            <button
                                type="button"
                                className={\`chart-metric-tab \${viewMode === "table" ? "active" : ""}\`}
                                onClick={showTable}
                            >
                                טבלת תסיסה
                            </button>
                            <button
                                type="button"
                                className={\`chart-metric-tab \${viewMode === "combined" ? "active" : ""}\`}
                                onClick={toggleCombined}
                            >
                                הכל ביחד
                            </button>
                            <button
                                type="button"
                                className={\`chart-metric-tab \${viewMode === "tabs" && activeMetric === "plato" ? "active" : ""}\`}
                                onClick={() => selectMetric("plato")}
                            >
                                סוכר
                            </button>
                            <button
                                type="button"
                                className={\`chart-metric-tab \${viewMode === "tabs" && activeMetric === "yeast" ? "active" : ""}\`}
                                onClick={() => selectMetric("yeast")}
                            >
                                שמרים
                            </button>
                            {METRICS.filter((metric) => metric.key !== "plato").map((metric) => (
                                <button
                                    key={metric.key}
                                    type="button"
                                    className={\`chart-metric-tab \${viewMode === "tabs" && activeMetric === metric.key ? "active" : ""
                                        }\`}
                                    onClick={() => selectMetric(metric.key)}
                                >
                                    {metric.label}
                                </button>
                            ))}
                        </div>

                        <div className={\`metric-chart-block \${viewMode === "table" ? "active" : ""}\`}>
                            <FermentationTable measurements={measurements} />
                        </div>
`;

replaceOnce(oldTabs, newTabs, "metric tabs block");

replaceOnce(
  '                        {totalBuckets > 0 && (',
  '                        {viewMode !== "table" && totalBuckets > 0 && (',
  "yeast summary visibility"
);

fs.writeFileSync(path, source);
console.log("Updated", path);
