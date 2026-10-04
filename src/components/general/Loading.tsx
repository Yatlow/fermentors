import { useId, type CSSProperties } from "react";
import "./beer-loader.css";

type BeerLoaderProps = {
    message?: string;
    size?: "small" | "medium" | "large" | "spinner";
    overlay?: boolean;
};

const wave = (y: number, amp: number) => {
    let d = `M0 ${y} Q8 ${y - amp} 16 ${y}`;
    for (let x = 32; x <= 128; x += 16) d += ` T${x} ${y}`;
    return `${d} V100 H0 Z`;
};

const FOAM_WAVE = wave(15, 4);
const BACK_WAVE = wave(24, 5);
const FRONT_WAVE = wave(26, 5);
const GLASS_CLOSED = "M10 14 L16 84 Q16.5 88 21 88 H43 Q47.5 88 48 84 L54 14 Z";
const GLASS_OPEN = "M10 14 L16 84 Q16.5 88 21 88 H43 Q47.5 88 48 84 L54 14";
const CROWN = "M11 16 C8 10 14 6 19 8 C22 2 31 3 33 7 C37 2 46 4 47 9 C53 8 56 13 53 16 Z";
const PETAL = "M-4.5 1.5 Q-4.5 0 -3 0 H3 Q4.5 0 4.5 1.5 C5.5 6 2 9.5 0 10.5 C-2 9.5 -5.5 6 -4.5 1.5 Z";
const HOP_ROWS = [
    { y: 34, xs: [18] },
    { y: 27.5, xs: [13.8, 22.2] },
    { y: 21, xs: [9.5, 18, 26.5] },
    { y: 14.5, xs: [13.8, 22.2] },
    { y: 8, xs: [18] },
];

export default function BeerLoader({
    message = "רק רגע…",
    size = "medium",
    overlay = false,
}: BeerLoaderProps) {
    const clipId = `beer-clip-${useId().replace(/:/g, "")}`;

    const content = (
        <div className={`beer-loader beer-loader-${size}`} dir="rtl" role="status" aria-live="polite">
            {size === "spinner" ? (
                <svg className="beer-spinner" viewBox="0 0 36 50" aria-hidden="true">
                    <g className="beer-hop">
                        <path className="beer-hop-stem" d="M18 8 V2" />
                        <path className="beer-hop-leaf" d="M18 4.5 C20 0.5 26 0.5 28 2.5 C25.5 5.5 20.5 6 18 4.5 Z" />
                        {HOP_ROWS.map((row, i) => (
                            <g key={i} style={{ "--i": i } as CSSProperties}>
                                {row.xs.map((x) => (
                                    <path key={x} className="beer-hop-petal" d={PETAL} transform={`translate(${x} ${row.y})`} />
                                ))}
                            </g>
                        ))}
                    </g>
                </svg>
            ) : (
                <svg className="beer-pint" viewBox="0 0 64 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs><clipPath id={clipId}><path d={GLASS_CLOSED} /></clipPath></defs>
                    <ellipse className="beer-pint-shadow" cx="32" cy="91" rx="20" ry="2.5" />
                    <path className="beer-pint-glass" d={GLASS_CLOSED} />
                    <g clipPath={`url(#${clipId})`}>
                        <g className="beer-pint-level">
                            <rect className="beer-pint-foam-fill" x="8" y="14" width="48" height="8" />
                            <path className="beer-pint-wave-foam" d={FOAM_WAVE} />
                            <path className="beer-pint-wave-back" d={BACK_WAVE} />
                            <path className="beer-pint-wave-front" d={FRONT_WAVE} />
                            <circle className="beer-pint-bubble bp1" cx="22" cy="80" r="1.6" />
                            <circle className="beer-pint-bubble bp2" cx="31" cy="82" r="1.2" />
                            <circle className="beer-pint-bubble bp3" cx="40" cy="80" r="1.8" />
                            <circle className="beer-pint-bubble bp4" cx="27" cy="84" r="1" />
                        </g>
                    </g>
                    <path className="beer-pint-crown" d={CROWN} />
                    <path className="beer-pint-outline" d={GLASS_OPEN} />
                    <path className="beer-pint-shine" d="M15 26 L19.5 74" />
                </svg>
            )}
            {message && <div className="beer-loader-message">{message}</div>}
        </div>
    );

    if (!overlay) return content;
    return <div className="beer-loader-overlay">{content}</div>;
}
